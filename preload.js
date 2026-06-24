const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 드래그&드롭 파일 경로 (Electron 32+ 에서 File.path 제거됨 → webUtils 사용)
  getPathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  openImage: () => ipcRenderer.invoke('dialog:openImage'),
  onCtxFormat: (cb) => ipcRenderer.on('ctx-format', (_e, fmt) => cb(fmt)),
  onCtxClaude: (cb) => ipcRenderer.on('ctx-claude', (_e, text) => cb(text)),
  saveFileAs: (content, defaultPath) =>
    ipcRenderer.invoke('dialog:saveFile', { content, defaultPath }),
  readFile: (filePath) => ipcRenderer.invoke('fs:read', filePath),
  readHome: () => ipcRenderer.invoke('app:readHome'),
  writeFile: (filePath, content) =>
    ipcRenderer.invoke('fs:write', { filePath, content }),
  renameFile: (oldPath, newName) =>
    ipcRenderer.invoke('fs:rename', { oldPath, newName }),
  readTree: (root) => ipcRenderer.invoke('fs:tree', root),
  watchFolder: (root) => ipcRenderer.send('fs:watch', root),
  unwatchFolder: (root) => ipcRenderer.send('fs:unwatch', root),
  onVaultChanged: (cb) => ipcRenderer.on('vault-changed', (_e, root) => cb(root)),
  resolveWiki: (root, target) =>
    ipcRenderer.invoke('fs:resolveWiki', { root, target }),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  search: (opts) => ipcRenderer.invoke('fs:search', opts),
  replaceFiles: (opts) => ipcRenderer.invoke('fs:replaceFiles', opts),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  renderHtmlTemp: (content, baseDir) => ipcRenderer.invoke('html:renderTemp', { content, baseDir }),
  askClaude: (opts) => ipcRenderer.invoke('claude:ask', opts),
  cancelClaude: () => ipcRenderer.invoke('claude:cancel'),
  startClaudeStream: (opts) => ipcRenderer.send('claude:start', opts),
  cancelClaudeStream: (id) => ipcRenderer.send('claude:cancelStream', { id }),
  onClaudeStream: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('claude:stream', h);
    return () => ipcRenderer.removeListener('claude:stream', h);
  },
  // 창 컨트롤
  winMinimize: () => ipcRenderer.send('win:minimize'),
  winMaxToggle: () => ipcRenderer.send('win:maxtoggle'),
  winClose: () => ipcRenderer.send('win:close'),
  onWinMaximized: (cb) => ipcRenderer.on('win-maximized', (_e, v) => cb(v)),
  // 외부에서 파일 열기 (파일 연결 / 두 번째 인스턴스)
  onOpenFileExternal: (cb) => ipcRenderer.on('open-file-external', (_e, p) => cb(p))
});
