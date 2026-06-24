import { marked } from 'marked';
import { gfmHeadingId } from 'marked-gfm-heading-id';
import hljs from 'highlight.js';

/* ============================================================ 마크다운 설정 */
// 코드 하이라이트는 커스텀 렌더러로 직접 처리한다.
// (줄 번호 매핑을 위해 lexer/parser 를 토큰 단위로 호출하므로 walkTokens 기반
//  플러그인은 동작하지 않아, 렌더러에서 hljs 를 직접 호출한다.)
function highlightCode(text, lang) {
  const l = (lang || '').trim().split(/\s+/)[0];
  const language = l && hljs.getLanguage(l) ? l : null;
  try {
    if (language) return { html: hljs.highlight(text, { language }).value, lang: l };
    return { html: hljs.highlightAuto(text).value, lang: l };
  } catch {
    return { html: text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'), lang: l };
  }
}
marked.use(gfmHeadingId(), {
  gfm: true,
  breaks: false,
  renderer: {
    code(token) {
      // marked v14: 토큰 객체 형태. (구버전 호환을 위해 문자열도 처리)
      const text = typeof token === 'string' ? token : token.text;
      const lang = typeof token === 'string' ? arguments[1] : token.lang;
      const { html, lang: l } = highlightCode(text, lang);
      return `<pre><code class="hljs${l ? ' language-' + l : ''}">${html}</code></pre>\n`;
    }
  }
});
const wikiExtension = {
  name: 'wikilink', level: 'inline',
  start(src) { return src.indexOf('[['); },
  tokenizer(src) {
    const m = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(src);
    if (m) return { type: 'wikilink', raw: m[0], target: m[1].trim(), alias: (m[2] || m[1]).trim() };
  },
  renderer(token) {
    const t = token.target.replace(/"/g, '&quot;');
    return `<a class="wikilink" data-wiki="${t}">${token.alias}</a>`;
  }
};
marked.use({ extensions: [wikiExtension] });

/* ============================================================ DOM */
const $ = (s) => document.querySelector(s);
const editor = $('#editor');
const hl = $('#editor-highlight');
const gutter = $('#gutter');
const preview = $('#preview');
const htmlFrame = $('#html-frame');
const previewPane = $('#preview-pane');
const panes = $('#panes');
const tabbar = $('#tabbar');
const statusMode = $('#status-mode');
const statusPos = $('#status-pos');
const statusCount = $('#status-count');
const statusPath = $('#status-path');
const statusAutosave = $('#status-autosave');
const vaultsEl = $('#vaults');
const vaultsEmpty = $('#vaults-empty');
const outlineList = $('#outline-list');
const sidebar = $('#sidebar');
const sidebarStrip = $('#sidebar-strip');

/* ============================================================ 상태 */
let idSeq = 1;
const state = {
  mode: 'preview',
  tabs: [],        // {id, filePath, name, content, savedContent, dirty, edTop, edLeft, pvTop}
  activeId: null,
  vaults: [],      // {root, name, tree, collapsed}
  expandedDirs: new Set(), // 펼쳐진 폴더 경로(소문자). 기본은 접힘
  split2Id: null,  // 보조 편집기에 표시된 탭 id(두 파일 분할 편집)
  lineMap: [],
  settings: { theme: 'dark', fontSize: 14, autoSave: false, syntax: true, lineSpacing: 1.5, spellcheck: false, splitHoriz: false, puppyImage: '' },
  search: { scope: 'current', caseSensitive: false, regex: false, flat: [], cursor: -1, lastGroups: [] }
};
const active = () => state.tabs.find(t => t.id === state.activeId);

/* ============================================================ 영속화 */
const LS = 'mdv.session.v1';
function persist() {
  try {
    localStorage.setItem(LS, JSON.stringify({
      settings: state.settings,
      vaults: state.vaults.map(v => v.root),
      openFiles: state.tabs.filter(t => t.filePath).map(t => t.filePath),
      activeFile: active()?.filePath || null,
      mode: state.mode,
      sidebarWidth: sidebar.style.width || null,
      sidebarCollapsed: sidebar.classList.contains('collapsed')
    }));
  } catch {}
}
function loadSession() {
  try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; }
}

/* ============================================================ 마크다운 렌더 + 줄 매핑 */
function injectLineAttr(html, line) {
  return html.replace(/^(\s*<[a-zA-Z][\w-]*)/, `$1 data-line="${line}"`);
}
function resolveRelativeImages(html) {
  const t = active();
  if (!t || !t.filePath) return html;
  const dir = t.filePath.replace(/[\\/][^\\/]*$/, '');
  const base = 'file:///' + dir.replace(/\\/g, '/') + '/';
  return html.replace(/<img([^>]*?)src="(?!https?:|file:|data:)([^"]+)"/g,
    (full, pre, src) => `<img${pre}src="${base}${src}"`);
}
function renderMarkdown(text) {
  let tokens;
  try { tokens = marked.lexer(text); } catch { preview.innerHTML = '<p>렌더링 오류</p>'; return; }
  let line = 0, html = '';
  for (const token of tokens) {
    let piece = '';
    try { piece = marked.parser([token]); } catch { piece = ''; }
    if (piece.trim()) html += injectLineAttr(piece, line);
    line += (token.raw.match(/\n/g) || []).length;
  }
  preview.innerHTML = resolveRelativeImages(html);
  // 체크리스트 항목 구분 (완료 = 초록)
  preview.querySelectorAll('li input[type="checkbox"]').forEach((cb) => {
    const li = cb.closest('li');
    if (!li) return;
    li.classList.add('task-list-item');
    li.classList.toggle('task-done', cb.checked);
  });
  buildLineMap();
}
function buildLineMap() {
  const map = [];
  preview.querySelectorAll('[data-line]').forEach(el => map.push({ line: +el.dataset.line, top: el.offsetTop }));
  state.lineMap = map;
}

