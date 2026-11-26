import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, screen, shell, Tray } from 'electron';
import type { UiToCore } from '../core/session.js';
import { createApp, type App } from '../server/app.js';
import { recordDemo } from './demo.js';
import { parseEnv } from './env.js';
import { registerHotkey } from './hotkey.js';

/**
 * Tray app: a global hotkey opens a small chat window; typing a request creates the ticket
 * (asking only for what is missing). The core runs in this process for now; the plan moves it
 * into a utility process.
 */
// "Glass" = the window sits on Windows acrylic (Windows 11 build 22621+). Otherwise it falls back to a
// transparent window with a CSS shadow, which needs 16px of padding around the page.
const GLASS = process.platform === 'win32' && Number(process.getSystemVersion().split('.')[2]) >= 22621 && process.env.NO_GLASS !== '1';
const PAD = GLASS ? 0 : 16;
const WIDTH = 668 + 2 * PAD;
const MIN_HEIGHT = (GLASS ? 60 : 62) + 2 * PAD; // just the input bar (plus its hairline when there is no glass)
const MAX_HEIGHT = 700;
const HOTKEYS = [process.env.HOTKEY, 'Control+Shift+Space', 'Control+Alt+Space', 'Control+Alt+J'].filter(Boolean) as string[];
const SMOKE = process.env.SMOKE === '1';
const DEMO = process.env.DEMO === '1';
const DEMO_HEIGHT = 600; // fixed while recording, so every captured frame is the same size

const dataDir = app.isPackaged ? app.getPath('userData') : path.join(app.getAppPath(), 'data');
fs.mkdirSync(dataDir, { recursive: true });

// ---- settings: only what the tray menu can change ----
const settingsFile = path.join(dataDir, 'settings.json');
const settings: { autoCreate: boolean } = { autoCreate: true, ...readJson(settingsFile) };
function readJson(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}
const saveSettings = () => fs.writeFileSync(settingsFile, JSON.stringify(settings));

// ---- secrets stay in a git-ignored .env, never in the repo or on a command line ----
function loadEnv(): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const dir of [app.getAppPath(), dataDir]) {
    try {
      Object.assign(merged, parseEnv(fs.readFileSync(path.join(dir, '.env'), 'utf8')));
    } catch {
      /* no .env here */
    }
  }
  return merged;
}

let core: App | undefined;
let win: BrowserWindow | undefined;
let tray: Tray | undefined;
let hotkeyLabel = 'not registered';

function createWindow() {
  win = new BrowserWindow({
    width: WIDTH,
    height: MIN_HEIGHT,
    useContentSize: true,
    show: false,
    frame: false,
    // Glass: Windows draws the blur, corners and shadow. Otherwise the page draws its own corners and shadow.
    transparent: !GLASS,
    hasShadow: GLASS,
    ...(GLASS ? { backgroundMaterial: 'acrylic' as const, backgroundColor: '#00000000', roundedCorners: true } : {}),
    resizable: GLASS, // the native shadow and corners need a resizable frame; user resizing is blocked below
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.on('will-resize', (e) => e.preventDefault()); // only the page decides the height
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { glass: GLASS ? '1' : '0' } });
  // Links (e.g. the created issue) open in the default browser; the app window never navigates.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('blur', () => {
    if (!SMOKE && win && !win.webContents.isDevToolsOpened()) win.hide();
  });
  return win;
}

// How tall the window may grow: down to a small margin above the bottom of the work area (the taskbar).
let availableHeight = MAX_HEIGHT;

function placeWindow() {
  if (!win) return;
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const y = workArea.y + Math.round(workArea.height * 0.12);
  win.setPosition(workArea.x + Math.round((workArea.width - WIDTH) / 2), y);
  availableHeight = Math.max(MIN_HEIGHT, workArea.y + workArea.height - y - 12);
  win.webContents.send('assistant:avail', Math.min(MAX_HEIGHT, availableHeight));
}

function showWindow() {
  if (!win) return;
  placeWindow();
  win.show();
  win.focus();
  win.webContents.send('assistant:focus');
}

function toggleWindow() {
  if (win?.isVisible() && win.isFocused()) win.hide();
  else showWindow();
}

