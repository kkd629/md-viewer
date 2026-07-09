const { app, BrowserWindow, ipcMain, dialog, Menu, MenuItem, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');
const os = require('os');

let mainWindow;
const OPENABLE = ['.md', '.markdown', '.mdown', '.txt', '.json', '.html', '.htm'];

// argv 에서 열 파일 경로 추출 (파일 연결로 더블클릭 시 전달됨)
function extractFileArg(argv) {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('-')) continue;
    const ext = path.extname(a).toLowerCase();
    if (OPENABLE.includes(ext)) {
      try { if (fs.existsSync(a)) return path.resolve(a); } catch {}
    }
  }
  return null;
}

function sendOpenFile(file) {
  if (!file || !mainWindow) return;
  const deliver = () => mainWindow.webContents.send('open-file-external', file);
  if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', deliver);
  else deliver();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#1e1e1e',
    title: 'MD Viewer',
    frame: false,            // 프레임리스 — 커스텀 타이틀바 사용
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.env.MDV_DEVTOOLS) mainWindow.webContents.openDevTools({ mode: 'bottom' });
  // 렌더러 콘솔 경고/오류를 메인 stderr 로 전달 (디버깅용)
  mainWindow.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) console.error('[renderer]', message); // 3=error만
  });

  // 우클릭 컨텍스트 메뉴 (편집/선택 상태별 + 맞춤법 제안)
  mainWindow.webContents.on('context-menu', (_e, params) => {
    const menu = new Menu();
    const wc = mainWindow.webContents;
    if (params.misspelledWord) {
      (params.dictionarySuggestions || []).slice(0, 5).forEach(s =>
        menu.append(new MenuItem({ label: s, click: () => wc.replaceMisspelling(s) })));
      menu.append(new MenuItem({ label: '사전에 추가', click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) }));
      menu.append(new MenuItem({ type: 'separator' }));
    }
    const ef = params.editFlags || {};
    const fmt = (label, f) => menu.append(new MenuItem({ label, click: () => wc.send('ctx-format', f) }));
    const sep = () => menu.append(new MenuItem({ type: 'separator' }));
    if (params.isEditable) {
      menu.append(new MenuItem({ label: '잘라내기', role: 'cut', enabled: ef.canCut }));
      menu.append(new MenuItem({ label: '복사', role: 'copy', enabled: ef.canCopy }));
      menu.append(new MenuItem({ label: '붙여넣기', role: 'paste', enabled: ef.canPaste }));
      menu.append(new MenuItem({ label: '전체 선택', role: 'selectAll' }));
      if (params.selectionText) {
        // 드래그(선택)한 상태 → 선택 텍스트에 서식 적용
        sep();
        fmt('굵게 **', 'bold'); fmt('기울임 *', 'italic'); fmt('취소선 ~~', 'strike');
        fmt('인라인 코드 `', 'code'); fmt('링크', 'link');
        sep();
        fmt('인용 >', 'quote'); fmt('목록', 'ul'); fmt('체크박스 ☑', 'task');
        sep();
        menu.append(new MenuItem({ label: 'Claude에게 보내기', click: () => wc.send('ctx-claude', params.selectionText) }));
      } else {
        // 선택 없이 그냥 우클릭 → 삽입 도구
        sep();
        menu.append(new MenuItem({ label: '📅 오늘 날짜 삽입', click: () => wc.send('ctx-insert-date') }));
        fmt('▦ 표 삽입', 'table'); fmt('― 구분선 삽입', 'hr'); fmt('{ } 코드 블록', 'codeblock');
      }
    } else if (params.selectionText) {
      menu.append(new MenuItem({ label: '복사', role: 'copy' }));
      menu.append(new MenuItem({ label: 'Claude에게 보내기', click: () => wc.send('ctx-claude', params.selectionText) }));
    }
    if (menu.items.length) menu.popup();
  });

  // 최대화/복원 상태를 렌더러에 알림(타이틀바 버튼 아이콘 갱신용)
  const sendMax = () => mainWindow.webContents.send('win-maximized', mainWindow.isMaximized());
  mainWindow.on('maximize', sendMax);
  mainWindow.on('unmaximize', sendMax);

  Menu.setApplicationMenu(null);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // 이미 실행 중인데 또 켜면(파일 연결 더블클릭 포함) → 기존 창에 파일만 추가
  app.on('second-instance', (_e, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      sendOpenFile(extractFileArg(argv));
    }
  });

  app.whenReady().then(() => {
    createWindow();
    sendOpenFile(extractFileArg(process.argv)); // 첫 실행 시 전달된 파일 열기
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

/* ----------------------- IPC: 창 컨트롤 ----------------------- */
ipcMain.on('win:minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('win:maxtoggle', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
});
ipcMain.on('win:close', () => { if (mainWindow) mainWindow.close(); });

/* ----------------------- IPC: 확인 대화상자 ----------------------- */
// window.confirm/alert 는 Electron(프레임리스)에서 닫힌 뒤 입력 포커스가 죽는(먹통) 버그가 있어
// 네이티브 메시지 박스로 대체한다.
ipcMain.handle('dialog:confirm', async (_e, { message, detail }) => {
  const r = await dialog.showMessageBox(mainWindow, {
    type: 'question', buttons: ['확인', '취소'], defaultId: 0, cancelId: 1, noLink: true,
    message, detail: detail || undefined
  });
  return r.response === 0;
});

/* ----------------------- IPC: 파일 시스템 ----------------------- */

// 파일 열기 다이얼로그
ipcMain.handle('dialog:openFile', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: '문서', extensions: ['md', 'markdown', 'mdown', 'txt', 'json', 'html', 'htm'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  const filePath = res.filePaths[0];
  const content = await fsp.readFile(filePath, 'utf-8');
  return { filePath, content };
});

// 폴더(Vault) 열기 다이얼로그
ipcMain.handle('dialog:openFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

// 다른 이름으로 저장 다이얼로그
ipcMain.handle('dialog:saveFile', async (_e, { content, defaultPath }) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultPath || 'untitled.md',
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  });
  if (res.canceled || !res.filePath) return null;
  await fsp.writeFile(res.filePath, content, 'utf-8');
  return res.filePath;
});