// 미리보기 갱신 — HTML 문서면 실제 페이지를 iframe 으로 렌더, 아니면 마크다운
let htmlRenderTimer = null;
function renderPreview() {
  if (isHtmlDoc(active())) {
    preview.classList.add('hidden');
    htmlFrame.classList.remove('hidden');
    renderHtmlFrame();
  } else if (isJsonDoc(active())) {
    htmlFrame.classList.add('hidden');
    preview.classList.remove('hidden');
    renderJson(editor.value);
  } else {
    htmlFrame.classList.add('hidden');
    preview.classList.remove('hidden');
    renderMarkdown(editor.value);
  }
}
// JSON 미리보기 — 들여쓰기 정렬(pretty) + 문법 색상. 유효하지 않으면 오류 안내.
function renderJson(text) {
  let pretty, error = null;
  try { pretty = JSON.stringify(JSON.parse(text), null, 2); }
  catch (e) { error = e.message; }
  if (error !== null) {
    const raw = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    preview.innerHTML = `<div class="json-error">⚠ 유효하지 않은 JSON: ${escHtml(error)}</div>`
      + `<pre><code class="hljs language-json">${raw}</code></pre>`;
  } else {
    let body;
    try { body = hljs.highlight(pretty, { language: 'json' }).value; }
    catch { body = pretty.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    preview.innerHTML = `<pre class="json-pretty"><code class="hljs language-json">${body}</code></pre>`;
  }
  state.lineMap = []; // JSON 은 줄 매핑 동기 스크롤 미지원(재구성된 문서)
}
async function renderHtmlFrame() {
  const t = active(); if (!t) return;
  const baseDir = t.filePath ? t.filePath.replace(/[\\/][^\\/]*$/, '') : '';
  const url = await window.api.renderHtmlTemp(editor.value, baseDir);
  if (url) htmlFrame.src = url;
  state.lineMap = []; // HTML 은 줄 매핑 동기 스크롤 미지원(독립 스크롤)
}

/* ============================================================ 편집기 문법 색상 (오버레이) */
function escHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function hlInline(esc) {
  const stash = [];
  const mask = (h) => { stash.push(h); return `${stash.length - 1}`; };
  esc = esc.replace(/`[^`]+`/g, m => mask(`<span class="t-code">${m}</span>`));
  esc = esc.replace(/!?\[[^\]]*\]\([^)]*\)/g, m => mask(`<span class="t-link">${m}</span>`));
  esc = esc.replace(/\[\[[^\]]+\]\]/g, m => mask(`<span class="t-wiki">${m}</span>`));
  esc = esc.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<span class="t-bold">$&</span>');
  esc = esc.replace(/(?<![*_\w\\])([*_])(?=\S)([^*_\n]*?\S|\S)\1(?![*_\w])/g, '<span class="t-italic">$&</span>');
  esc = esc.replace(/(\d+)/g, (m, i) => stash[+i]);
  return esc;
}
// 들여쓰기(앞 공백) — 모노스페이스에서 4칸마다 연한 가이드(·, 공백과 동일 폭)
function renderIndent(ws) {
  let out = '';
  for (let i = 0; i < ws.length; i++) {
    if (ws[i] === '\t') { out += '<span class="t-indent">\t</span>'; continue; }
    out += (i % 4 === 0) ? '<span class="t-indent">·</span>' : ' ';
  }
  return out;
}
function hlLine(line, st) {
  if (/^\s*```/.test(line)) { st.fence = !st.fence; return `<span class="t-fence">${escHtml(line)}</span>`; }
  if (st.fence) return `<span class="t-codeblock">${escHtml(line)}</span>`;
  const im = line.match(/^[ \t]+/);
  const ind = im ? im[0] : '';
  const pre = ind ? renderIndent(ind) : '';
  const body = line.slice(ind.length);
  let m;
  if ((m = /^(#{1,6})(\s.*)?$/.exec(body)))
    return `${pre}<span class="t-heading"><span class="t-mark">${m[1]}</span>${hlInline(escHtml(m[2] || ''))}</span>`;
  if (/^>/.test(body)) return `${pre}<span class="t-quote">${hlInline(escHtml(body))}</span>`;
  if ((m = /^([-*+]|\d+\.)(\s.*)?$/.exec(body)) && /^([-*+]|\d+\.)\s/.test(body))
    return `${pre}<span class="t-listmark">${escHtml(m[1])}</span>${hlInline(escHtml(m[2] || ''))}`;
  if (/^([-*_])(\s*\1){2,}\s*$/.test(body)) return `${pre}<span class="t-hr">${escHtml(body)}</span>`;
  return pre + hlInline(escHtml(body));
}
function buildHL(value, tab) {
  // JSON 파일은 hljs 의 JSON 문법 색상을 그대로 사용 (줄 수 보존)
  if (isJsonDoc(tab)) {
    try { return hljs.highlight(value, { language: 'json' }).value + '\n'; }
    catch { /* 파싱 실패 시 일반 처리로 폴백 */ }
  }
  const st = { fence: false };
  return value.split('\n').map(l => hlLine(l, st)).join('\n') + '\n';
}
function applyHighlight() {
  if (!state.settings.syntax) return;
  hl.innerHTML = buildHL(editor.value, active());
}
function syncHighlightScroll() { hl.scrollTop = editor.scrollTop; hl.scrollLeft = editor.scrollLeft; }

/* ============================================================ 거터 / 카운트 / 커서 */
function lineHeightPx() { const lh = parseFloat(getComputedStyle(editor).lineHeight); return isNaN(lh) ? state.settings.fontSize * 1.5 : lh; }
function updateGutter() {
  const count = editor.value.split('\n').length;
  const cur = gutter.childElementCount;
  if (cur === count) return;
  if (count > cur) {
    const frag = document.createDocumentFragment();
    for (let i = cur + 1; i <= count; i++) { const d = document.createElement('div'); d.textContent = i; frag.appendChild(d); }
    gutter.appendChild(frag);
  } else { while (gutter.childElementCount > count) gutter.lastChild.remove(); }
}
function syncGutter() { gutter.scrollTop = editor.scrollTop; }
function updateCounts() {
  const text = editor.value;
  statusCount.textContent = `${(text.trim().match(/\S+/g) || []).length} 단어 · ${text.length} 글자`;
}
function updateCursorPos() {
  const before = editor.value.slice(0, editor.selectionStart);
  const lines = before.split('\n');
  statusPos.textContent = `줄 ${lines.length}, 열 ${lines[lines.length - 1].length + 1}`;
}

/* ============================================================ 동기 스크롤 */
let syncing = false;
const releaseSync = () => requestAnimationFrame(() => { syncing = false; });
function previewTopForLine(line) {
  const map = state.lineMap;
  if (!map.length) return 0;
  if (line <= map[0].line) return 0;
  for (let i = 0; i < map.length - 1; i++) {
    const a = map[i], b = map[i + 1];
    if (line >= a.line && line < b.line) return a.top + ((line - a.line) / (b.line - a.line || 1)) * (b.top - a.top);
  }
  return map[map.length - 1].top;
}
function syncEditorToPreview() {
  if (syncing || state.mode !== 'split' || !state.lineMap.length) return;
  syncing = true;
  previewPane.scrollTop = previewTopForLine(editor.scrollTop / lineHeightPx());
  releaseSync();
}
function syncPreviewToEditor() {
  if (syncing || state.mode !== 'split' || !state.lineMap.length) return;
  syncing = true;
  const y = previewPane.scrollTop, map = state.lineMap;
  let line = map[map.length - 1].line;
  if (y <= map[0].top) line = map[0].line;
  else for (let i = 0; i < map.length - 1; i++) {
    const a = map[i], b = map[i + 1];
    if (y >= a.top && y < b.top) { line = a.line + ((y - a.top) / (b.top - a.top || 1)) * (b.line - a.line); break; }
  }
  editor.scrollTop = line * lineHeightPx();
  syncGutter(); syncHighlightScroll(); releaseSync();
}
function scrollToLine(line) {
  editor.scrollTop = line * lineHeightPx();
  syncGutter(); syncHighlightScroll();
  previewPane.scrollTop = previewTopForLine(line);
}

/* ============================================================ 되돌리기 히스토리 (탭별) */
const HIST_MAX = 200;
let histTimer = null;
function pushUndo(t, content) {
  t.und.push(content);
  if (t.und.length > HIST_MAX) t.und.shift();
  t.red = [];
  updateUndoButtons();
}
function scheduleHistoryCommit() {
  clearTimeout(histTimer);
  histTimer = setTimeout(() => {
    const t = active();
    if (t && editor.value !== t.lastCommitted) { pushUndo(t, t.lastCommitted); t.lastCommitted = editor.value; }
  }, 500);
}
function flushHistoryCommit() {
  clearTimeout(histTimer);
  const t = active();
  if (t && editor.value !== t.lastCommitted) { pushUndo(t, t.lastCommitted); t.lastCommitted = editor.value; }
}
// 프로그램적 내용 교체 (Claude 반영 등) — 변경 전 상태를 히스토리에 기록
function applyContentHist(targetId, text) {
  const tab = state.tabs.find(x => x.id === targetId);
  if (!tab) return false;
  if (state.activeId !== targetId) activateTab(targetId);
  flushHistoryCommit();
  pushUndo(tab, tab.lastCommitted);
  editor.value = text; onEditorChanged();
  tab.lastCommitted = text;
  saveFile(false);
  return true;
}
function undoHistory() {
  const t = active(); if (!t) return;
  flushHistoryCommit();
  if (!t.und.length) { toast('되돌릴 기록이 없습니다'); return; }
  t.red.push(t.lastCommitted);
  const prev = t.und.pop();
  editor.value = prev; onEditorChanged(); t.lastCommitted = prev;
  updateUndoButtons();
  toast(`되돌리기 (남은 기록 ${t.und.length})`);
}
function redoHistory() {
  const t = active(); if (!t) return;
  flushHistoryCommit();
  if (!t.red.length) { toast('다시 실행할 기록이 없습니다'); return; }
  t.und.push(t.lastCommitted);
  const nxt = t.red.pop();
  editor.value = nxt; onEditorChanged(); t.lastCommitted = nxt;
  updateUndoButtons();
}
function updateUndoButtons() {
  const t = active();
  const u = $('#tb-undo'), r = $('#tb-redo');
  if (u) u.disabled = !t || !t.und.length;
  if (r) r.disabled = !t || !t.red.length;
}

/* ============================================================ 입력 처리 */
let renderTimer = null, autoSaveTimer = null;
function onEditorChanged() {
  const t = active(); if (!t) return;
  t.content = editor.value;
  t.dirty = t.content !== t.savedContent;
  applyHighlight();
  updateGutter(); updateCounts();
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => { renderPreview(); buildOutline(); }, 80);
  renderTabs();
  scheduleAutoSave();
  scheduleHistoryCommit();
}
function scheduleAutoSave() {
  if (!state.settings.autoSave) return;
  const t = active(); if (!t || !t.filePath || !t.dirty) return;
  clearTimeout(autoSaveTimer);
  statusAutosave.textContent = '● 변경됨';
  autoSaveTimer = setTimeout(async () => { await saveFile(true); }, 1500);
}
editor.addEventListener('input', onEditorChanged);
editor.addEventListener('scroll', () => {
  syncGutter(); syncHighlightScroll(); syncEditorToPreview();
  updateActiveOutline(editor.scrollTop / lineHeightPx());
});
editor.addEventListener('keyup', updateCursorPos);
editor.addEventListener('click', updateCursorPos);
previewPane.addEventListener('scroll', () => {
  syncPreviewToEditor();
  updateActiveOutline(lineFromPreviewTop(previewPane.scrollTop));
});
function editSet(value, caret) { editor.value = value; editor.selectionStart = editor.selectionEnd = caret; onEditorChanged(); }
editor.addEventListener('keydown', (e) => {
  const s = editor.selectionStart, en = editor.selectionEnd;
  const v = editor.value;
  if (e.key === 'Tab') {
    e.preventDefault();
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    if (e.shiftKey) { // 내어쓰기
      const m = v.slice(lineStart).match(/^( {1,4}|\t)/);
      if (m) editSet(v.slice(0, lineStart) + v.slice(lineStart + m[1].length), Math.max(lineStart, s - m[1].length));
    } else {
      editSet(v.slice(0, s) + '    ' + v.slice(en), s + 4);
    }
  } else if (e.key === 'Enter' && s === en) {
    // 자동 들여쓰기 + 목록 마커 이어쓰기
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    const line = v.slice(lineStart, s);
    const indent = (line.match(/^[ \t]*/) || [''])[0];
    const lm = line.match(/^([ \t]*)([-*+]\s(?:\[[ xX]\]\s)?|\d+\.\s)(.*)$/);
    if (lm && lm[3].trim() === '') { // 빈 목록 항목 → 마커 제거(목록 종료)
      e.preventDefault(); editSet(v.slice(0, lineStart) + v.slice(s), lineStart); return;
    }
    let insert = '\n' + indent;
    if (lm) {
      let marker = lm[2].replace(/\[[xX]\]/, '[ ]');
      const om = marker.match(/^(\d+)\.\s$/);
      if (om) marker = (parseInt(om[1], 10) + 1) + '. ';
      insert = '\n' + lm[1] + marker;
    }
    if (insert !== '\n') { e.preventDefault(); editSet(v.slice(0, s) + insert + v.slice(en), s + insert.length); }
  } else if (e.key === 'Backspace' && s === en && s > 0) {
    // 들여쓰기 구간에서는 탭 단위로 삭제
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    const before = v.slice(lineStart, s);
    if (/^ +$/.test(before)) {
      const del = ((before.length - 1) % 4) + 1;
      e.preventDefault(); editSet(v.slice(0, s - del) + v.slice(s), s - del);
    }
  }
});

/* ============================================================ 모드 */
const modeLabels = { editor: '편집', split: '분할', preview: '미리보기' };
function setMode(mode) {
  // 분할 편집(두 파일) 중이면 해제하고 일반 모드로
  if (state.split2Id) { state.split2Id = null; editor2Pane.classList.add('hidden'); focusedEditor = 1; renderTabs(); }
  state.mode = mode;
  panes.dataset.mode = mode;
  panes.classList.toggle('horizontal', !!state.settings.splitHoriz);
  document.body.classList.toggle('preview-only', mode === 'preview');
  statusMode.textContent = modeLabels[mode];
  document.querySelectorAll('.mode-switch button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  if (mode !== 'editor') renderPreview();
  if (mode === 'split') requestAnimationFrame(() => { buildLineMap(); syncEditorToPreview(); });
  if (mode !== 'preview') requestAnimationFrame(() => { applyHighlight(); editor.focus(); });
  persist();
}
let lastNonSplit = 'preview';
function toggleEditPreview() { setMode(state.mode === 'editor' ? 'preview' : 'editor'); }
function toggleSplit() {
  if (state.mode === 'split') setMode(lastNonSplit);
  else { lastNonSplit = state.mode === 'preview' ? 'preview' : 'editor'; setMode('split'); }
}
document.querySelectorAll('.mode-switch button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
function toggleSplitDir() {
  state.settings.splitHoriz = !state.settings.splitHoriz;
  panes.classList.toggle('horizontal', state.settings.splitHoriz);
  $('#btn-split-dir').textContent = state.settings.splitHoriz ? '⬍' : '⬌';
  $('#btn-split-dir').title = state.settings.splitHoriz ? '분할 방향: 상하 (클릭 시 좌우)' : '분할 방향: 좌우 (클릭 시 상하)';
  if (state.mode !== 'split') setMode('split');
  else requestAnimationFrame(() => { buildLineMap(); syncEditorToPreview(); });
  persist();
}
$('#btn-split-dir').addEventListener('click', toggleSplitDir);

/* ============================================================ 탭 */
function newTab({ filePath = null, content = '', name } = {}) {
  const tab = {
    id: idSeq++, filePath,
    name: name || (filePath ? filePath.replace(/^.*[\\/]/, '') : 'untitled.md'),
    content, savedContent: content, dirty: false, edTop: 0, edLeft: 0, pvTop: 0,
    und: [], red: [], lastCommitted: content // 되돌리기 히스토리
  };
  state.tabs.push(tab);
  return tab;
}
function activateTab(id) {
  // 같은 파일을 양쪽에 둘 수 없으므로, 보조 편집기에 있던 탭을 주 편집기로 열면 분할 편집 해제
  if (id === state.split2Id) closeSplit2();
  const cur = active();
  if (cur && cur.id !== id) {
    flushHistoryCommit();
    cur.content = editor.value; cur.edTop = editor.scrollTop; cur.edLeft = editor.scrollLeft; cur.pvTop = previewPane.scrollTop;
  }
  state.activeId = id;
  const t = active(); if (!t) return;
  editor.value = t.content;
  statusPath.textContent = t.filePath || '';
  setDocTitle(t.name);
  updateGutter(); updateCounts(); updateCursorPos(); applyHighlight();
  renderPreview(); buildOutline();
  editor.scrollTop = t.edTop; editor.scrollLeft = t.edLeft; previewPane.scrollTop = t.pvTop;
  syncGutter(); syncHighlightScroll();
  renderTabs(); highlightActiveTreeItem();
  statusAutosave.textContent = '';
  if (typeof updateClaudeCtx === 'function') updateClaudeCtx();
  updateUndoButtons();
  persist();
}
function closeTab(id) {
  const idx = state.tabs.findIndex(t => t.id === id);
  if (idx < 0) return;
  const t = state.tabs[idx];
  if (t.dirty && !confirm(`"${t.name}" 의 변경 사항이 저장되지 않았습니다. 닫을까요?`)) return;
  if (id === state.split2Id) closeSplit2();
  state.tabs.splice(idx, 1);
  if (state.activeId === id) {
    if (state.tabs.length) activateTab(state.tabs[Math.max(0, idx - 1)].id);
    else { const w = newTab({ content: '' }); activateTab(w.id); }
  } else { renderTabs(); }
  persist();
}
function renderTabs() {
  tabbar.innerHTML = '';
  state.tabs.forEach(t => {
    if (t.id === state.split2Id) return; // 분리된 탭은 오른쪽 보조 탭바에 표시
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === state.activeId ? ' active' : '');
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      draggingTabId = t.id;
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', t.name); } catch {}
    });
    el.addEventListener('dragend', () => { draggingTabId = null; const h = $('#split-drop-hint'); if (h) h.classList.add('hidden'); });
    const icon = document.createElement('span');
    icon.className = 'ticon'; icon.textContent = fileIcon(t.name);
    el.appendChild(icon);
    const name = document.createElement('span');
    name.className = 'tname'; name.textContent = t.name; name.title = '더블클릭하면 이름 변경';
    name.addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(t, name); });
    el.appendChild(name);
    if (t.dirty) { const d = document.createElement('span'); d.className = 'tdirty'; d.textContent = '●'; el.appendChild(d); }
    const close = document.createElement('span');
    close.className = 'tclose'; close.textContent = '✕';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t.id); });
    el.appendChild(close);
    el.addEventListener('click', () => activateTab(t.id));
    el.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } });
    tabbar.appendChild(el);
  });
  const add = document.createElement('div');
  add.className = 'tab-new'; add.textContent = '＋'; add.title = '새 탭';
  add.addEventListener('click', () => { const w = newTab({ content: '' }); activateTab(w.id); });
  tabbar.appendChild(add);
  renderSplit2Tab();
  requestAnimationFrame(() => {
    const a = tabbar.querySelector('.tab.active');
    if (a) a.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    updateTabScrollButtons();
  });
}
function updateTabScrollButtons() {
  const lb = $('#tab-scroll-left'), rb = $('#tab-scroll-right');
  if (!lb || !rb) return;
  const overflow = tabbar.scrollWidth > tabbar.clientWidth + 1;
  lb.classList.toggle('hidden', !overflow);
  rb.classList.toggle('hidden', !overflow);
  if (overflow) {
    lb.disabled = tabbar.scrollLeft <= 0;
    rb.disabled = tabbar.scrollLeft >= tabbar.scrollWidth - tabbar.clientWidth - 1;
  }
}
(function setupTabScroll() {
  tabbar.addEventListener('wheel', (e) => {
    if (e.ctrlKey) return;            // Ctrl+휠은 글꼴 크기(전역 처리)
    if (e.deltaY) { e.preventDefault(); tabbar.scrollLeft += e.deltaY; }
  }, { passive: false });
  tabbar.addEventListener('scroll', updateTabScrollButtons);
  $('#tab-scroll-left').addEventListener('click', () => tabbar.scrollBy({ left: -220, behavior: 'smooth' }));
  $('#tab-scroll-right').addEventListener('click', () => tabbar.scrollBy({ left: 220, behavior: 'smooth' }));
  window.addEventListener('resize', updateTabScrollButtons);
})();
function startRename(tab, span) {
  const input = document.createElement('input');
  input.className = 'tab-rename'; input.value = tab.name;
  span.replaceWith(input);
  input.focus();
  const dot = tab.name.lastIndexOf('.');
  if (dot > 0) input.setSelectionRange(0, dot); else input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return; done = true;
    if (commit) commitRename(tab, input.value.trim()); else renderTabs();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
}
async function commitRename(tab, name) {
  if (!name || name === tab.name) { renderTabs(); return; }
  if (/[\\/:*?"<>|]/.test(name)) { toast('파일명에 \\ / : * ? " < > | 는 쓸 수 없습니다'); renderTabs(); return; }
  // 확장자를 생략하면 기존 확장자 유지
  const oldExt = (tab.name.match(/\.[^.]+$/) || [''])[0];
  if (oldExt && !/\.[^.]+$/.test(name)) name += oldExt;
  if (name === tab.name) { renderTabs(); return; }
  if (tab.filePath) {
    const res = await window.api.renameFile(tab.filePath, name);
    if (!res || res.error) {
      toast(res && res.error === 'exists' ? '같은 이름의 파일이 이미 있습니다'
        : res && res.error === 'invalid' ? '잘못된 파일명입니다' : '이름 변경 실패');
      renderTabs(); return;
    }
    tab.filePath = res.path; tab.name = name;
    if (tab.id === state.activeId) { statusPath.textContent = tab.filePath; setDocTitle(tab.name); }
    for (const v of state.vaults) if (res.path.startsWith(v.root)) await refreshVault(v);
    persist();
    toast('이름을 변경했습니다');
  } else {
    tab.name = name;
    if (tab.id === state.activeId) setDocTitle(tab.name);
  }
  renderTabs();
}

/* ============================================================ 파일 */
async function openFile() { const r = await window.api.openFile(); if (r) openInTab(r.filePath, r.content); }
async function openPath(filePath) {
  const exist = state.tabs.find(t => t.filePath === filePath);
  if (exist) { activateTab(exist.id); revealInTree(filePath); return; }
  try { const content = await window.api.readFile(filePath); openInTab(filePath, content); revealInTree(filePath); }
  catch { alert('파일을 열 수 없습니다: ' + filePath); }
}
function openInTab(filePath, content) { const t = newTab({ filePath, content }); activateTab(t.id); }
async function saveFile(silent) {
  // 분할 편집 중 보조 편집기에 포커스가 있으면 그쪽 파일 저장
  if (focusedEditor === 2 && state.split2Id) return saveEditor2(silent);
  const t = active(); if (!t) return;
  if (t.filePath) {
    await window.api.writeFile(t.filePath, editor.value);
    t.savedContent = editor.value; t.dirty = false; renderTabs();
    statusAutosave.textContent = silent ? '✓ 자동 저장됨' : '✓ 저장됨';
    setTimeout(() => { if (statusAutosave.textContent.includes('저장됨')) statusAutosave.textContent = ''; }, 2000);
  } else await saveFileAs();
}
async function saveFileAs() {
  const t = active(); if (!t) return;
  const fp = await window.api.saveFileAs(editor.value, t.name);
  if (fp) {
    t.filePath = fp; t.name = fp.replace(/^.*[\\/]/, ''); t.savedContent = editor.value; t.dirty = false;
    statusPath.textContent = fp; setDocTitle(t.name);
    renderTabs();
    for (const v of state.vaults) if (fp.toLowerCase().startsWith(v.root.toLowerCase())) await refreshVault(v);
    persist();
  }
}

/* ============================================================ Vault (다중 폴더) */
function countMd(nodes) {
  let n = 0;
  for (const node of nodes) n += node.type === 'dir' ? countMd(node.children) : 1;
  return n;
}
async function addVaultRoot(root, { silent = false } = {}) {
  if (!root) return;
  if (state.vaults.some(v => v.root.toLowerCase() === root.toLowerCase())) { if (!silent) toast('이미 추가된 폴더입니다'); return; }
  const v = { root, name: root.replace(/^.*[\\/]/, ''), tree: [], collapsed: false };
  state.vaults.push(v);
  await refreshVault(v);
  renderVaults(); persist();
  window.api.watchFolder(root); // 폴더 변경 자동 감시
  if (!silent) {
    const n = countMd(v.tree);
    if (n === 0) toast(`"${v.name}" 폴더에 문서 파일이 없습니다`);
    else toast(`"${v.name}" — 문서 ${n}개를 찾았습니다`);
  }
}
async function addFolder() {
  const root = await window.api.openFolder();
  await addVaultRoot(root);
}
async function refreshVault(v) { const data = await window.api.readTree(v.root); v.name = data.name; v.tree = data.tree; renderVaults(); }
function removeVault(root) { window.api.unwatchFolder(root); state.vaults = state.vaults.filter(v => v.root !== root); renderVaults(); persist(); }
// 외부에서 폴더 내용이 바뀌면(파일 추가/삭제/이름변경) 해당 Vault 트리 자동 갱신
window.api.onVaultChanged((root) => {
  const v = state.vaults.find(x => x.root === root);
  if (v) refreshVault(v);
});
function renderVaults() {
  vaultsEl.innerHTML = '';
  vaultsEmpty.style.display = state.vaults.length ? 'none' : '';
  state.vaults.forEach(v => {
    const sec = document.createElement('div');
    sec.className = 'vault' + (v.collapsed ? ' collapsed' : '');
    const head = document.createElement('div');
    head.className = 'vault-head';
    const tw = document.createElement('span'); tw.className = 'tw'; tw.textContent = '▾';
    const nm = document.createElement('span'); nm.className = 'vname'; nm.textContent = '📁 ' + v.name;
    const cl = document.createElement('span'); cl.className = 'vclose'; cl.textContent = '✕'; cl.title = '폴더 닫기';
    cl.addEventListener('click', (e) => { e.stopPropagation(); removeVault(v.root); });
    head.append(tw, nm, cl);
    head.addEventListener('click', () => { v.collapsed = !v.collapsed; sec.classList.toggle('collapsed'); persist(); });
    const body = document.createElement('div'); body.className = 'vault-body';
    if (v.tree.length) body.appendChild(renderTreeNodes(v.tree));
    else { const e = document.createElement('div'); e.className = 'tree-empty'; e.textContent = '(마크다운 없음)'; body.appendChild(e); }
    sec.append(head, body);
    vaultsEl.appendChild(sec);
  });
  highlightActiveTreeItem();
  if (typeof populateClaudeScope === 'function') populateClaudeScope();
}
function fileIcon(name) {
  const ext = (name.match(/\.[^.]*$/) || [''])[0].toLowerCase();
  if (ext === '.txt') return '📄';
  if (ext === '.json') return '🔧';
  if (ext === '.html' || ext === '.htm') return '🌐';
  return '📝'; // md/markdown/mdown
}
function isHtmlDoc(t) { return !!(t && /\.(html?|htm)$/i.test(t.name)); }
function isJsonDoc(t) { return !!(t && /\.json$/i.test(t.name)); }
function renderTreeNodes(nodes) {
  const frag = document.createDocumentFragment();
  for (const node of nodes) {
    const wrap = document.createElement('div');
    const item = document.createElement('div'); item.className = 'tree-item';
    if (node.type === 'dir') {
      const key = node.path.toLowerCase();
      const expanded = state.expandedDirs.has(key);
      const tw = document.createElement('span'); tw.className = 'tw'; tw.textContent = '▾';
      if (!expanded) tw.style.transform = 'rotate(-90deg)';
      const ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = '📁';
      const label = document.createElement('span'); label.textContent = node.name;
      item.append(tw, ic, label);
      const children = document.createElement('div'); children.className = 'tree-children';
      if (!expanded) children.style.display = 'none';
      children.appendChild(renderTreeNodes(node.children));
      item.addEventListener('click', () => {
        const willExpand = !state.expandedDirs.has(key);
        if (willExpand) state.expandedDirs.add(key); else state.expandedDirs.delete(key);
        children.style.display = willExpand ? '' : 'none';
        tw.style.transform = willExpand ? '' : 'rotate(-90deg)';
      });
      wrap.append(item, children);
    } else {
      const tw = document.createElement('span'); tw.className = 'tw';
      const ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = fileIcon(node.name);
      const label = document.createElement('span'); label.textContent = node.name;
      item.append(tw, ic, label);
      item.dataset.path = node.path;
      item.addEventListener('click', () => openPath(node.path));
      item.draggable = true;
      item.addEventListener('dragstart', (e) => {
        draggingTreePath = node.path;
        e.dataTransfer.effectAllowed = 'copy';
        try { e.dataTransfer.setData('text/plain', node.name); } catch {}
      });
      item.addEventListener('dragend', () => { draggingTreePath = null; const hh = $('#split-drop-hint'); if (hh) hh.classList.add('hidden'); });
      wrap.append(item);
    }
    frag.appendChild(wrap);
  }
  return frag;
}
function cssEsc(s) { return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
// 파일이 속한 폴더 체인(루트 바로 아래 ~ 파일 폴더, 소문자)
function dirChain(vaultRoot, filePath) {
  const fileDir = filePath.replace(/[\\/][^\\/]*$/, '');
  const rootLow = vaultRoot.toLowerCase();
  const chain = [];
  let cur = fileDir, guard = 0;
  while (cur && cur.toLowerCase() !== rootLow && cur.toLowerCase().startsWith(rootLow) && guard++ < 60) {
    chain.unshift(cur.toLowerCase());
    const up = cur.replace(/[\\/][^\\/]*$/, '');
    if (up === cur) break;
    cur = up;
  }
  return chain;
}
// 연 파일이 트리에 보이도록 그 경로의 폴더만 펼침(나머지는 그대로)
function revealInTree(filePath) {
  if (!filePath) return;
  const v = state.vaults.find(x => filePath.toLowerCase().startsWith(x.root.toLowerCase()));
  if (!v) return;
  for (const d of dirChain(v.root, filePath)) state.expandedDirs.add(d);
  v.collapsed = false;
  renderVaults();
  const el = vaultsEl.querySelector(`.tree-item[data-path="${cssEsc(filePath)}"]`);
  if (el) el.scrollIntoView({ block: 'nearest' });
}
function highlightActiveTreeItem() {
  vaultsEl.querySelectorAll('.tree-item.active').forEach(e => e.classList.remove('active'));
  const t = active(); if (!t || !t.filePath) return;
  const el = vaultsEl.querySelector(`.tree-item[data-path="${cssEsc(t.filePath)}"]`);
  if (el) el.classList.add('active');
}

/* ============================================================ 목차 (Outline) */
let outlineEntries = []; // [{line, el}]
function buildOutline() {
  const lines = editor.value.split('\n');
  outlineList.innerHTML = '';
  outlineEntries = [];
  let fence = false;
  lines.forEach((ln, i) => {
    if (/^\s*```/.test(ln)) { fence = !fence; return; }
    if (fence) return;
    const m = /^(#{1,6})\s+(.*)$/.exec(ln);
    if (m) {
      const item = document.createElement('div');
      item.className = 'outline-item lv' + m[1].length;
      item.textContent = m[2].replace(/[*_`~]/g, '');
      item.title = m[2];
      item.addEventListener('click', () => scrollToLine(i));
      outlineList.appendChild(item);
      outlineEntries.push({ line: i, el: item });
    }
  });
  if (!outlineEntries.length) outlineList.innerHTML = '<div class="tree-empty">제목 없음</div>';
}
function setActiveOutline(currentLine) {
  if (!outlineEntries.length) return;
  let idx = -1;
  for (let i = 0; i < outlineEntries.length; i++) {
    if (outlineEntries[i].line <= currentLine + 0.5) idx = i; else break;
  }
  outlineEntries.forEach((e, i) => e.el.classList.toggle('active-outline', i === idx));
  if (idx >= 0) {
    const el = outlineEntries[idx].el;
    const box = outlineList.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top < box.top || r.bottom > box.bottom) el.scrollIntoView({ block: 'nearest' });
  }
}
// 프리뷰 scrollTop → 소스 줄(소수)
function lineFromPreviewTop(y) {
  const map = state.lineMap;
  if (!map.length) return 0;
  if (y <= map[0].top) return map[0].line;
  for (let i = 0; i < map.length - 1; i++) {
    const a = map[i], b = map[i + 1];
    if (y >= a.top && y < b.top) return a.line + ((y - a.top) / (b.top - a.top || 1)) * (b.line - a.line);
  }
  return map[map.length - 1].line;
}
let outlineRaf = null;
function updateActiveOutline(line) {
  if (outlineRaf) return;
  outlineRaf = requestAnimationFrame(() => { outlineRaf = null; setActiveOutline(line); });
}

