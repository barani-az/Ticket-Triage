export interface ShortcutApi {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export type HotkeyResult = { ok: true; accelerator: string } | { ok: false; tried: string[] };

/**
 * Register the first accelerator that works. Another app may already own a combination, in which
 * case register() returns false; try the next one so the app never silently loses its hotkey.
 */
export function registerHotkey(api: ShortcutApi, accelerators: string[], onPress: () => void): HotkeyResult {
  for (const accelerator of accelerators) {
    try {
      if (api.register(accelerator, onPress)) return { ok: true, accelerator };
    } catch {
      /* invalid accelerator string: try the next one */
    }
  }
  return { ok: false, tried: accelerators };
}

/**
 * The hotkeys to try, in order (HOTKEY in .env goes first). On a Mac, Option+Space like other Mac
 * launchers (Ctrl+Space switches the keyboard language there); on Windows, Ctrl+Shift+Space.
 */
export function defaultHotkeys(platform: NodeJS.Platform, custom?: string): string[] {
  const list = platform === 'darwin' ? ['Alt+Space', 'Command+Shift+Space', 'Control+Alt+Space'] : ['Control+Shift+Space', 'Control+Alt+Space', 'Control+Alt+J'];
  return custom ? [custom, ...list] : list;
}

const MAC_KEYS: Record<string, string> = { Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧', Command: '⌘', Cmd: '⌘', CommandOrControl: '⌘', CmdOrCtrl: '⌘' };

/** How a hotkey is written for people: ⌥Space on a Mac, Ctrl+Shift+Space on Windows. */
export function hotkeyLabel(accelerator: string, platform: NodeJS.Platform): string {
  if (platform !== 'darwin') return accelerator.replace('Control', 'Ctrl');
  return accelerator
    .split('+')
    .map((k) => MAC_KEYS[k] ?? k)
    .join('');
}