// 경로로 파일 읽기
ipcMain.handle('fs:read', async (_e, filePath) => {
  const content = await fsp.readFile(filePath, 'utf-8');
  return content;
});

// 홈 화면 파일(home.md) 읽기. 포터블 exe 옆 → exe 옆 → 앱 리소스 순. 없으면 null
ipcMain.handle('app:readHome', async () => {
  const candidates = [
    // 단일 exe(포터블) 실행 시 실제 exe가 놓인 폴더(임시 압축해제 폴더가 아님)
    process.env.PORTABLE_EXECUTABLE_DIR ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'home.md') : null,
    path.join(path.dirname(app.getPath('exe')), 'home.md'), // 일반 포터블 폴더 루트
    path.join(__dirname, 'home.md')                         // 앱 리소스(기본 제공본)
  ].filter(Boolean);
  for (const p of candidates) {
    try { return await fsp.readFile(p, 'utf-8'); } catch {}
  }
  return null;
});

// 경로로 파일 쓰기
ipcMain.handle('fs:write', async (_e, { filePath, content }) => {
  await fsp.writeFile(filePath, content, 'utf-8');
  return true;
});

// 폴더 변경 감시 — 파일 추가/삭제/이름변경 시 렌더러에 알림(트리 자동 갱신)
const fsWatchers = {};
ipcMain.on('fs:watch', (e, root) => {
  if (!root || fsWatchers[root]) return;
  try {
    const w = fs.watch(root, { recursive: true }, () => {
      clearTimeout(w._t);
      w._t = setTimeout(() => { try { e.sender.send('vault-changed', root); } catch {} }, 350);
    });
    fsWatchers[root] = w;
  } catch {}
});
ipcMain.on('fs:unwatch', (_e, root) => {
  if (fsWatchers[root]) { try { fsWatchers[root].close(); } catch {} delete fsWatchers[root]; }
});