/* ============================================================ 프리뷰 링크 */
preview.addEventListener('click', async (e) => {
  const wiki = e.target.closest('a.wikilink');
  if (wiki) {
    e.preventDefault();
    if (!state.vaults.length) { alert('위키링크를 따라가려면 폴더를 먼저 여세요.'); return; }
    for (const v of state.vaults) {
      const resolved = await window.api.resolveWiki(v.root, wiki.dataset.wiki);
      if (resolved) return openPath(resolved);
    }
    alert(`"${wiki.dataset.wiki}" 노트를 찾을 수 없습니다.`);
    return;
  }
  const a = e.target.closest('a[href]');
  if (a) {
    const href = a.getAttribute('href');
    if (/^https?:/i.test(href)) { e.preventDefault(); window.api.openExternal(href); }
    else if (href.startsWith('#')) {
      e.preventDefault();
      const tgt = preview.querySelector(`#${CSS.escape(decodeURIComponent(href.slice(1)))}`);
      if (tgt) tgt.scrollIntoView({ behavior: 'smooth' });
    }
  }
});

/* ============================================================ 미리보기 블록 복사 (호버) */
const copyBtn = document.createElement('button');
copyBtn.id = 'block-copy'; copyBtn.className = 'block-copy hidden'; copyBtn.title = '이 문단 복사';
copyBtn.textContent = '📋';
previewPane.appendChild(copyBtn);
let hoverBlock = null;

