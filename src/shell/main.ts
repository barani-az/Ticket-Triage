import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron';
import type { UiToCore } from '../core/session.js';
import { createApp, type App } from '../server/app.js';
import { parseEnv } from './env.js';
import { registerHotkey } from './hotkey.js';

/**
 * Tray app: a global hotkey opens a small chat window; typing a request creates the ticket
 * (asking only for what is missing). The core runs in this process for now; the plan moves it
 * into a utility process.
 */
const WIDTH = 680;
const MIN_HEIGHT = 84; // just the input bar plus room for its shadow
const MAX_HEIGHT = 640;
const HOTKEYS = [process.env.HOTKEY, 'Control+Shift+Space', 'Control+Alt+Space', 'Control+Alt+J'].filter(Boolean) as string[];
const SMOKE = process.env.SMOKE === '1';

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
    transparent: true, // the page draws its own rounded corners and shadow
    hasShadow: false,
    resizable: false,
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
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
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

function showWindow() {
  if (!win) return;
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  win.setPosition(workArea.x + Math.round((workArea.width - WIDTH) / 2), workArea.y + Math.round(workArea.height * 0.12));
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

function wireIpc() {
  const allowed = new Set(['submit', 'answer', 'stop', 'confirm', 'cancel', 'fallback']);
  ipcMain.handle('assistant:message', async (_e, msg: UiToCore) => {
    if (!msg || typeof msg !== 'object' || !allowed.has(msg.type)) return [{ type: 'error', message: 'Unknown message.' }];
    return core!.session.handle(msg);
  });
  ipcMain.handle('assistant:connections', () => core!.describe());
  ipcMain.handle('assistant:audit', () => core!.audit.list());
  ipcMain.on('assistant:hide', () => win?.hide());
  // The page reports how tall it is; the window grows or shrinks to match, anchored at the top.
  ipcMain.on('assistant:resize', (_e, height: unknown) => {
    if (!win || typeof height !== 'number' || !Number.isFinite(height)) return;
    const { workArea } = screen.getDisplayMatching(win.getBounds());
    const max = Math.min(MAX_HEIGHT, workArea.height - 40);
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
  settings.autoCreate = false;
  win!.showInactive(); // a hidden window cannot be captured
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name: string) => {
    const img = await win!.webContents.capturePage();
    fs.writeFileSync(path.join(dataDir, `smoke-${name}.png`), img.toPNG());
  };
  await wait(600);
  out.initial = { windowContent: win!.getContentSize(), shellHeight: await run(`document.getElementById('shell').getBoundingClientRect().height`) };
  await shot('1-initial');

  await run(`(() => { const i = document.getElementById('input'); i.value = 'create a story in WEB for smoke test'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  for (let i = 0; i < 80 && !(await run(`!document.getElementById('out').hidden && !document.getElementById('dot').classList.contains('busy')`)); i++) await wait(500);
  await wait(500);
  out.afterRequest = {
    windowContent: win!.getContentSize(),
    shellHeight: await run(`document.getElementById('shell').getBoundingClientRect().height`),
    shown: await run(`document.getElementById('out').innerText`),
  };
  await shot('2-expanded');
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
    } else if (!hk.ok) {
      showWindow();
    }
  });
}