function trayIcon() {
  // 16x16 solid accent square with a lighter centre, drawn as a raw BGRA bitmap (no asset file needed).
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inner = x > 3 && x < 12 && y > 3 && y < 12;
      const [b, g, r] = inner ? [255, 230, 200] : [235, 99, 37];
      buf.set([b, g, r, 255], (y * size + x) * 4);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function buildTray() {
  tray = new Tray(trayIcon());
  const refresh = () => {
    const hasRovo = core?.connections.some((c) => c.id === 'rovo');
    tray!.setToolTip(`AI Task Assistant (${hotkeyLabel})`);
    tray!.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Open assistant  (${hotkeyLabel})`, click: showWindow },
        {
          label: 'Create tickets without asking',
          type: 'checkbox',
          checked: settings.autoCreate,
          click: (item) => {
            settings.autoCreate = item.checked;
            saveSettings();
          },
        },
        ...(hasRovo
          ? []
          : [
              {
                label: 'Connect Atlassian Rovo…',
                click: async () => {
                  try {
                    await core!.addRovo();
                    tray!.displayBalloon({ title: 'Atlassian Rovo', content: 'Connected.' });
                  } catch (e) {
                    tray!.displayBalloon({ title: 'Atlassian Rovo', content: `Could not connect: ${(e as Error).message}` });
                  }
                  refresh();
                },
              },
            ]),
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
      ]),
    );
  };
  tray.on('click', toggleWindow);
  refresh();
}

/**
 * One screenshot of the display the window is on, as a JPEG data URL no wider than 1600px. Only the
 * "Take a screenshot" button calls this, after the assistant has asked and the user has said yes.
 * Nothing is written to disk; the image lives in memory until it is sent or discarded.
 */
async function captureScreen(): Promise<string | null> {
  if (!win) return null;
  const display = screen.getDisplayMatching(win.getBounds());
  const wasVisible = win.isVisible();
  win.hide(); // the assistant must not appear in its own screenshot
  await new Promise((r) => setTimeout(r, 300)); // let the screen repaint without the window
  try {
    const f = display.scaleFactor;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(display.size.width * f), height: Math.round(display.size.height * f) },
    });
    const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    if (!src) return null;
    const img = src.thumbnail.getSize().width > 1600 ? src.thumbnail.resize({ width: 1600, quality: 'good' }) : src.thumbnail;
    return `data:image/jpeg;base64,${img.toJPEG(80).toString('base64')}`;
  } catch {
    return null;
  } finally {
    if (wasVisible) showWindow();
  }
}

function wireIpc() {
  ipcMain.handle('assistant:capture', () => captureScreen());
  const allowed = new Set(['submit', 'answer', 'stop', 'confirm', 'cancel', 'fallback', 'new']);
  ipcMain.handle('assistant:message', async (_e, msg: UiToCore) => {
    if (!msg || typeof msg !== 'object' || !allowed.has(msg.type)) return [{ type: 'error', message: 'Unknown message.' }];
    return core!.session.handle(msg);
  });
  ipcMain.handle('assistant:connections', () => core!.describe());
  ipcMain.handle('assistant:audit', () => core!.audit.list());
  ipcMain.on('assistant:hide', () => win?.hide());
  // The page reports how tall it is; the window grows or shrinks to match, anchored at the top.
  ipcMain.on('assistant:resize', (_e, height: unknown) => {
    if (!win || DEMO || typeof height !== 'number' || !Number.isFinite(height)) return;
    const max = Math.min(MAX_HEIGHT, availableHeight);
    win.setContentSize(WIDTH, Math.round(Math.max(MIN_HEIGHT, Math.min(height, max))));
  });
}

async function smokeTest() {
  const out: Record<string, unknown> = { hotkey: hotkeyLabel, dataDir };
  await new Promise<void>((resolve) => win!.webContents.once('did-finish-load', () => resolve()));
  const run = (js: string) => win!.webContents.executeJavaScript(js);
  out.apiExposed = await run('typeof window.api');
  const described = (await run('window.api.connections()')) as { connections: { name: string; status: unknown }[]; llm: boolean; autoCreate: boolean; examples: string[] };
  out.connections = described.connections.map((c) => `${c.name}: ${JSON.stringify(c.status)}`);
  out.llm = described.llm;
  out.autoCreate = described.autoCreate;
  out.examples = described.examples;
  out.pageTitle = await run('document.title');

  // Drive the real UI. Writes are impossible here: auto-create is forced off and nothing is confirmed.
  // States that need a real write (a created ticket) are drawn from fixed messages, never sent to a tool.
  settings.autoCreate = false;
  placeWindow(); // where it opens for real, so the screen-fit logic is exercised too
  win!.showInactive(); // a hidden window cannot be captured
  const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Acrylic is composed by Windows, so it is missing from a page capture. Crop the real screen to the
  // window (plus a margin for its shadow) instead; only that crop is saved, never the whole screen.
  const shot = async (name: string) => {
    await wait(450); // let the window finish resizing and animating
    let png: Buffer;
    try {
      const b = win!.getBounds();
      const d = screen.getDisplayMatching(b);
      const f = d.scaleFactor;
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(d.size.width * f), height: Math.round(d.size.height * f) } });
      const src = sources.find((s) => s.display_id === String(d.id)) ?? sources[0];
      const full = src.thumbnail.getSize();
      const m = PAD; // exactly the window: nothing of the desktop around it is kept
      const x = Math.max(0, Math.round((b.x - d.bounds.x + m) * f));
      const y = Math.max(0, Math.round((b.y - d.bounds.y + m) * f));
      const w = Math.min(full.width - x, Math.round((b.width - 2 * m) * f));
      const h = Math.min(full.height - y, Math.round((b.height - 2 * m) * f));
      png = src.thumbnail.crop({ x, y, width: w, height: h }).toPNG();
    } catch {
      png = (await win!.webContents.capturePage()).toPNG();
    }
    fs.writeFileSync(path.join(dataDir, `smoke-${theme}-${name}.png`), png);
  };
  const submit = async (text: string) => {
    await run(`(() => { const i = document.getElementById('input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await wait(300);
    for (let i = 0; i < 80 && !(await run(`!document.getElementById('out').hidden && !shell.classList.contains('busy')`)); i++) await wait(500);
  };
  const sizes = async () => ({ window: win!.getContentSize(), shell: await run(`Math.round(document.getElementById('shell').getBoundingClientRect().height)`) });

  out.theme = theme;
  await wait(600);
  out.idle = await sizes();
  await shot('1-idle');

  await run('showSuggestions()');
  await wait(900);
  out.suggestions = await sizes();
  await shot('2-suggestions');

  await run('reset()');
  await submit('create a bug in WEB for login crash');
  out.question = { ...(await sizes()), shown: await run(`document.getElementById('out').innerText`) };
  await shot('3-question');

  await run('reset()');
  await submit('create a story in WEB for docs page');
  out.card = { ...(await sizes()), shown: await run(`document.getElementById('out').innerText`) };
  await shot('4-card');

  await run(`reset(); render({ type: 'card', canConfirm: true, unresolved: [], options: [], errors: [], card: { title: 'Create issue', connectionName: 'Atlassian Rovo (live)', rows: [{ field: 'project', title: 'Project', value: 'My Software Team', assumed: false }, { field: 'issuetype', title: 'Issue type', value: 'Task', assumed: false }, { field: 'summary', title: 'Summary', value: 'Update the onboarding checklist', assumed: false }, { field: 'priority', title: 'Priority', value: 'Medium', assumed: true }], warnings: ['This creates a real issue on https://example.atlassian.net.'] } })`);
  await shot('5-live-card');

  await run(`reset(); render({ type: 'result', ok: true, text: 'Created KAN-12', url: 'https://example.invalid/browse/KAN-12' })`);
  await shot('6-done');

  await run(`reset(); shell.classList.add('busy'); document.getElementById('input').value = 'login page crashes on safari';`);
  await shot('7-working');

  await run(`reset(); shell.classList.remove('busy'); document.getElementById('input').value = ''; render({ type: 'assistant', text: 'I drafted a bug ticket for the Safari login crashes, set to High priority because customers are affected. The draft is below.', reasoning: 'Customers are blocked from logging in, which makes it a high-priority bug.', suggestions: ['Add Safari version details', 'Assign to the frontend team'] })`);
  await shot('8-assistant');

  // The screenshot flow: the permission question, then the chip. Drawn from fixed messages; nothing is captured.
  await run(`reset(); render({ type: 'assistant', text: 'Can I take a screenshot of your screen to see the error?', action: 'screenshot' })`);
  await shot('9-ask-screenshot');
  await run(`reset(); (() => { const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="88" height="52"><rect width="88" height="52" fill="#f3f4f6"/><rect width="88" height="7" fill="#1f2937"/><rect x="10" y="16" width="52" height="7" fill="#b91c1c"/><rect x="10" y="28" width="66" height="5" fill="#d1d5db"/><rect x="10" y="38" width="40" height="8" fill="#fecaca"/></svg>'; setImages(['data:image/svg+xml,' + encodeURIComponent(svg)]); document.getElementById('input').value = 'there is an error on this page'; hint(); add(el('div', { class: 'meta', text: 'Screenshot added. It goes to Gemini only when you press Enter. Add a note first if you like, or remove it with the x.' })); })()`);
  await shot('10-attached');

  // History: through the typed command, so the real key handling is exercised.
  await run(`reset(); setImages([]); (() => { const i = document.getElementById('input'); i.value = 'history'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await wait(900);
  out.history = { window: win!.getContentSize(), rows: await run(`document.querySelectorAll('#out .opt').length`), open: await run('histOpen') };
  await shot('11-history');

  // A conversation thread, drawn from fixed messages (no model, no writes).
  await run(`reset(); (() => {
    echo('there is an error on this page');
    render({ type: 'assistant', text: 'I drafted a High priority bug: checkout payment fails with a 500 error (ERR-7731). What payment method were you using?' });
    echo('make it highest priority');
    render({ type: 'assistant', text: 'Done, it is now Highest priority.' });
    render({ type: 'card', canConfirm: true, unresolved: [], options: [], errors: [], card: { title: 'Create issue', connectionName: 'Company Jira', rows: [{ field: 'project', title: 'Project', value: 'Website', assumed: false }, { field: 'summary', title: 'Summary', value: '500 error on payment page (ERR-7731)', assumed: false }, { field: 'priority', title: 'Priority', value: 'Highest', assumed: false }], warnings: [] } });
  })()`);
  await shot('12-chat');
  console.log('SMOKE ' + JSON.stringify(out, null, 2));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('window-all-closed', () => {
    /* tray app: keep running */
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());

  app.whenReady().then(async () => {
    if (SMOKE) settings.autoCreate = false;
    if (process.env.SMOKE_THEME === 'light' || process.env.SMOKE_THEME === 'dark') nativeTheme.themeSource = process.env.SMOKE_THEME;
    core = await createApp(loadEnv(), { dataDir, autoCreate: () => settings.autoCreate });
    wireIpc();
    createWindow();

    const hk = registerHotkey(globalShortcut, HOTKEYS, toggleWindow);
    hotkeyLabel = hk.ok ? hk.accelerator.replace('Control', 'Ctrl') : 'no hotkey (all combinations taken)';

    buildTray();
    console.log(`Hotkey: ${hotkeyLabel}  |  LLM: ${core.llmEnabled ? 'on' : 'built-in rules'}  |  Create without asking: ${settings.autoCreate}`);
    if (core.rovoError) console.log(`Rovo skipped: ${core.rovoError}`);

    if (SMOKE) {
      await smokeTest();
      await core.close();
      app.exit(0);
    } else if (DEMO) {
      settings.autoCreate = false; // the demo is about the confirmation card
      await new Promise<void>((r) => win!.webContents.once('did-finish-load', () => r()));
      win!.setContentSize(WIDTH, DEMO_HEIGHT);
      win!.showInactive();
      const demo = await recordDemo(win!, path.join(dataDir, 'frames'), JSON.parse(process.env.DEMO_SCRIPT!));
      console.log(`DEMO ${demo.frames} frames, created: ${demo.created.join(', ') || 'nothing'}`);
      await core.close();
      app.exit(0);
    } else if (!hk.ok) {
      showWindow();
    }
  });
}