// 파일 이름 변경 (같은 폴더 내)
ipcMain.handle('fs:rename', async (_e, { oldPath, newName }) => {
  try {
    if (!newName || /[\\/:*?"<>|]/.test(newName)) return { error: 'invalid' };
    const dir = path.dirname(oldPath);
    const newPath = path.join(dir, newName);
    if (newPath === oldPath) return { ok: true, path: oldPath };
    if (fs.existsSync(newPath)) return { error: 'exists' };
    await fsp.rename(oldPath, newPath);
    return { ok: true, path: newPath };
  } catch (e) { return { error: e.message }; }
});

// 휴지통으로 보내기 (파일/폴더)
ipcMain.handle('shell:trash', async (_e, p) => {
  try { await shell.trashItem(p); return { ok: true }; }
  catch (e) { return { error: e.message }; }
});

// OS 파일 탐색기에서 위치 열기
ipcMain.handle('shell:showItem', async (_e, p) => {
  try { shell.showItemInFolder(p); return true; } catch { return false; }
});

// 새 파일 만들기 (해당 폴더에 고유 이름으로 빈 .md 생성)
ipcMain.handle('fs:createFile', async (_e, dir) => {
  try {
    const base = '제목 없음', ext = '.md';
    let name = base + ext, i = 1;
    while (fs.existsSync(path.join(dir, name))) name = `${base} ${i++}${ext}`;
    const full = path.join(dir, name);
    await fsp.writeFile(full, '', 'utf-8');
    return { path: full };
  } catch (e) { return { error: e.message }; }
});

// 새 폴더 만들기 (해당 폴더에 고유 이름으로 생성)
ipcMain.handle('fs:createFolder', async (_e, dir) => {
  try {
    const base = '새 폴더';
    let name = base, i = 1;
    while (fs.existsSync(path.join(dir, name))) name = `${base} ${i++}`;
    const full = path.join(dir, name);
    await fsp.mkdir(full);
    return { path: full };
  } catch (e) { return { error: e.message }; }
});

// 파일이 없으면 상위 폴더까지 만들어 생성 (데일리 노트). 이미 있으면 그대로 반환
ipcMain.handle('fs:ensureFile', async (_e, { filePath, content }) => {
  try {
    if (fs.existsSync(filePath)) return { path: filePath, created: false };
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, content || '', 'utf-8');
    return { path: filePath, created: true };
  } catch (e) { return { error: e.message }; }
});

// 붙여넣은 이미지를 노트 폴더의 "첨부" 하위 폴더에 저장 → 상대경로 반환
ipcMain.handle('fs:savePastedImage', async (_e, { dir, data, ext }) => {
  try {
    const sub = path.join(dir, '첨부');
    await fsp.mkdir(sub, { recursive: true });
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    const safeExt = /^[a-z0-9]{1,5}$/.test(ext) ? ext : 'png';
    let name = `img-${stamp}.${safeExt}`, i = 1;
    while (fs.existsSync(path.join(sub, name))) name = `img-${stamp}-${i++}.${safeExt}`;
    await fsp.writeFile(path.join(sub, name), Buffer.from(data));
    return { rel: '첨부/' + name, path: path.join(sub, name) };
  } catch (e) { return { error: e.message }; }
});

// 폴더 트리 읽기 (마크다운 파일만, 재귀)
ipcMain.handle('fs:tree', async (_e, root) => {
  const IGNORE = new Set(['.git', 'node_modules', '.obsidian', '.trash']);
  const MD = new Set(['.md', '.markdown', '.mdown', '.txt', '.json', '.html', '.htm']);

  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const nodes = [];
    for (const ent of entries) {
      if (ent.name.startsWith('.') && IGNORE.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (IGNORE.has(ent.name)) continue;
        const children = await walk(full);
        if (children.length > 0) {
          nodes.push({ type: 'dir', name: ent.name, path: full, children });
        }
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (MD.has(ext)) {
          nodes.push({ type: 'file', name: ent.name, path: full });
        }
      }
    }
    // 폴더 먼저, 그 다음 파일, 각각 이름순
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return nodes;
  }

  const tree = await walk(root);
  return { root, name: path.basename(root), tree };
});