function positionCopyBtn(block) {
  const br = block.getBoundingClientRect();
  const pr = previewPane.getBoundingClientRect();
  copyBtn.style.top = (br.top - pr.top + previewPane.scrollTop + 4) + 'px';
  copyBtn.style.left = (br.right - pr.left - 30) + 'px';
}
function handlePreviewHover(e) {
  if (state.mode === 'editor') return;
  if (e.target === copyBtn) return;
  let block = e.target.closest('[data-line]');
  while (block && block.parentElement !== preview) {
    const up = block.parentElement ? block.parentElement.closest('[data-line]') : null;
    if (!up) break;
    block = up;
  }
  if (!block || block.parentElement !== preview) return;
  if (hoverBlock !== block) {
    if (hoverBlock) hoverBlock.classList.remove('hov');
    hoverBlock = block;
    block.classList.add('hov');
    copyBtn.textContent = '📋';
    copyBtn.classList.remove('hidden');
  }
  positionCopyBtn(block);
}
preview.addEventListener('mousemove', handlePreviewHover);
preview.addEventListener('mouseover', handlePreviewHover);
previewPane.addEventListener('mouseleave', () => {
  if (hoverBlock) hoverBlock.classList.remove('hov');
  hoverBlock = null;
  copyBtn.classList.add('hidden');
});
copyBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!hoverBlock) return;
  const start = +hoverBlock.dataset.line;
  const lines = editor.value.split('\n');
  const after = [...preview.querySelectorAll('[data-line]')]
    .map((el) => +el.dataset.line).filter((n) => n > start).sort((a, b) => a - b);
  const end = after.length ? after[0] : lines.length;
  const text = lines.slice(start, end).join('\n').replace(/\s+$/, '');
  await window.api.copyText(text);
  copyBtn.textContent = '✓';
  toast('문단을 복사했습니다');
});

/* ============================================================ 토스트 */
let toastTimer = null;
function toast(msg) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

/* ============================================================ 서식 툴바 */
function applyFormat(fmt) {
  editor.focus();
  const s = editor.selectionStart, en = editor.selectionEnd;
  const val = editor.value, sel = val.slice(s, en);
  const wrap = (b, a = b, ph = '텍스트') => {
    const inner = sel || ph;
    editor.value = val.slice(0, s) + b + inner + a + val.slice(en);
    editor.selectionStart = s + b.length; editor.selectionEnd = s + b.length + inner.length;
  };
  const lineprefix = (pfx) => {
    const ls = val.lastIndexOf('\n', s - 1) + 1;
    editor.value = val.slice(0, ls) + pfx + val.slice(ls);
    editor.selectionStart = editor.selectionEnd = en + pfx.length;
  };
  const insert = (txt) => {
    editor.value = val.slice(0, s) + txt + val.slice(en);
    editor.selectionStart = editor.selectionEnd = s + txt.length;
  };
  switch (fmt) {
    case 'bold': wrap('**'); break;
    case 'italic': wrap('*'); break;
    case 'strike': wrap('~~'); break;
    case 'code': wrap('`', '`', '코드'); break;
    case 'h1': lineprefix('# '); break;
    case 'h2': lineprefix('## '); break;
    case 'h3': lineprefix('### '); break;
    case 'ul': lineprefix('- '); break;
    case 'ol': lineprefix('1. '); break;
    case 'task': lineprefix('- [ ] '); break;
    case 'quote': lineprefix('> '); break;
    case 'codeblock': wrap('```\n', '\n```', '코드'); break;
    case 'link': { const inner = sel || '링크'; insert(`[${inner}](url)`); break; }
    case 'table': insert('\n| 제목1 | 제목2 |\n|------|------|\n| 내용 | 내용 |\n'); break;
    case 'hr': insert('\n---\n'); break;
  }
  onEditorChanged();
}
$('#toolbar').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-fmt]');
  if (b) applyFormat(b.dataset.fmt);
});
$('#tb-undo').addEventListener('click', undoHistory);
$('#tb-redo').addEventListener('click', redoHistory);

/* ============================================================ 커맨드 팔레트 */
const paletteOverlay = $('#palette-overlay');
const paletteInput = $('#palette-input');
const paletteListEl = $('#palette-list');
const commands = [
  { name: '편집 모드', kbd: 'Ctrl+1', run: () => setMode('editor') },
  { name: '분할 모드', kbd: 'Ctrl+2', run: () => setMode('split') },
  { name: '미리보기 모드', kbd: 'Ctrl+3', run: () => setMode('preview') },
  { name: '검색 (현재 파일)', kbd: 'Ctrl+F', run: () => openSearch('current') },
  { name: '검색 (폴더 전체)', kbd: 'Ctrl+Shift+F', run: () => openSearch('folder') },
  { name: '바꾸기', kbd: 'Ctrl+H', run: () => openSearch(null, true) },
  { name: '새 탭', kbd: '', run: () => { const w = newTab({ content: '' }); activateTab(w.id); } },
  { name: '파일 열기', kbd: 'Ctrl+O', run: openFile },
  { name: '현재 탭 닫기', kbd: 'Ctrl+W', run: () => active() && closeTab(state.activeId) },
  { name: '폴더 추가', kbd: 'Ctrl+Shift+O', run: addFolder },
  { name: '저장', kbd: 'Ctrl+S', run: () => saveFile(false) },
  { name: '다른 이름으로 저장', kbd: 'Ctrl+Shift+S', run: saveFileAs },
  { name: '설정 열기', kbd: 'Ctrl+,', run: openSettings },
  { name: 'Claude 패널 토글', kbd: 'Ctrl+J', run: () => toggleClaude() },
  { name: '사이드바 토글', kbd: 'Ctrl+B', run: toggleSidebar },
  { name: '글꼴 크게', kbd: 'Ctrl++', run: () => zoom(1) },
  { name: '글꼴 작게', kbd: 'Ctrl+-', run: () => zoom(-1) }
];
let palSel = 0, palFiltered = commands;
function openPalette() { paletteOverlay.classList.remove('hidden'); paletteInput.value = ''; renderPalette(''); paletteInput.focus(); }
function closePalette() { paletteOverlay.classList.add('hidden'); }
function renderPalette(q) {
  q = q.toLowerCase().trim();
  palFiltered = commands.filter(c => c.name.toLowerCase().includes(q));
  palSel = 0; paletteListEl.innerHTML = '';
  palFiltered.forEach((c, i) => {
    const li = document.createElement('li');
    if (i === 0) li.classList.add('sel');
    const a = document.createElement('span'); a.textContent = c.name;
    const k = document.createElement('span'); k.className = 'kbd'; k.textContent = c.kbd;
    li.append(a, k);
    li.addEventListener('click', () => { closePalette(); c.run(); });
    li.addEventListener('mousemove', () => selPalette(i));
    paletteListEl.appendChild(li);
  });
}
function selPalette(i) { palSel = i; [...paletteListEl.children].forEach((li, idx) => li.classList.toggle('sel', idx === i)); }
paletteInput.addEventListener('input', () => renderPalette(paletteInput.value));
paletteInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); selPalette(Math.min(palSel + 1, palFiltered.length - 1)); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); selPalette(Math.max(palSel - 1, 0)); }
  else if (e.key === 'Enter') { e.preventDefault(); const c = palFiltered[palSel]; closePalette(); c && c.run(); }
  else if (e.key === 'Escape') closePalette();
});
paletteOverlay.addEventListener('click', (e) => { if (e.target === paletteOverlay) closePalette(); });

