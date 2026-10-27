import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/shell/env.js';
import { registerHotkey, type ShortcutApi } from '../src/shell/hotkey.js';

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