// 외부 링크를 기본 브라우저로 열기
ipcMain.handle('shell:open', async (_e, url) => {
  await shell.openExternal(url);
  return true;
});

// 클립보드 복사
ipcMain.handle('clipboard:write', (_e, text) => {
  clipboard.writeText(text);
  return true;
});

// HTML 미리보기: 임시 파일로 써서 iframe 이 file:// 로 실제 렌더링하게 함
let htmlTempPath = null;
ipcMain.handle('html:renderTemp', async (_e, { content, baseDir }) => {
  try {
    if (!htmlTempPath) htmlTempPath = path.join(os.tmpdir(), `mdviewer-preview-${process.pid}.html`);
    let html = content || '';
    // 원본 폴더 기준으로 상대경로(이미지/CSS/JS) 가 풀리도록 <base> 주입
    if (baseDir) {
      const baseTag = `<base href="file:///${baseDir.replace(/\\/g, '/')}/">`;
      if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + baseTag);
      else if (/<html[^>]*>/i.test(html)) html = html.replace(/<html[^>]*>/i, (m) => m + '<head>' + baseTag + '</head>');
      else html = baseTag + html;
    }
    await fsp.writeFile(htmlTempPath, html, 'utf-8');
    return 'file:///' + htmlTempPath.replace(/\\/g, '/') + '?t=' + Date.now();
  } catch { return null; }
});

/* ----------------------- Claude Code 연동 (헤드리스) ----------------------- */
let claudeProc = null;
ipcMain.handle('claude:ask', async (_e, { prompt, cwd, sessionId, model }) => {
  return new Promise((resolve) => {
    // 프롬프트는 stdin 으로 전달(인자 인젝션 방지). 읽기 전용 도구만 허용 —
    // 파일 수정은 Claude 가 직접 하지 않고, 앱의 "반영하기" 버튼으로 적용한다.
    const args = ['-p', '--output-format', 'json', '--allowed-tools', 'Read,Glob,Grep'];
    if (model) args.push('--model', model);
    if (sessionId) args.push('--resume', sessionId);
    let child;
    try {
      child = spawn('claude', args, { cwd: cwd || process.cwd(), shell: true });
    } catch (e) { resolve({ ok: false, text: 'claude 실행 실패: ' + e.message }); return; }
    claudeProc = child;
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e2) => { claudeProc = null; resolve({ ok: false, text: 'claude 실행 실패: ' + e2.message + '\n\nClaude Code CLI가 설치되어 PATH에 있는지 확인하세요.' }); });
    child.on('close', (code) => {
      claudeProc = null;
      try {
        const j = JSON.parse(out);
        resolve({ ok: !j.is_error, text: j.result || '(빈 응답)', sessionId: j.session_id });
      } catch {
        resolve({ ok: code === 0, text: (out.trim() || err.trim() || '(응답 없음)'), sessionId });
      }
    });
    try { child.stdin.write(prompt); child.stdin.end(); } catch {}
  });
});
ipcMain.handle('claude:cancel', () => {
  if (claudeProc) { try { claudeProc.kill(); } catch {} claudeProc = null; }
  return true;
});

// 스트리밍 호출 — 토큰을 받는 대로 렌더러로 push
const claudeStreams = {};
ipcMain.on('claude:start', (e, { id, prompt, cwd, sessionId, model }) => {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--allowed-tools', 'Read,Glob,Grep'];
  if (model) args.push('--model', model);
  if (sessionId) args.push('--resume', sessionId);
  const send = (msg) => { try { e.sender.send('claude:stream', { id, ...msg }); } catch {} };
  let child;
  try { child = spawn('claude', args, { cwd: cwd || process.cwd(), shell: true }); }
  catch (err) { send({ type: 'error', text: 'claude 실행 실패: ' + err.message }); return; }
  claudeStreams[id] = child;
  let buf = '', sid = sessionId, errOut = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.session_id) sid = ev.session_id;
      if (ev.type === 'stream_event' && ev.event && ev.event.type === 'content_block_delta'
        && ev.event.delta && ev.event.delta.type === 'text_delta') {
        send({ type: 'delta', text: ev.event.delta.text });
      } else if (ev.type === 'result') {
        send({ type: 'result', text: ev.result, sessionId: ev.session_id || sid, isError: ev.is_error });
      }
    }
  });
  child.stderr.on('data', (d) => { errOut += d.toString(); });
  child.on('error', (err) => { send({ type: 'error', text: 'claude 실행 실패: ' + err.message }); });
  child.on('close', (code) => { delete claudeStreams[id]; send({ type: 'done', code, sessionId: sid, err: errOut }); });
  try { child.stdin.write(prompt); child.stdin.end(); } catch {}
});
ipcMain.on('claude:cancelStream', (_e, { id }) => {
  const c = claudeStreams[id];
  if (c) { try { c.kill(); } catch {} delete claudeStreams[id]; }
});