/* ============================================================ 설정 / 테마 */
const THEMES = [
  { id: 'dark', name: '옵시디언 다크', sw: ['#1e1e1e', '#e5c07b', '#61afef', '#98c379'] },
  { id: 'light', name: '라이트', sw: ['#ffffff', '#b3261e', '#1a56d6', '#0a7d4d'] },
  { id: 'nord', name: '노르드 (Nord)', sw: ['#2e3440', '#ebcb8b', '#81a1c1', '#a3be8c'] },
  { id: 'solarized', name: '솔라라이즈드 라이트', sw: ['#fdf6e3', '#b58900', '#268bd2', '#859900'] }
];
const settingsOverlay = $('#settings-overlay');
function openSettings() { settingsOverlay.classList.remove('hidden'); renderThemeGrid(); }
function closeSettings() { settingsOverlay.classList.add('hidden'); }
function renderThemeGrid() {
  const grid = $('#theme-grid'); grid.innerHTML = '';
  THEMES.forEach(th => {
    const card = document.createElement('div');
    card.className = 'theme-card' + (state.settings.theme === th.id ? ' sel' : '');
    const sw = document.createElement('div'); sw.className = 'theme-swatch';
    th.sw.forEach(c => { const s = document.createElement('span'); s.style.background = c; sw.appendChild(s); });
    const nm = document.createElement('div'); nm.className = 'tc-name'; nm.textContent = th.name;
    card.append(sw, nm);
    card.addEventListener('click', () => { state.settings.theme = th.id; applySettings(); renderThemeGrid(); persist(); });
    grid.appendChild(card);
  });
}
function applySettings() {
  const s = state.settings;
  document.documentElement.dataset.theme = s.theme;
  document.documentElement.style.setProperty('--efs', s.fontSize + 'px');
  // 줄 높이를 정수 px로 고정 — textarea(줄박스 반올림)와 거터/하이라이트 간 누적 어긋남 방지
  document.documentElement.style.setProperty('--elh', Math.round(s.fontSize * (s.lineSpacing || 1.5)) + 'px');
  document.documentElement.style.setProperty('--plh', String(s.lineSpacing || 1.5)); // 미리보기 행간
  document.body.classList.toggle('no-syntax', !s.syntax);
  if (typeof editor !== 'undefined') editor.spellcheck = !!s.spellcheck;
  if (typeof editor2 !== 'undefined' && editor2) editor2.spellcheck = !!s.spellcheck;
  if (typeof panes !== 'undefined') panes.classList.toggle('horizontal', !!s.splitHoriz);
  const sd = $('#btn-split-dir'); if (sd) sd.textContent = s.splitHoriz ? '⬍' : '⬌';
  $('#set-fontsize').value = s.fontSize;
  $('#fontsize-val').textContent = s.fontSize + 'px';
  $('#set-autosave').checked = s.autoSave;
  $('#set-syntax').checked = s.syntax;
  if ($('#set-linespacing')) { $('#set-linespacing').value = s.lineSpacing; $('#linespacing-val').textContent = (s.lineSpacing).toFixed(2); }
  if ($('#set-spellcheck')) $('#set-spellcheck').checked = !!s.spellcheck;
  applyPuppyImage();
  applyHighlight(); syncHighlightScroll();
  if (state.split2Id) { applyHighlight2(); syncHighlight2Scroll(); }
}
function applyPuppyImage() {
  const puppy = $('#puppy'); const img = $('#puppy-custom');
  if (!puppy || !img) return;
  if (state.settings.puppyImage) { img.src = state.settings.puppyImage; puppy.classList.add('custom'); }
  else { puppy.classList.remove('custom'); img.removeAttribute('src'); }
}
function zoom(d) { state.settings.fontSize = Math.max(11, Math.min(24, state.settings.fontSize + d)); applySettings(); persist(); }
$('#set-fontsize').addEventListener('input', (e) => { state.settings.fontSize = +e.target.value; applySettings(); persist(); });
$('#set-autosave').addEventListener('change', (e) => { state.settings.autoSave = e.target.checked; persist(); });
$('#set-syntax').addEventListener('change', (e) => { state.settings.syntax = e.target.checked; applySettings(); persist(); });
$('#set-linespacing').addEventListener('input', (e) => { state.settings.lineSpacing = +e.target.value; applySettings(); persist(); });
$('#set-spellcheck').addEventListener('change', (e) => { state.settings.spellcheck = e.target.checked; applySettings(); persist(); });
$('#btn-close-settings').addEventListener('click', closeSettings);
$('#btn-settings').addEventListener('click', openSettings);
settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) closeSettings(); });

/* ============================================================ 검색 / 바꾸기 */
const searchInput = $('#search-input');
const replaceInput = $('#replace-input');
const searchResults = $('#search-results');
const searchSummary = $('#search-summary');

function switchView(v) {
  const search = v === 'search';
  $('#explorer-view').classList.toggle('hidden', search);
  $('#search-view').classList.toggle('hidden', !search);
  $('#vs-explorer').classList.toggle('active', !search);
  $('#vs-search').classList.toggle('active', search);
}
function updateScopeButtons() {
  document.querySelectorAll('.search-scope button').forEach(b => b.classList.toggle('active', b.dataset.scope === state.search.scope));
}
function openSearch(scope, focusReplace) {
  if (sidebar.classList.contains('collapsed')) setSidebarCollapsed(false);
  switchView('search');
  if (scope) { state.search.scope = scope; updateScopeButtons(); }
  if (active()) {
    const s = editor.selectionStart, e = editor.selectionEnd;
    if (e > s) { const t = editor.value.slice(s, e); if (t && !t.includes('\n')) searchInput.value = t; }
  }
  (focusReplace ? replaceInput : searchInput).focus();
  searchInput.select();
  if (searchInput.value) runSearch();
}
function buildRegexLocal(q) {
  try {
    const flags = 'g' + (state.search.caseSensitive ? '' : 'i');
    const pat = state.search.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(pat, flags);
  } catch { return null; }
}
function matchLinesLocal(content, re) {
  const out = [], lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0; let m; const ln = lines[i];
    while ((m = re.exec(ln))) {
      out.push({ line: i, start: m.index, end: m.index + m[0].length, text: ln });
      if (m.index === re.lastIndex) re.lastIndex++;
      if (out.length > 1000) return out;
    }
  }
  return out;
}
async function runSearch() {
  const q = searchInput.value;
  searchResults.innerHTML = ''; searchSummary.textContent = '';
  state.search.flat = []; state.search.cursor = -1; state.search.lastGroups = [];
  if (!q) return;
  const re = buildRegexLocal(q);
  if (!re) { searchSummary.textContent = '정규식 오류'; return; }
  let groups = [], total = 0;
  const scope = state.search.scope;
  if (scope === 'folder') {
    if (!state.vaults.length) { searchSummary.textContent = '열린 폴더가 없습니다'; return; }
    const res = await window.api.search({ roots: state.vaults.map(v => v.root), query: q, caseSensitive: state.search.caseSensitive, regex: state.search.regex });
    if (res.error) { searchSummary.textContent = '정규식 오류'; return; }
    groups = res.results.map(r => ({ path: r.path, name: r.name, matches: r.matches }));
    total = res.total;
  } else {
    const a = active(); if (a) a.content = editor.value;
    const tabs = scope === 'current' ? (a ? [a] : []) : state.tabs;
    for (const t of tabs) {
      const content = t.id === state.activeId ? editor.value : t.content;
      const matches = matchLinesLocal(content, re);
      if (matches.length) { groups.push({ tabId: t.id, path: t.filePath, name: t.name, matches }); total += matches.length; }
    }
  }
  renderSearchResults(groups);
  state.search.lastGroups = groups;
  searchSummary.textContent = total ? `${total}개 일치 · ${groups.length}개 파일` : '결과 없음';
}
function renderSearchResults(groups) {
  searchResults.innerHTML = '';
  state.search.flat = [];
  for (const g of groups) {
    const fileEl = document.createElement('div');
    fileEl.className = 'sr-file'; fileEl.title = g.path || g.name;
    fileEl.innerHTML = `<span>${fileIcon(g.name)} ${escHtml(g.name)}</span><span class="sr-count">${g.matches.length}</span>`;
    fileEl.addEventListener('click', () => openResult(g, g.matches[0]));
    searchResults.appendChild(fileEl);
    for (const m of g.matches) {
      const fi = state.search.flat.length;
      state.search.flat.push({ g, m });
      const row = document.createElement('div'); row.className = 'sr-line'; row.dataset.fi = fi;
      const no = document.createElement('span'); no.className = 'sr-no'; no.textContent = m.line + 1;
      const tx = document.createElement('span'); tx.className = 'sr-text';
      const t = m.text;
      tx.innerHTML = escHtml(t.slice(0, m.start)) + '<span class="hit">' + escHtml(t.slice(m.start, m.end)) + '</span>' + escHtml(t.slice(m.end));
      row.append(no, tx);
      row.addEventListener('click', () => { state.search.cursor = fi; openResult(g, m); });
      searchResults.appendChild(row);
    }
  }
}
async function openResult(g, m) {
  if (g.tabId != null) { if (state.activeId !== g.tabId) activateTab(g.tabId); }
  else if (g.path) await openPath(g.path);
  selectInEditor(m.line, m.start, m.end);
  if (state.mode !== 'editor') requestAnimationFrame(() => highlightInPreview(m.line, searchInput.value));
}
function clearPreviewMarks() {
  preview.querySelectorAll('mark.search-mark').forEach((mk) => {
    const parent = mk.parentNode;
    mk.replaceWith(document.createTextNode(mk.textContent));
    if (parent) parent.normalize();
  });
  preview.querySelectorAll('.search-flash').forEach((e) => e.classList.remove('search-flash'));
}
function highlightInPreview(line, query) {
  clearPreviewMarks();
  if (!query) return;
  const blocks = [...preview.querySelectorAll('[data-line]')];
  let target = null;
  for (const b of blocks) { if (+b.dataset.line <= line) target = b; else break; }
  if (!target) return;
  const re = buildRegexLocal(query);
  if (re && !state.search.regex) wrapMatches(target, re);
  target.classList.add('search-flash');
  target.scrollIntoView({ block: 'center' });
  setTimeout(() => target.classList.remove('search-flash'), 1400);
}
function wrapMatches(root, re) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const mk = document.createElement('mark');
      mk.className = 'search-mark';
      mk.textContent = m[0];
      frag.appendChild(mk);
      last = m.index + m[0].length;
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.replaceWith(frag);
  }
}
function selectInEditor(line, start, end) {
  const lines = editor.value.split('\n');
  let off = 0;
  for (let i = 0; i < line && i < lines.length; i++) off += lines[i].length + 1;
  editor.selectionStart = off + start; editor.selectionEnd = off + end;
  scrollToLine(line);
  if (state.mode !== 'preview') editor.focus();
}
function jumpNext(dir) {
  const flat = state.search.flat;
  if (!flat.length) return;
  state.search.cursor = (state.search.cursor + dir + flat.length) % flat.length;
  document.querySelectorAll('.sr-line.cur').forEach(e => e.classList.remove('cur'));
  const row = searchResults.querySelector(`.sr-line[data-fi="${state.search.cursor}"]`);
  if (row) { row.classList.add('cur'); row.scrollIntoView({ block: 'nearest' }); }
  const { g, m } = flat[state.search.cursor];
  openResult(g, m);
}
function refreshActiveView() { applyHighlight(); updateGutter(); updateCounts(); renderPreview(); buildOutline(); renderTabs(); }
function replaceOne() {
  const q = searchInput.value; if (!q) return;
  const a = active(); if (!a) return;
  const re = buildRegexLocal(q); if (!re) return;
  const val = editor.value;
  re.lastIndex = editor.selectionStart;
  let m = re.exec(val);
  if (!m) { re.lastIndex = 0; m = re.exec(val); }
  if (!m) return;
  const matched = m[0];
  const single = buildRegexLocal(q);
  const replaced = matched.replace(single, replaceInput.value);
  editor.value = val.slice(0, m.index) + replaced + val.slice(m.index + matched.length);
  editor.selectionStart = editor.selectionEnd = m.index + replaced.length;
  onEditorChanged();
  runSearch();
}
async function replaceAll() {
  const q = searchInput.value; if (!q) return;
  const re = buildRegexLocal(q); if (!re) return;
  const rep = replaceInput.value, scope = state.search.scope;
  if (scope === 'folder') {
    const paths = (state.search.lastGroups || []).map(g => g.path).filter(Boolean);
    if (!paths.length) return;
    if (!confirm(`폴더 내 ${paths.length}개 파일에서 모두 바꿉니다. 계속할까요?`)) return;
    const r = await window.api.replaceFiles({ paths, query: q, replacement: rep, caseSensitive: state.search.caseSensitive, regex: state.search.regex });
    for (const t of state.tabs) {
      if (t.filePath && paths.includes(t.filePath)) {
        try { const c = await window.api.readFile(t.filePath); t.content = c; t.savedContent = c; t.dirty = false; if (t.id === state.activeId) editor.value = c; } catch {}
      }
    }
    refreshActiveView();
    searchSummary.textContent = `${r.count}곳 변경 (${r.files}개 파일)`;
    runSearch();
    return;
  }
  let count = 0;
  const a = active(); if (a) a.content = editor.value;
  const tabs = scope === 'current' ? (a ? [a] : []) : state.tabs;
  for (const t of tabs) {
    const content = t.id === state.activeId ? editor.value : t.content;
    const mm = content.match(re); const c = mm ? mm.length : 0;
    if (c) { const nc = content.replace(re, rep); t.content = nc; t.dirty = nc !== t.savedContent; if (t.id === state.activeId) editor.value = nc; count += c; }
  }
  refreshActiveView(); scheduleAutoSave();
  searchSummary.textContent = `${count}곳 변경`;
  runSearch();
}
let searchTimer = null;
searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 180); });
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); jumpNext(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') { e.preventDefault(); switchView('explorer'); editor.focus(); }
});
replaceInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); replaceOne(); } });
document.querySelectorAll('.search-scope button').forEach(b => b.addEventListener('click', () => { state.search.scope = b.dataset.scope; updateScopeButtons(); runSearch(); }));
$('#opt-case').addEventListener('click', () => { state.search.caseSensitive = !state.search.caseSensitive; $('#opt-case').classList.toggle('active', state.search.caseSensitive); runSearch(); });
$('#opt-regex').addEventListener('click', () => { state.search.regex = !state.search.regex; $('#opt-regex').classList.toggle('active', state.search.regex); runSearch(); });
$('#btn-replace-one').addEventListener('click', replaceOne);
$('#btn-replace-all').addEventListener('click', replaceAll);
$('#vs-explorer').addEventListener('click', () => switchView('explorer'));
$('#vs-search').addEventListener('click', () => openSearch(state.search.scope));

