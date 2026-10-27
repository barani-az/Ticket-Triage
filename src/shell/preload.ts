import { contextBridge, ipcRenderer } from 'electron';

/** The only surface the chat page gets: send a message, read status, hide the window. */
contextBridge.exposeInMainWorld('api', {
  send: (msg: unknown) => ipcRenderer.invoke('assistant:message', msg),
  connections: () => ipcRenderer.invoke('assistant:connections'),
  audit: () => ipcRenderer.invoke('assistant:audit'),
  hide: () => ipcRenderer.send('assistant:hide'),
  resize: (height: number) => ipcRenderer.send('assistant:resize', height),
  onFocus: (cb: () => void) => ipcRenderer.on('assistant:focus', () => cb()),
});
