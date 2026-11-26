import { contextBridge, ipcRenderer } from 'electron';

/** The only surface the chat page gets: send a message, read status, hide the window. */
contextBridge.exposeInMainWorld('api', {
  send: (msg: unknown) => ipcRenderer.invoke('assistant:message', msg),
  connections: () => ipcRenderer.invoke('assistant:connections'),
  audit: () => ipcRenderer.invoke('assistant:audit'),
  hide: () => ipcRenderer.send('assistant:hide'),
  /** Take one screenshot of the screen the window is on. Only called after the user presses "Take a screenshot". */
  capture: (): Promise<string | null> => ipcRenderer.invoke('assistant:capture'),
  resize: (height: number) => ipcRenderer.send('assistant:resize', height),
  onFocus: (cb: () => void) => ipcRenderer.on('assistant:focus', () => cb()),
  onAvail: (cb: (height: number) => void) => ipcRenderer.on('assistant:avail', (_e, h: number) => cb(h)),
});