/* ============================================================ Claude 패널 */
const claudeState = { sessionId: null, busy: false, scope: 'current', model: 'sonnet' };
const claudePanel = $('#claude-panel');
const claudeResizer = $('#claude-resizer');
const claudeMessages = $('#claude-messages');
const claudeText = $('#claude-text');
const claudeSend = $('#claude-send');
const claudeCtx = $('#claude-ctx');
const claudeScope = $('#claude-scope');
const claudeModel = $('#claude-model');
claudeModel.value = claudeState.model; // 기본 모델 = Sonnet
let claudeReqSeq = 1;

function flattenVaultFiles() {
  const out = [];
  const walk = (nodes) => { for (const n of nodes) { if (n.type === 'dir') walk(n.children); else out.push(n); } };
  for (const v of state.vaults) walk(v.tree);
  return out;
}
function populateClaudeScope() {
  const prev = claudeState.scope;
  claudeScope.innerHTML = '';
  const add = (val, label) => { const o = document.createElement('option'); o.value = val; o.textContent = label; claudeScope.appendChild(o); };
  add('current', '📄 현재 노트');
  if (state.vaults.length) add('folder', '📁 폴더 전체 (.md/.txt)');
  const files = flattenVaultFiles();
  if (files.length) {
    const og = document.createElement('optgroup'); og.label = '특정 파일';
    for (const f of files) { const o = document.createElement('option'); o.value = 'file:' + f.path; o.textContent = f.name; og.appendChild(o); }
    claudeScope.appendChild(og);
  }
  // 이전 선택 유지(가능하면)
  if ([...claudeScope.options].some(o => o.value === prev)) claudeScope.value = prev;
  else { claudeScope.value = 'current'; claudeState.scope = 'current'; }
}

function toggleClaude(force) {
  const show = force !== undefined ? force : claudePanel.classList.contains('hidden');
  claudePanel.classList.toggle('hidden', !show);
  claudeResizer.classList.toggle('hidden', !show);
  if (show) { populateClaudeScope(); updateClaudeCtx(); requestAnimationFrame(() => { buildLineMap(); claudeText.focus(); }); }
}
function updateClaudeCtx() {
  const sc = claudeState.scope;
  let s;
  if (sc === 'folder') { const n = flattenVaultFiles().length; s = `📁 폴더 전체 ${n}개 파일 대상`; }
  else if (sc.startsWith('file:')) { s = `📄 ${sc.slice(5).replace(/^.*[\\/]/, '')} 대상`; }
  else { const t = active(); s = t ? `📄 현재 노트: ${t.name}` : '컨텍스트 없음'; }
  if (claudeState.model) s += ` · 🧠 ${claudeState.model}`;
  claudeCtx.textContent = s;
}
function claudeRemoveEmpty() { const e = claudeMessages.querySelector('.claude-empty'); if (e) e.remove(); }
function claudeScroll() { claudeMessages.scrollTop = claudeMessages.scrollHeight; }
function claudeAddMsg(role) {
  claudeRemoveEmpty();
  const el = document.createElement('div');
  el.className = 'cmsg ' + role;
  claudeMessages.appendChild(el);
  claudeScroll();
  return el;
}
function claudeRenderAssistant(el, text, proposed, targetId) {
  el.innerHTML = `<div class="markdown-body"></div><div class="cmsg-meta"><button class="cmsg-copy">📋 복사</button></div>`;
  el.querySelector('.markdown-body').innerHTML = marked.parse(text);
  el.querySelector('.cmsg-copy').addEventListener('click', async () => {
    await window.api.copyText(proposed || text);
    toast('복사했습니다');
  });
  if (proposed != null) {
    const apply = document.createElement('div');
    apply.className = 'cmsg-apply';
    let label = '노트';
    if (typeof targetId === 'string' && targetId.startsWith('__file:')) label = targetId.slice(7).replace(/^.*[\\/]/, '');
    else { const tab = state.tabs.find(t => t.id === targetId); if (tab) label = tab.name; }
    apply.innerHTML = `<button class="apply-btn">✅ 반영하기</button><span class="apply-hint">${escHtml(label)} 에 적용</span>`;
    apply.querySelector('.apply-btn').addEventListener('click', () => applyProposed(targetId, proposed, apply));
    el.appendChild(apply);
  }
  claudeScroll();
}
async function applyProposed(targetId, text, applyEl) {
  // 아직 열려있지 않은 파일이면 먼저 연다 ("__file:<path>")
  if (typeof targetId === 'string' && targetId.startsWith('__file:')) {
    await openPath(targetId.slice(7));
    targetId = state.activeId;
  }
  if (!applyContentHist(targetId, text)) return;
  toast('노트에 반영했습니다');
  if (applyEl) applyEl.innerHTML = '<span class="apply-done">✅ 반영되어 저장됨</span><span class="apply-hint">되돌리기: Ctrl+Z 또는 툴바 ↩</span>';
}
function claudeUpdateSendBtn() { claudeSend.disabled = claudeState.busy; claudeSend.textContent = claudeState.busy ? '…' : '전송'; }
function newClaudeChat() {
  claudeState.sessionId = null;
  claudeMessages.innerHTML = '<div class="claude-empty">새 대화입니다. 현재 노트에 대해 물어보세요.</div>';
}
const NOTE_START = '===NOTE_START===';
const NOTE_END = '===NOTE_END===';
function parseClaudeReply(text, currentContent) {
  // 수정안 마커가 있으면 분리. (코드펜스로 감싸 온 경우도 허용)
  const re = new RegExp(NOTE_START + '\\s*\\n?([\\s\\S]*?)\\n?\\s*' + NOTE_END);
  const m = text.match(re);
  if (!m) return { explanation: text, proposed: null };
  let proposed = m[1];
  // 마커 안쪽이 ```로 감싸졌으면 벗겨낸다
  const fence = proposed.match(/^```[\w-]*\n([\s\S]*?)\n```\s*$/);
  if (fence) proposed = fence[1];
  let explanation = text.replace(m[0], '').trim();
  if (!explanation) explanation = '수정안을 준비했어요. 아래 **반영하기**로 적용하세요.';
  if (proposed.trim() === (currentContent || '').trim()) return { explanation: text.replace(m[0], '').trim() || text, proposed: null };
  return { explanation, proposed };
}
async function sendClaude() {
  const msg = claudeText.value.trim();
  if (!msg || claudeState.busy) return;
  const sc = claudeState.scope;
  const t = active();
  const vaultRoot = state.vaults[0]?.root;

  // 대상별 컨텍스트 구성
  let ctx = '', targetId = null, curContent = null, cwd, editMarkerNote;
  if (sc === 'folder') {
    if (!state.vaults.length) { toast('폴더를 먼저 여세요'); return; }
    cwd = vaultRoot;
    const names = flattenVaultFiles().map(f => '- ' + f.name).join('\n');
    ctx = `[질문 대상] 아래 폴더의 모든 .md/.txt 파일. 필요한 파일은 Read/Glob/Grep 도구로 직접 열어 확인하세요.\n폴더: ${vaultRoot}\n파일 목록:\n${names}\n\n`;
    editMarkerNote = false; // 폴더 전체는 단일 노트 반영 대상이 모호 → 수정안은 코드블록으로
  } else if (sc.startsWith('file:')) {
    const fp = sc.slice(5);
    let content = '';
    try { content = await window.api.readFile(fp); } catch { toast('파일을 읽을 수 없습니다'); return; }
    cwd = vaultRoot || fp.replace(/[\\/][^\\/]*$/, '');
    curContent = content;
    const exist = state.tabs.find(x => x.filePath === fp);
    targetId = exist ? exist.id : null; // 열려있지 않으면 반영 시 새로 연다
    targetId = targetId !== null ? targetId : '__file:' + fp;
    ctx = `[질문 대상 파일] ${fp.replace(/^.*[\\/]/, '')} (${fp})\n` + '```markdown\n' + content.slice(0, 14000) + '\n```\n\n';
    editMarkerNote = true;
  } else {
    if (!t) { toast('열린 노트가 없습니다'); return; }
    cwd = vaultRoot || (t.filePath ? t.filePath.replace(/[\\/][^\\/]*$/, '') : undefined);
    curContent = editor.value;
    targetId = state.activeId;
    ctx = `[질문 대상 = 현재 노트] ${t.name}${t.filePath ? ' (' + t.filePath + ')' : ''}\n` + '```markdown\n' + curContent.slice(0, 14000) + '\n```\n\n';
    editMarkerNote = true;
  }

  claudeText.value = '';
  const editRule = editMarkerNote
    ? `- 노트 내용 자체를 수정·추가·삭제해야 하는 요청이면, 먼저 무엇을 어떻게 바꿨는지 1~2줄로 설명한 뒤, 수정이 반영된 "노트 전체"를 아래 마커로 정확히 감싸 출력하세요(마커 줄에는 다른 글자 금지):\n${NOTE_START}\n(수정된 전체 마크다운 본문)\n${NOTE_END}\n- 수정이 필요 없으면 위 마커를 절대 출력하지 마세요.`
    : '- 여러 파일이 대상이므로 파일을 직접 수정하지 말고, 수정안이 있으면 어떤 파일을 어떻게 바꿀지 설명과 코드블록으로 제시만 하세요.';
  const fullPrompt = ctx + `사용자 요청:\n${msg}\n\n지침: 한국어로 답하세요.\n- 단순 질문·요약·설명 요청이면 그냥 답하세요.\n${editRule}`;

  claudeAddMsg('user').textContent = msg;
  const bubble = claudeAddMsg('assistant');
  const body = document.createElement('div');
  body.className = 'markdown-body streaming';
  body.textContent = '…';
  bubble.appendChild(body);
  claudeState.busy = true; claudeUpdateSendBtn();

  const id = claudeReqSeq++;
  let raw = '', finalText = null, rafPending = false, finished = false;
  const renderLive = () => {
    rafPending = false;
    const disp = raw.split(NOTE_START)[0]; // 수정안 마커 이전(설명)만 라이브 표시
    body.innerHTML = marked.parse(disp || '…');
    claudeScroll();
  };
  const off = window.api.onClaudeStream((data) => {
    if (data.id !== id || finished) return;
    if (data.type === 'delta') {
      raw += data.text;
      if (!rafPending) { rafPending = true; requestAnimationFrame(renderLive); }
    } else if (data.type === 'result') {
      finalText = data.text;
      if (data.sessionId) claudeState.sessionId = data.sessionId;
    } else if (data.type === 'error') {
      finalize({ ok: false, text: data.text });
    } else if (data.type === 'done') {
      if (data.sessionId) claudeState.sessionId = data.sessionId;
      const text = (finalText != null ? finalText : raw);
      if (!text.trim()) finalize({ ok: false, text: (data.err || '').trim() || '(응답 없음)' });
      else finalize({ ok: true, text });
    }
  });
  function finalize(res) {
    if (finished) return;
    finished = true;
    off();
    claudeState.busy = false; claudeUpdateSendBtn();
    bubble.classList.remove('thinking');
    bubble.innerHTML = '';
    if (res.ok) {
      const { explanation, proposed } = parseClaudeReply(res.text, curContent);
      claudeRenderAssistant(bubble, explanation, proposed, targetId);
    } else {
      bubble.classList.add('error'); bubble.textContent = res.text || '오류가 발생했습니다.';
    }
  }
  window.api.startClaudeStream({ id, prompt: fullPrompt, cwd, sessionId: claudeState.sessionId, model: claudeState.model });
}
$('#btn-claude').addEventListener('click', () => toggleClaude());
$('#claude-close').addEventListener('click', () => toggleClaude(false));
$('#claude-new').addEventListener('click', newClaudeChat);
claudeSend.addEventListener('click', sendClaude);
claudeScope.addEventListener('change', () => { claudeState.scope = claudeScope.value; updateClaudeCtx(); });
claudeModel.addEventListener('change', () => { claudeState.model = claudeModel.value; updateClaudeCtx(); });
claudeText.addEventListener('focus', updateClaudeCtx);
claudeText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendClaude(); }
});

