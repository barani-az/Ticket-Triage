import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/shell/env.js';
import { defaultHotkeys, hotkeyLabel, registerHotkey, type ShortcutApi } from '../src/shell/hotkey.js';

const fakeApi = (taken: string[]): ShortcutApi & { registered: string[] } => {
  const registered: string[] = [];
  return {
    registered,
    register: (a) => {
      if (a === 'bad') throw new Error('invalid accelerator');
      if (taken.includes(a)) return false;
      registered.push(a);
      return true;
    },
    unregister: () => undefined,
  };
};

describe('registerHotkey', () => {
  it('uses the first accelerator when it is free', () => {
    const api = fakeApi([]);
    expect(registerHotkey(api, ['Ctrl+Shift+Space', 'Ctrl+Alt+Space'], () => undefined)).toEqual({ ok: true, accelerator: 'Ctrl+Shift+Space' });
  });

  it('falls back when another app owns the first combination', () => {
    const api = fakeApi(['Ctrl+Shift+Space']);
    expect(registerHotkey(api, ['Ctrl+Shift+Space', 'Ctrl+Alt+Space'], () => undefined)).toEqual({ ok: true, accelerator: 'Ctrl+Alt+Space' });
  });

  it('skips an invalid accelerator instead of throwing', () => {
    expect(registerHotkey(fakeApi([]), ['bad', 'Ctrl+Alt+Space'], () => undefined)).toMatchObject({ ok: true, accelerator: 'Ctrl+Alt+Space' });
  });

  it('reports what it tried when nothing works', () => {
    expect(registerHotkey(fakeApi(['a', 'b']), ['a', 'b'], () => undefined)).toEqual({ ok: false, tried: ['a', 'b'] });
  });
});

describe('hotkeys per platform', () => {
  it('uses Option+Space on a Mac and Ctrl+Shift+Space on Windows, with HOTKEY from .env first', () => {
    expect(defaultHotkeys('darwin')[0]).toBe('Alt+Space');
    expect(defaultHotkeys('win32')[0]).toBe('Control+Shift+Space');
    expect(defaultHotkeys('darwin', 'Command+J')[0]).toBe('Command+J');
  });

  it('writes them the way each platform does', () => {
    expect(hotkeyLabel('Alt+Space', 'darwin')).toBe('⌥Space');
    expect(hotkeyLabel('Command+Shift+Space', 'darwin')).toBe('⌘⇧Space');
    expect(hotkeyLabel('Control+Shift+Space', 'win32')).toBe('Ctrl+Shift+Space');
  });
});

describe('parseEnv', () => {
  it('reads keys, ignores comments and blanks, and strips quotes', () => {
    expect(parseEnv('# note\nGEMINI_API_KEY="abc"\n\nGEMINI_MODEL=gemini-3.8-flash\nEMPTY=\n')).toEqual({
      GEMINI_API_KEY: 'abc',
      GEMINI_MODEL: 'gemini-3.8-flash',
    });
  });

  it('keeps = signs inside values', () => {
    expect(parseEnv('K=a=b=c')).toEqual({ K: 'a=b=c' });
  });
});
