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