/* ============================================================ 사이드바 */
function setSidebarCollapsed(c) {
  sidebar.classList.toggle('collapsed', c);
  sidebarStrip.classList.toggle('hidden', !c);
  persist();
}
function toggleSidebar() { setSidebarCollapsed(!sidebar.classList.contains('collapsed')); }
$('#btn-collapse-sidebar').addEventListener('click', () => setSidebarCollapsed(true));
$('#btn-toggle-sidebar-main').addEventListener('click', toggleSidebar);
sidebarStrip.addEventListener('click', () => setSidebarCollapsed(false));
$('#btn-open-folder').addEventListener('click', addFolder);
$('#btn-zoom-in').addEventListener('click', () => zoom(1));
$('#btn-zoom-out').addEventListener('click', () => zoom(-1));
document.querySelectorAll('.section-head[data-collapse]').forEach(h => {
  h.addEventListener('click', () => h.parentElement.classList.toggle('collapsed'));
});

/* ============================================================ 리사이저 */
function makeResizer(handle, onMove) {
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const move = (ev) => onMove(ev);
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.style.cursor = ''; buildLineMap(); persist(); };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up); document.body.style.cursor = 'col-resize';
  });
}
makeResizer($('#sidebar-resizer'), (e) => { sidebar.style.width = Math.max(140, Math.min(480, e.clientX)) + 'px'; });
makeResizer($('#pane-resizer'), (e) => {
  const rect = panes.getBoundingClientRect();
  const horiz = panes.classList.contains('horizontal');
  const pct = horiz
    ? Math.max(0.15, Math.min(0.85, (e.clientY - rect.top) / rect.height))
    : Math.max(0.15, Math.min(0.85, (e.clientX - rect.left) / rect.width));
  $('#editor-pane').style.flex = pct; previewPane.style.flex = 1 - pct; editor2Pane.style.flex = 1 - pct;
});
makeResizer(claudeResizer, (e) => {
  claudePanel.style.width = Math.max(280, Math.min(700, window.innerWidth - e.clientX)) + 'px';
});

/* ============================================================ 타이틀바 / 창 컨트롤 */
function setDocTitle(name) {
  document.title = name + ' - MD Viewer';
  const el = document.getElementById('tb-doc');
  if (el) el.textContent = name || '';
}
$('#win-min').addEventListener('click', () => window.api.winMinimize());
$('#win-max').addEventListener('click', () => window.api.winMaxToggle());
$('#win-close').addEventListener('click', () => window.api.winClose());
window.api.onWinMaximized((max) => {
  const b = $('#win-max');
  b.title = max ? '이전 크기로' : '최대화';
  b.innerHTML = max
    ? '<svg width="11" height="11" viewBox="0 0 11 11"><path d="M3 1 h7 v7 h-2" fill="none" stroke="currentColor"/><rect x="1" y="3" width="7" height="7" fill="none" stroke="currentColor"/></svg>'
    : '<svg width="11" height="11" viewBox="0 0 11 11"><rect x="1.5" y="1.5" width="8" height="8" fill="none" stroke="currentColor"/></svg>';
});

/* ============================================================ 외부 파일 열기 (드래그&드롭 / 파일 연결) */
async function openExternalFile(filePath) {
  if (!filePath) return;
  const dir = filePath.replace(/[\\/][^\\/]*$/, '');
  if (dir && !state.vaults.some(v => filePath.toLowerCase().startsWith(v.root.toLowerCase()))) {
    await addVaultRoot(dir, { silent: true }); // 폴더가 새로우면 자동 추가
  }
  await openPath(filePath);
}
let appInitialized = false, pendingExternal = null;
window.api.onOpenFileExternal((p) => {
  if (appInitialized) openExternalFile(p);
  else pendingExternal = p; // init 완료 후 처리(세션 복원이 덮어쓰지 않도록)
});

// 드래그&드롭
window.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files || [])];
  const OPEN = ['md', 'markdown', 'mdown', 'txt', 'json', 'html', 'htm'];
  let opened = 0;
  for (const f of files) {
    const p = window.api.getPathForFile(f) || f.path || ''; // Electron 32+ : webUtils
    if (!p) continue;
    const ext = (p.match(/\.([^.]*)$/) || [, ''])[1].toLowerCase();
    if (OPEN.includes(ext)) { openExternalFile(p); opened++; }
  }
  if (files.length && !opened) toast('열 수 있는 형식이 아닙니다 (.md/.txt/.json/.html)');
});

/* ============================================================ Ctrl + 휠로 글꼴 크기 */
window.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  zoom(e.deltaY < 0 ? 1 : -1);
}, { passive: false });

/* ============================================================ 뛰어다니는 말티즈 🐶 */
(function puppyEasterEgg() {
  const puppy = $('#puppy');
  if (!puppy) return;
  // mode 0 = 말티즈 달리기, 1 = 깨댕이 춤, 2 = 깨댕이 멈춤
  let mode = 0, x = 0, dir = 1, t = 0;
  const MAX = 150, SPEED = 1.2;
  function frame() {
    t++;
    if (mode === 0) {
      x += dir * SPEED;
      if (x >= MAX) { x = MAX; dir = -1; }
      else if (x <= 0) { x = 0; dir = 1; }
      const bob = -Math.abs(Math.sin(t * 0.32)) * 3;
      puppy.style.transform = `translate(${x.toFixed(1)}px, ${bob.toFixed(1)}px) scaleX(${dir})`;
    } else {
      // 깨댕이 모드: 제자리(왼쪽 끝)로 부드럽게 복귀, 춤은 CSS 가 처리
      x += (0 - x) * 0.2;
      if (x < 0.6) x = 0;
      puppy.style.transform = `translate(${x.toFixed(1)}px, 0px)`;
    }
    requestAnimationFrame(frame);
  }
  puppy.addEventListener('click', () => {
    mode = (mode + 1) % 3;
    puppy.dataset.mode = String(mode);
    puppy.classList.toggle('running', mode === 0);
    if (mode === 0) { x = 0; dir = 1; }
  });
  puppy.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    showCtxMenu(e.clientX, e.clientY, [
      { label: '🖼 이미지/움짤 넣기…', action: async () => { const u = await window.api.openImage(); if (u) { state.settings.puppyImage = u; applyPuppyImage(); persist(); toast('강아지 이미지를 바꿨습니다'); } } },
      { label: '🐶 기본 강아지로', action: () => { state.settings.puppyImage = ''; applyPuppyImage(); persist(); toast('기본 강아지로 되돌렸습니다'); } }
    ]);
  });
  frame();
})();

/* ============================================================ 미니 컨텍스트 메뉴 + 우클릭 연동 */
function showCtxMenu(x, y, items) {
  const el = $('#ctxmenu');
  el.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.textContent = it.label;
    b.addEventListener('click', () => { hideCtxMenu(); it.action(); });
    el.appendChild(b);
  }
  el.style.left = Math.min(x, window.innerWidth - 180) + 'px';
  el.style.top = Math.min(y, window.innerHeight - items.length * 36 - 12) + 'px';
  el.classList.remove('hidden');
}
function hideCtxMenu() { $('#ctxmenu').classList.add('hidden'); }
window.addEventListener('mousedown', (e) => { if (!e.target.closest('#ctxmenu')) hideCtxMenu(); });
window.addEventListener('blur', hideCtxMenu);
// 편집기 우클릭 메뉴(네이티브)에서 보낸 동작
window.api.onCtxFormat((fmt) => { editor.focus(); applyFormat(fmt); });
window.api.onCtxClaude((text) => {
  toggleClaude(true);
  if (text) claudeText.value = text.length > 400 ? text : `다음 내용에 대해: \n${text}\n\n`;
  claudeText.focus();
});

/* ============================================================ 분할 편집(두 파일) */
const editor2 = $('#editor2');
const hl2 = $('#editor2-highlight');
const gutter2 = $('#gutter2');
const editor2Pane = $('#editor2-pane');
let focusedEditor = 1;        // 1=주 편집기, 2=보조 편집기 (저장 대상 결정)
let autoSave2Timer = null;
let draggingTabId = null;     // 탭 드래그 중인 탭 id
let draggingTreePath = null;  // 왼쪽 탐색기에서 드래그 중인 파일 경로