/* ----------------------- 검색 / 바꾸기 ----------------------- */
function buildRegex(query, { caseSensitive, regex }) {
  const flags = 'g' + (caseSensitive ? '' : 'i');
  const pat = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(pat, flags);
}

function matchLines(content, re) {
  const out = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    let m;
    const ln = lines[i];
    while ((m = re.exec(ln))) {
      out.push({ line: i, start: m.index, end: m.index + m[0].length, text: ln });
      if (m.index === re.lastIndex) re.lastIndex++;
      if (out.length > 1000) return out;
    }
  }
  return out;
}

// 폴더(Vault) 전체 검색
ipcMain.handle('fs:search', async (_e, { roots, query, caseSensitive, regex, maxResults = 3000 }) => {
  if (!query) return { results: [], total: 0 };
  let re;
  try { re = buildRegex(query, { caseSensitive, regex }); } catch { return { error: 'bad-regex' }; }
  const MD = new Set(['.md', '.markdown', '.mdown', '.txt', '.json', '.html', '.htm']);
  const IGNORE = new Set(['.git', 'node_modules', '.obsidian', '.trash']);
  const results = [];
  let total = 0;

  async function walk(dir) {
    if (total >= maxResults) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (total >= maxResults) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (IGNORE.has(ent.name)) continue;
        await walk(full);
      } else if (ent.isFile() && MD.has(path.extname(ent.name).toLowerCase())) {
        let content;
        try { content = await fsp.readFile(full, 'utf-8'); } catch { continue; }
        const matches = matchLines(content, re);
        if (matches.length) { results.push({ path: full, name: ent.name, matches }); total += matches.length; }
      }
    }
  }
  for (const r of (roots || [])) await walk(r);
  return { results, total };
});

// 여러 파일에서 바꾸기 (디스크에 기록)
ipcMain.handle('fs:replaceFiles', async (_e, { paths, query, replacement, caseSensitive, regex }) => {
  let re;
  try { re = buildRegex(query, { caseSensitive, regex }); } catch { return { error: 'bad-regex' }; }
  let files = 0, count = 0;
  for (const p of (paths || [])) {
    let content;
    try { content = await fsp.readFile(p, 'utf-8'); } catch { continue; }
    const m = content.match(re);
    const c = m ? m.length : 0;
    if (c > 0) {
      const nc = content.replace(re, replacement);
      try { await fsp.writeFile(p, nc, 'utf-8'); files++; count += c; } catch {}
    }
  }
  return { files, count };
});

// 위키링크 해석: vault 내에서 파일명으로 경로 찾기
ipcMain.handle('fs:resolveWiki', async (_e, { root, target }) => {
  if (!root) return null;
  const MD = ['.md', '.markdown', '.mdown'];
  const IGNORE = new Set(['.git', 'node_modules', '.obsidian', '.trash']);
  const want = target.toLowerCase();

  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (IGNORE.has(ent.name)) continue;
        const found = await walk(full);
        if (found) return found;
      } else if (ent.isFile()) {
        const base = path.basename(ent.name, path.extname(ent.name)).toLowerCase();
        const ext = path.extname(ent.name).toLowerCase();
        if (MD.includes(ext) && base === want) return full;
      }
    }
    return null;
  }
  return await walk(root);
});