const split2Tab = () => state.tabs.find(t => t.id === state.split2Id);

function applyHighlight2() {
  if (!state.settings.syntax) return;
  const t = split2Tab(); if (!t) return;
  hl2.innerHTML = buildHL(editor2.value, t);
}
function updateGutter2() {
  const count = editor2.value.split('\n').length;
  const cur = gutter2.childElementCount;
  if (cur === count) return;
  if (count > cur) {
    const frag = document.createDocumentFragment();
    for (let i = cur + 1; i <= count; i++) { const d = document.createElement('div'); d.textContent = i; frag.appendChild(d); }
    gutter2.appendChild(frag);
  } else { while (gutter2.childElementCount > count) gutter2.lastChild.remove(); }
}
function syncHighlight2Scroll() { hl2.scrollTop = editor2.scrollTop; hl2.scrollLeft = editor2.scrollLeft; }
function syncGutter2() { gutter2.scrollTop = editor2.scrollTop; }

// 분리된 탭을 상단 탭바 래퍼의 오른쪽 끝에 고정 표시(왼쪽 탭과 같은 높이, 스크롤과 무관하게 항상 보임)
function renderSplit2Tab() {
  const wrap = $('#tabbar-wrap');
  if (wrap) wrap.querySelectorAll('.split2-tab').forEach(n => n.remove());
  const t = split2Tab();
  if (!t || !wrap) return;
  const el = document.createElement('div');
  el.className = 'tab active split2-tab';
  el.title = '오른쪽 분할 편집';
  const icon = document.createElement('span');
  icon.className = 'ticon'; icon.textContent = fileIcon(t.name);
  el.appendChild(icon);
  const name = document.createElement('span');
  name.className = 'tname'; name.textContent = t.name; name.title = '더블클릭하면 이름 변경';
  name.addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(t, name); });
  el.appendChild(name);
  if (t.dirty) { const d = document.createElement('span'); d.className = 'tdirty'; d.textContent = '●'; el.appendChild(d); }
  const close = document.createElement('span');
  close.className = 'tclose'; close.textContent = '✕'; close.title = '분할 닫기 (왼쪽 탭으로 되돌리기)';
  close.addEventListener('click', (e) => { e.stopPropagation(); closeSplit2(); });
  el.appendChild(close);
  el.addEventListener('click', () => editor2.focus());
  wrap.appendChild(el);
}
function loadEditor2(t) {
  editor2.value = t.content;
  applyHighlight2(); updateGutter2();
  editor2.scrollTop = 0; editor2.scrollLeft = 0;
  syncHighlight2Scroll(); syncGutter2();
}
function onEditor2Changed() {
  const t = split2Tab(); if (!t) return;
  t.content = editor2.value;
  t.dirty = t.content !== t.savedContent;
  applyHighlight2(); updateGutter2();
  renderTabs();
  // 자동 저장
  if (state.settings.autoSave && t.filePath && t.dirty) {
    clearTimeout(autoSave2Timer);
    autoSave2Timer = setTimeout(() => saveEditor2(true), 1500);
  }
}
async function saveEditor2(silent) {
  const t = split2Tab(); if (!t) return;
  if (!t.filePath) { toast('새 파일은 왼쪽 편집기로 옮겨 저장하세요'); return; }
  await window.api.writeFile(t.filePath, editor2.value);
  t.savedContent = editor2.value; t.dirty = false; renderTabs();
  statusAutosave.textContent = silent ? '✓ 자동 저장됨' : '✓ 저장됨';
  setTimeout(() => { if (statusAutosave.textContent.includes('저장됨')) statusAutosave.textContent = ''; }, 2000);
}

function openSplit2(tabId) {
  const t = state.tabs.find(x => x.id === tabId);
  if (!t) return;
  // 같은 파일을 양쪽에 둘 수 없음 → 끌어온 탭이 현재 활성 탭이면 주 편집기를 다른 탭으로
  if (tabId === state.activeId) {
    const other = state.tabs.find(x => x.id !== tabId);
    if (!other) { toast('분할 편집하려면 탭이 2개 이상 필요합니다'); return; }
    activateTab(other.id);
  }
  state.split2Id = tabId;
  // 왼쪽은 편집기 상태로 전환(미리보기였다면)
  state.mode = 'editor';
  statusMode.textContent = modeLabels['editor'];
  document.body.classList.remove('preview-only');
  document.querySelectorAll('.mode-switch button').forEach(b => b.classList.toggle('active', b.dataset.mode === 'editor'));
  panes.dataset.mode = 'split-edit';
  editor2Pane.classList.remove('hidden');
  $('#editor-pane').style.flex = ''; previewPane.style.flex = ''; editor2Pane.style.flex = '';
  loadEditor2(t);
  applyHighlight();
  renderTabs();
  requestAnimationFrame(() => editor.focus());
  persist();
}
async function openSplit2ByPath(filePath) {
  if (!filePath) return;
  let t = state.tabs.find(x => x.filePath === filePath);
  if (!t) {
    try { const content = await window.api.readFile(filePath); t = newTab({ filePath, content }); }
    catch { toast('파일을 열 수 없습니다: ' + filePath); return; }
  }
  openSplit2(t.id);
  revealInTree(filePath);
}
function closeSplit2() {
  if (!state.split2Id) return;
  state.split2Id = null;
  editor2Pane.classList.add('hidden');
  panes.dataset.mode = state.mode;
  focusedEditor = 1;
  renderTabs();
  editor.focus();
  persist();
}

editor2.addEventListener('input', onEditor2Changed);
editor2.addEventListener('scroll', () => { syncGutter2(); syncHighlight2Scroll(); });
editor2.addEventListener('focus', () => { focusedEditor = 2; });
editor.addEventListener('focus', () => { focusedEditor = 1; });
editor2.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); editor.focus(); closeSplit2(); return; }
  // 탭 입력(4칸) — 주 편집기와 동일하게
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = editor2.selectionStart, en = editor2.selectionEnd;
    const v = editor2.value;
    editor2.value = v.slice(0, s) + '    ' + v.slice(en);
    editor2.selectionStart = editor2.selectionEnd = s + 4;
    onEditor2Changed();
  }
});
// 탭을 오른쪽으로 끌어다 놓으면 분할 편집
const splitHint = $('#split-drop-hint');
function showSplitHint(on) { if (splitHint) splitHint.classList.toggle('hidden', !on); }
panes.addEventListener('dragover', (e) => {
  if (draggingTabId == null && draggingTreePath == null) return;
  e.preventDefault(); e.stopPropagation();
  e.dataTransfer.dropEffect = draggingTreePath != null ? 'copy' : 'move';
  const r = panes.getBoundingClientRect();
  showSplitHint((e.clientX - r.left) > r.width * 0.5);
});
panes.addEventListener('dragleave', (e) => { if (e.target === panes) showSplitHint(false); });
panes.addEventListener('drop', (e) => {
  if (draggingTabId == null && draggingTreePath == null) return;
  e.preventDefault(); e.stopPropagation();
  const r = panes.getBoundingClientRect();
  const right = (e.clientX - r.left) > r.width * 0.5;
  const tabId = draggingTabId, treePath = draggingTreePath;
  draggingTabId = null; draggingTreePath = null; showSplitHint(false);
  if (right) {
    if (tabId != null) openSplit2(tabId);
    else if (treePath) openSplit2ByPath(treePath);
  } else if (treePath) {
    openPath(treePath); // 왼쪽 절반에 놓으면 주 편집기에서 일반 열기
  }
});

/* ============================================================ 단축키 */
window.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl) return;
  const k = e.key.toLowerCase();
  if (k === 'p') { e.preventDefault(); openPalette(); }
  else if (e.key === '1') { e.preventDefault(); setMode('editor'); }
  else if (e.key === '2') { e.preventDefault(); setMode('split'); }
  else if (e.key === '3') { e.preventDefault(); setMode('preview'); }
  else if (e.key === '4') { e.preventDefault(); toggleSplitDir(); }
  else if (e.shiftKey && k === 'f') { e.preventDefault(); openSearch('folder'); }
  else if (k === 'f') { e.preventDefault(); openSearch('current'); }
  else if (k === 'h') { e.preventDefault(); openSearch(null, true); }
  else if (e.shiftKey && k === 'o') { e.preventDefault(); addFolder(); }
  else if (k === 'o') { e.preventDefault(); openFile(); }
  else if (e.shiftKey && k === 's') { e.preventDefault(); saveFileAs(); }
  else if (k === 's') { e.preventDefault(); saveFile(false); }
  else if (k === 'w') { e.preventDefault(); active() && closeTab(state.activeId); }
  else if (k === 'z' && !e.shiftKey) {
    const ae = document.activeElement, id = ae && ae.id;
    if (id === 'claude-text' || id === 'search-input' || id === 'replace-input' || id === 'palette-input') return;
    e.preventDefault(); undoHistory();
  }
  else if ((k === 'z' && e.shiftKey) || k === 'y') {
    const ae = document.activeElement, id = ae && ae.id;
    if (id === 'claude-text' || id === 'search-input' || id === 'replace-input' || id === 'palette-input') return;
    e.preventDefault(); redoHistory();
  }
  else if (k === 'b') { e.preventDefault(); toggleSidebar(); }
  else if (k === 'j') { e.preventDefault(); toggleClaude(); }
  else if (k === ',') { e.preventDefault(); openSettings(); }
  else if (e.key === '=' || e.key === '+') { e.preventDefault(); zoom(1); }
  else if (e.key === '-') { e.preventDefault(); zoom(-1); }
});
window.addEventListener('beforeunload', (e) => {
  if (state.tabs.some(t => t.dirty)) { e.preventDefault(); e.returnValue = ''; }
});

/* ============================================================ 초기화 */
// 홈 화면 기본 내용 — 앱 폴더의 home.md 가 없을 때만 사용하는 폴백
const WELCOME_FALLBACK = `# 📝 MD Viewer

왼쪽 위 **＋📂** 로 폴더를 추가하거나 파일을 끌어다 놓아 시작하세요.

> 홈 화면은 앱 폴더의 \`home.md\` 파일로 바꿀 수 있습니다.
`;

async function init() {
  const s = loadSession();
  if (s.settings) state.settings = { ...state.settings, ...s.settings };
  applySettings();
  if (s.sidebarWidth) sidebar.style.width = s.sidebarWidth;
  if (s.sidebarCollapsed) setSidebarCollapsed(true);

  // 폴더 복원
  if (Array.isArray(s.vaults)) {
    const seenRoots = new Set();
    for (const root of s.vaults) {
      const key = (root || '').toLowerCase();
      if (!root || seenRoots.has(key)) continue; // 중복 폴더 제거
      seenRoots.add(key);
      try { const data = await window.api.readTree(root); state.vaults.push({ root, name: data.name, tree: data.tree, collapsed: false }); window.api.watchFolder(root); }
      catch {}
    }
  }
  renderVaults();

  // 탭 복원
  let restored = false;
  if (Array.isArray(s.openFiles) && s.openFiles.length) {
    for (const fp of s.openFiles) {
      try { const c = await window.api.readFile(fp); newTab({ filePath: fp, content: c }); restored = true; } catch {}
    }
  }
  if (!restored) {
    let home = null;
    try { home = await window.api.readHome(); } catch {}
    const w = newTab({ content: home || WELCOME_FALLBACK });
    w.name = '홈'; // 홈 탭 이름
  }

  let act = state.tabs[0];
  if (s.activeFile) { const f = state.tabs.find(t => t.filePath === s.activeFile); if (f) act = f; }
  state.activeId = act.id;
  activateTab(act.id);
  if (act.filePath) revealInTree(act.filePath);
  setMode(s.mode || 'preview');
  appInitialized = true;
  if (pendingExternal) { openExternalFile(pendingExternal); pendingExternal = null; }
}
init();
