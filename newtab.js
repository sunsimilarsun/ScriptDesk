// 起始页：双模式多实例画布。查看模式秒开读缓存；编辑模式支持拖拽、增删、配置。
import { WIDGETS, WIDGET_MAP, createInstance } from './core/registry.js';
import { getLayout, saveLayout, getAllCache, newInstanceId } from './core/storage.js';
import { buildExport, redactLayout, validateImport, exportFilename, downloadJson } from './core/config-io.js';

const $ = (id) => document.getElementById(id);
const grid = $('grid');
const ICONS = { subinfo: '📶', telecom: '📱', 'ai-balance': '🤖', hotlist: '🔥', 'generic-json': '🔢', countdown: '⏳', rss: '📰', 'github-heatmap': '🟩', market: '💱', 'network-status': '🌐', subscription: '🗓️' };
const DESCS = {
  subinfo: '订阅流量与到期',
  telecom: '话费 / 流量 / 语音三环',
  'ai-balance': 'DeepSeek / 硅基流动 / OpenRouter 等余额与日耗',
  hotlist: 'V2EX / Hacker News',
  'generic-json': '任意 API 取值',
  countdown: '倒数日与快捷入口',
  rss: 'RSS / Atom 订阅聚合',
  'github-heatmap': 'GitHub 提交热力图与连续天数',
  market: '汇率 / 加密行情 / 指数',
  'network-status': '直连 / 代理探测',
  subscription: 'Codex / ChatGPT 套餐限额'
};

const state = { mode: 'view', layout: [], cache: {}, editingId: null, draggingId: null };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 轻量 toast 提示（复制 IP、导入导出等）
let _toastTimer = null;
function showToast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

async function load() {
  state.layout = await getLayout();
  state.cache = await getAllCache(state.layout);
}

function getInstance(id) {
  return state.layout.find((i) => i.instanceId === id);
}

// ---------- 渲染 ----------
function renderGrid() {
  grid.innerHTML = '';
  for (const inst of state.layout) {
    const widget = WIDGET_MAP[inst.type];
    if (!widget) continue;
    const rec = state.cache[`cache:${inst.instanceId}`] || {};
    const card = document.createElement('section');
    card.className = 'widget-card';
    card.dataset.instanceId = inst.instanceId;
    card.dataset.size = inst.size || widget.defaultSize || 'small';
    card.draggable = state.mode === 'edit';
    if (inst.linkUrl && state.mode === 'view') card.style.cursor = 'pointer';

    // 卡片内容：静态组件直接 render(null)，网络组件用缓存
    // 第 4 个参数传缓存记录（含 error/updatedAt），供电信卡显示「已过期·点击续期」
    const hasFetch = typeof widget.fetchData === 'function';
    if (!hasFetch || rec.data) {
      const size = inst.size || widget.defaultSize || 'small';
      const renderFn = (size === 'small' && widget.renderSmall) ? widget.renderSmall : widget.render;
      card.innerHTML = renderFn(rec.data, inst.config || {}, inst, rec);
      if (rec.error) {
        const tip = document.createElement('div');
        tip.className = 'w-error';
        tip.textContent = `更新失败：${rec.error}`;
        card.appendChild(tip);
      }
    } else {
      card.innerHTML = `<div class="w-empty">${rec.error ? '更新失败：' + esc(rec.error) : '等待首次获取数据'}<br><small>${esc(inst.title || widget.name)}</small></div>`;
    }

    // 统一操作条：查看模式仅刷新；编辑模式显示尺寸/编辑/删除
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    actions.innerHTML = `
      <button data-action="resize" title="切换尺寸">⤢</button>
      <button data-action="edit" title="编辑配置">⚙</button>
      <button data-action="delete" title="删除">🗑</button>
      <button data-action="refresh" title="刷新">↻</button>`;
    card.appendChild(actions);

    // 底部小号更新时间脚注（有数据的卡统一展示，不占用标题空间）
    if (rec.updatedAt && typeof widget.fetchData === 'function') {
      const updated = document.createElement('div');
      updated.className = 'w-updated';
      updated.title = new Date(rec.updatedAt).toLocaleString('zh-CN');
      updated.textContent = '更新 ' + new Date(rec.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      card.appendChild(updated);
    }

    // 标题元素统一加 title 悬浮全称
    const titleEl = card.querySelector('.w-title');
    if (titleEl && !titleEl.title) titleEl.title = titleEl.textContent.trim();

    grid.appendChild(card);
  }

  if (state.mode === 'edit') {
    const add = document.createElement('div');
    add.className = 'add-placeholder';
    add.id = 'add-placeholder';
    add.innerHTML = '<div class="plus">＋</div><div>添加小组件</div>';
    grid.appendChild(add);
  }
  if (!state.layout.length && state.mode === 'view') {
    grid.innerHTML = '<div class="w-empty">还没有组件，点右上角「编辑」后添加</div>';
  }
}

function setMode(mode) {
  state.mode = mode;
  document.body.dataset.mode = mode;
  $('btn-mode').textContent = mode === 'edit' ? '✓ 完成' : '✎ 编辑';
  if (mode === 'view') { closeEditor(); closeLibrary(); closeSettings(); }
  renderGrid();
}

// ---------- 卡片微操作 ----------
const SIZES = ['small', 'medium', 'large'];
function cycleSize(id) {
  const inst = getInstance(id);
  if (!inst) return;
  const i = SIZES.indexOf(inst.size || 'small');
  inst.size = SIZES[(i + 1) % SIZES.length];
  persist();
  renderGrid();
}

async function removeInstance(id) {
  state.layout = state.layout.filter((i) => i.instanceId !== id);
  await persist();
  await chrome.runtime.sendMessage({ action: 'layoutChanged' });
  await load();
  renderGrid();
}

async function refreshInstance(id) {
  await chrome.runtime.sendMessage({ action: 'refreshWidget', id });
  state.cache = await getAllCache(state.layout);
  renderGrid();
}

async function persist() {
  await saveLayout(state.layout);
}

// ---------- 实例编辑器抽屉 ----------
function fieldHtml(field, value) {
  const v = esc(value ?? field.default ?? '');
  // 平台条件字段：只在选中的平台下显示
  const plat = field.platforms ? ` data-platforms="${field.platforms.join(',')}"` : '';
  // 模式条件字段：只在选中的取数模式下显示（订阅额度的 local / scrape）
  const modes = field.modes ? ` data-modes="${field.modes.join(',')}"` : '';
  const cond = plat + modes;
  if (field.type === 'select') {
    const opts = (field.options || []).map((o) =>
      `<option value="${esc(o.value)}" ${String(value ?? field.default) === String(o.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
    return `<div class="cfg-field"${cond}><label>${esc(field.label)}</label><select data-key="${esc(field.key)}">${opts}</select></div>`;
  }
  if (field.type === 'textarea') {
    return `<div class="cfg-field"${cond}><label>${esc(field.label)}</label><textarea data-key="${esc(field.key)}" placeholder="${esc(field.placeholder || '')}">${v}</textarea></div>`;
  }
  if (field.type === 'cookie') {
    // carrier 显式指定同步运营商（如 subscription 的 chatgpt）；carrier:false 则不渲染同步按钮。
    const carrier = field.carrier || '';
    const tools = field.carrier !== false
      ? `<div class="cookie-tools">
          <button type="button" data-cookie-action="login"${carrier ? ` data-carrier="${esc(carrier)}"` : ''}>去官网登录</button>
          <button type="button" data-cookie-action="sync" class="primary"${carrier ? ` data-carrier="${esc(carrier)}"` : ''}>同步浏览器 Cookie</button>
        </div>
        <div class="cookie-hint" data-cookie-hint></div>`
      : '';
    return `<div class="cfg-field"${cond}>
      <label>${esc(field.label)}</label>
      <textarea data-key="${esc(field.key)}" placeholder="${esc(field.placeholder || '')}">${v}</textarea>
      ${tools}
    </div>`;
  }
  if (field.type === 'checkbox') {
    const checked = (value ?? field.default) === true || value === 'true' || value === 1 || value === '1' ? 'checked' : '';
    return `<div class="cfg-field"${cond}><label>${esc(field.label)}</label>
      <div class="cfg-check"><input type="checkbox" data-key="${esc(field.key)}" ${checked}><span>${esc(field.label)}</span></div></div>`;
  }
  if (field.type === 'token-import') {
    const checked = (value ?? field.default) === true || value === 'true' || value === 1 || value === '1' ? 'checked' : '';
    return `<div class="cfg-field"${cond}>
      <label>${esc(field.label)}</label>
      <div class="cfg-check"><input type="checkbox" data-key="${esc(field.key)}" ${checked}><span>启用</span></div>
      <div class="cookie-tools">
        <button type="button" data-token-action="cookie" class="primary">同步 Cookie 换 token</button>
        <button type="button" data-token-action="import">导入 auth.json</button>
        <button type="button" data-token-action="clear">清除已导入</button>
      </div>
      <div class="cookie-hint" data-token-hint></div>
    </div>`;
  }
  // password / text / number 等原生类型（API Key 走 password，仅落 storage.local）
  const input = `<input type="${field.type || 'text'}" data-key="${esc(field.key)}" value="${v}" placeholder="${esc(field.placeholder || '')}">`;
  const test = field.testable
    ? `<div class="api-tools"><button type="button" data-action="test-api">测试连接</button></div><div class="api-test-hint" data-api-hint></div>`
    : '';
  return `<div class="cfg-field"${cond}><label>${esc(field.label)}</label>${input}${test}</div>`;
}

// 平台条件字段显隐（如 AI 余额的 Base URL / Organization ID / 端点选择）
function applyPlatformVisibility() {
  const sel = $('drawer-body').querySelector('[data-key="platform"]');
  if (!sel) return;
  const val = sel.value;
  $('drawer-body').querySelectorAll('.cfg-field[data-platforms]').forEach((f) => {
    f.style.display = f.dataset.platforms.split(',').includes(val) ? '' : 'none';
  });
}

// 模式条件字段显隐（订阅额度的 local / scrape 两套字段）
function applyModeVisibility() {
  const sel = $('drawer-body').querySelector('[data-key="mode"]');
  if (!sel) return;
  const val = sel.value;
  $('drawer-body').querySelectorAll('.cfg-field[data-modes]').forEach((f) => {
    f.style.display = f.dataset.modes.split(',').includes(val) ? '' : 'none';
  });
}

function openEditor(id) {
  const inst = getInstance(id);
  if (!inst) return;
  const widget = WIDGET_MAP[inst.type];
  state.editingId = id;
  $('drawer-title').textContent = `编辑 · ${widget.name}`;
  const cfg = inst.config || {};
  let html = '<div class="cfg-section-title">通用</div>';
  html += `<div class="cfg-field"><label>卡片标题</label><input data-public="title" value="${esc(inst.title || '')}"></div>`;
  html += `<div class="cfg-field"><label>点击跳转链接（留空则不跳转）</label><input data-public="linkUrl" value="${esc(inst.linkUrl || '')}"></div>`;
  html += `<div class="cfg-check"><input type="checkbox" data-public="openInNewTab" ${inst.openInNewTab ? 'checked' : ''}><span>在新标签页打开</span></div>`;
  html += `<div class="cfg-field" style="margin-top:12px"><label>卡片尺寸</label><select data-public="size">
    ${SIZES.map((s) => `<option value="${s}" ${(inst.size === s) ? 'selected' : ''}>${{ small: '小 1×1', medium: '中 2×1', large: '大 2×2' }[s]}</option>`).join('')}
  </select></div>`;
  if (widget.canBeBadgeSource) {
    html += `<div class="cfg-check" style="margin-top:12px"><input type="checkbox" data-public="isBadgeSource" ${inst.isBadgeSource ? 'checked' : ''}><span>用这张卡作为工具栏角标来源</span></div>`;
  }
  if (widget.settingsSchema?.length) {
    html += '<div class="cfg-section-title" style="margin-top:22px">组件配置</div>';
    html += widget.settingsSchema.map((f) => fieldHtml(f, cfg[f.key])).join('');
  }
  $('drawer-body').innerHTML = html;
  // 平台条件显隐 + 记录当前默认跳转，供切换平台时联动
  state._prevDefaultUrl = typeof widget.defaultLinkUrl === 'function'
    ? (widget.defaultLinkUrl(cfg) || '') : '';
  applyPlatformVisibility();
  applyModeVisibility();
  $('drawer').hidden = false;
  $('drawer-mask').hidden = false;
}

function closeEditor() {
  state.editingId = null;
  $('drawer').hidden = true;
  $('drawer-mask').hidden = true;
}

async function saveEditor() {
  const inst = getInstance(state.editingId);
  if (!inst) return closeEditor();
  $('drawer-body').querySelectorAll('[data-public]').forEach((el) => {
    const v = el.type === 'checkbox' ? el.checked : el.value.trim();
    inst[el.dataset.public] = v;
  });
  // 角标来源互斥：只允许一张卡作为来源
  if (inst.isBadgeSource) {
    state.layout.forEach((i) => { if (i.instanceId !== inst.instanceId) i.isBadgeSource = false; });
  }
  inst.config = inst.config || {};
  $('drawer-body').querySelectorAll('[data-key]').forEach((el) => {
    inst.config[el.dataset.key] = el.type === 'checkbox' ? el.checked : el.value.trim();
  });
  closeEditor();
  await persist();
  await chrome.runtime.sendMessage({ action: 'layoutChanged' });
  await load();
  renderGrid();
}

// ---------- 组件库抽屉 ----------
function openLibrary() {
  $('library-body').innerHTML = WIDGETS.map((w) => `
    <div class="lib-item">
      <div class="lib-icon">${ICONS[w.id] || '▦'}</div>
      <div class="lib-info">
        <div class="lib-name">${esc(w.name)}</div>
        <div class="lib-desc">${esc(DESCS[w.id] || '')}</div>
      </div>
      <button data-add-type="${esc(w.id)}">添加</button>
    </div>`).join('');
  $('library').hidden = false;
  $('drawer-mask').hidden = false;
}

function closeLibrary() {
  $('library').hidden = true;
  $('drawer-mask').hidden = true;
}

// ---------- 全局设置抽屉：备份与恢复 ----------
function openSettings() {
  $('settings').hidden = false;
  $('drawer-mask').hidden = false;
}

function closeSettings() {
  $('settings').hidden = true;
  $('drawer-mask').hidden = true;
}

function setIoHint(msg, cls) {
  const el = $('cfg-io-hint');
  el.textContent = msg;
  el.className = 'cfg-io-hint' + (cls ? ' ' + cls : '');
}

async function exportConfig() {
  try {
    const layout = await getLayout();
    const settings = (await chrome.storage.local.get(['settings'])).settings || {};
    const redact = $('cfg-export-redact').checked;
    const payload = buildExport({ layout: redactLayout(layout, redact), settings });
    downloadJson(payload, exportFilename());
    setIoHint(`已导出 ${layout.length} 个组件${redact ? '（已脱敏敏感凭据）' : ''}`, 'ok');
  } catch (err) {
    setIoHint(`导出失败：${err.message}`, 'err');
  }
}

function importConfig() {
  $('cfg-import-file').click();
}

async function handleImportFile(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const result = validateImport(data);
    if (!result.ok) { setIoHint(`导入失败：${result.error}`, 'err'); return; }
    const { settings, layout } = result.value;
    const confirmed = confirm(
      `确定导入该配置吗？将覆盖当前 ${state.layout.length} 个组件布局为 ${layout.length} 个组件。`
    );
    if (!confirmed) { setIoHint('已取消导入'); return; }
    await saveLayout(layout);
    if (settings && typeof settings === 'object') {
      await chrome.storage.local.set({ settings });
    }
    await chrome.runtime.sendMessage({ action: 'layoutChanged' });
    await chrome.runtime.sendMessage({ action: 'refreshAll' });
    await load();
    renderGrid();
    setIoHint(`导入成功，已恢复 ${layout.length} 个组件并触发刷新`, 'ok');
  } catch (err) {
    setIoHint(`导入失败：${err.message || '文件解析错误'}`, 'err');
  }
}

async function addInstance(type) {
  const inst = createInstance(type, { instanceId: newInstanceId() });
  if (!inst) return;
  // 第一张 subinfo 自动作为角标来源
  if (type === 'subinfo' && !state.layout.some((i) => i.isBadgeSource)) inst.isBadgeSource = true;
  state.layout.push(inst);
  closeLibrary();
  await persist();
  await chrome.runtime.sendMessage({ action: 'layoutChanged' });
  await load();
  renderGrid();
  openEditor(inst.instanceId);
}

// ---------- 事件 ----------
// 两级点击隔离：编辑模式拦截一切跳转；查看模式尊重卡片内子链接
grid.addEventListener('click', (e) => {
  const card = e.target.closest('.widget-card');
  if (!card) return;
  const inst = getInstance(card.dataset.instanceId);
  if (!inst) return;

  const action = e.target.closest('[data-action]')?.dataset.action;
  if (state.mode === 'edit') {
    e.preventDefault();
    if (action === 'resize') return cycleSize(inst.instanceId);
    if (action === 'delete') return removeInstance(inst.instanceId);
    if (action === 'edit') return openEditor(inst.instanceId);
    return openEditor(inst.instanceId);
  }
  // 查看模式
  if (action === 'refresh') { e.preventDefault(); return refreshInstance(inst.instanceId); }
  if (action === 'renew') { e.preventDefault(); return openEditor(inst.instanceId); } // 过期卡点角标→打开编辑续期
  if (action === 'open-article') { // RSS 单条：打开原文（无链接则忽略）
    e.preventDefault();
    const url = e.target.closest('[data-url]')?.dataset.url;
    if (url) window.open(url, '_blank', 'noopener');
    return;
  }
  if (action === 'reprobe') { // 网络状态：一键重新探测
    e.preventDefault();
    return refreshInstance(inst.instanceId);
  }
  // 网络状态：点击出口 IP 一键复制（不触发整卡跳转）
  const ipEl = e.target.closest('.ns-ip[data-ip]');
  if (ipEl && ipEl.dataset.ip) {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard?.writeText(ipEl.dataset.ip).then(() => {
      showToast(`已复制 IP ${ipEl.dataset.ip}`);
    }).catch(() => showToast('复制失败，请手动复制'));
    return;
  }
  if (e.target.closest('a, button')) return; // 放行组件内部子链接
  if (inst.linkUrl) {
    if (inst.openInNewTab) window.open(inst.linkUrl, '_blank', 'noopener');
    else window.location.href = inst.linkUrl;
  }
});

// 原生拖拽重排（仅编辑模式）
grid.addEventListener('dragstart', (e) => {
  if (state.mode !== 'edit') return e.preventDefault();
  const card = e.target.closest('.widget-card');
  if (!card) return;
  state.draggingId = card.dataset.instanceId;
  card.classList.add('is-dragging');
  e.dataTransfer.effectAllowed = 'move';
});
grid.addEventListener('dragover', (e) => {
  if (state.mode !== 'edit' || !state.draggingId) return;
  e.preventDefault();
  grid.querySelectorAll('.drop-before,.drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  const target = e.target.closest('.widget-card');
  if (!target || target.dataset.instanceId === state.draggingId) return;
  const rect = target.getBoundingClientRect();
  target.classList.add(e.clientX < rect.left + rect.width / 2 ? 'drop-before' : 'drop-after');
});
grid.addEventListener('drop', async (e) => {
  if (state.mode !== 'edit' || !state.draggingId) return;
  e.preventDefault();
  const target = e.target.closest('.widget-card');
  if (target && target.dataset.instanceId !== state.draggingId) {
    const from = state.layout.findIndex((i) => i.instanceId === state.draggingId);
    const to = state.layout.findIndex((i) => i.instanceId === target.dataset.instanceId);
    const [moved] = state.layout.splice(from, 1);
    const rect = target.getBoundingClientRect();
    const insertAt = e.clientX < rect.left + rect.width / 2 ? to : to + 1;
    state.layout.splice(insertAt, 0, moved);
    await persist();
  }
  state.draggingId = null;
  renderGrid();
});
grid.addEventListener('dragend', () => {
  state.draggingId = null;
  grid.querySelectorAll('.is-dragging,.drop-before,.drop-after').forEach((el) =>
    el.classList.remove('is-dragging', 'drop-before', 'drop-after'));
});

grid.addEventListener('click', (e) => {
  if (e.target.closest('#add-placeholder')) openLibrary();
});

$('btn-mode').addEventListener('click', () => setMode(state.mode === 'view' ? 'edit' : 'view'));
$('btn-add').addEventListener('click', openLibrary);
$('btn-refresh-all').addEventListener('click', async () => {
  $('btn-refresh-all').textContent = '刷新中…';
  await chrome.runtime.sendMessage({ action: 'refreshAll' });
  await load();
  renderGrid();
  $('btn-refresh-all').textContent = '↻ 刷新';
});
$('btn-close-drawer').addEventListener('click', closeEditor);
$('btn-close-library').addEventListener('click', closeLibrary);
$('drawer-mask').addEventListener('click', () => { closeEditor(); closeLibrary(); closeSettings(); });
$('btn-save-settings').addEventListener('click', saveEditor);
$('btn-delete-instance').addEventListener('click', () => removeInstance(state.editingId));

// 全局设置抽屉
$('btn-settings').addEventListener('click', openSettings);
$('btn-close-settings').addEventListener('click', closeSettings);
$('btn-export-config').addEventListener('click', exportConfig);
$('btn-import-config').addEventListener('click', importConfig);
$('cfg-import-file').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) handleImportFile(file);
  e.target.value = ''; // 允许重复选择同一文件
});
$('library-body').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-add-type]');
  if (btn) addInstance(btn.dataset.addType);
});

// 编辑抽屉：Cookie 快捷按钮（去官网登录 / 同步浏览器 Cookie）
$('drawer-body').addEventListener('click', async (e) => {
  // AI 余额：测试连接（复用适配器与鉴权，不写快照）
  const testBtn = e.target.closest('[data-action="test-api"]');
  if (testBtn) {
    const cfg = {};
    $('drawer-body').querySelectorAll('[data-key]').forEach((f) => { cfg[f.dataset.key] = f.value.trim(); });
    const hint = $('drawer-body').querySelector('[data-api-hint]');
    testBtn.textContent = '测试中…';
    if (hint) { hint.textContent = ''; hint.className = 'api-test-hint'; }
    try {
      const { testConnection } = await import('./widgets/ai-balance.js');
      const { netFetch } = await import('./core/dnr-fetch.js');
      const res = await testConnection(cfg, { netFetch });
      if (hint) {
        hint.textContent = `连接正常 · ${res.platformName} · ${res.currency}${res.primaryValue} ${res.primaryLabel}`;
        hint.className = 'api-test-hint ok';
      }
    } catch (err) {
      if (hint) { hint.textContent = `连接失败：${err.message}`; hint.className = 'api-test-hint err'; }
    } finally {
      testBtn.textContent = '测试连接';
    }
    return;
  }
  // 订阅额度：导入 auth.json（File System Access API 选文件 → 解析 token → 存 storage）
  const tokenBtn = e.target.closest('[data-token-action]');
  if (tokenBtn) {
    const hint = $('drawer-body').querySelector('[data-token-hint]');
    if (tokenBtn.dataset.tokenAction === 'clear') {
      await chrome.storage.local.remove(['codexAuth']);
      if (hint) { hint.textContent = '已清除导入的登录态'; hint.className = 'cookie-hint'; }
      return;
    }
    // cookie：用浏览器 chatgpt.com 登录态调 api/auth/session 换 accessToken
    if (tokenBtn.dataset.tokenAction === 'cookie') {
      tokenBtn.textContent = '获取中…';
      try {
        const { syncBrowserCookie } = await import('./core/cookie-sync.js');
        const cookie = await syncBrowserCookie('chatgpt');
        // 用 Cookie 会话态请求 session 接口换取 accessToken
        const res = await fetch('https://chatgpt.com/api/auth/session', {
          headers: { 'Cookie': cookie, 'Accept': 'application/json' },
          credentials: 'omit'
        });
        if (!res.ok) throw new Error(`session 接口返回 HTTP ${res.status}（可能登录态过期）`);
        const json = await res.json();
        const accessToken = json?.accessToken || '';
        if (!accessToken) throw new Error('session 接口未返回 accessToken（可能未登录 chatgpt.com）');
        // account_id 需从 accessToken 的 JWT payload 解析（user.id 是 user 维度，非 account 维度）
        let accountId = json?.user?.id || '';
        try {
          const seg = accessToken.split('.')[1];
          const payload = JSON.parse(atob(seg.replace(/-/g, '+').replace(/_/g, '/')));
          accountId = payload['https://api.openai.com/auth']?.chatgpt_account_id || accountId;
        } catch (_) { /* 解析失败则退回 user.id */ }
        await chrome.storage.local.set({
          codexAuth: {
            access_token: accessToken,
            account_id: accountId,
            savedAt: Date.now(),
            source: 'cookie'
          }
        });
        const chk = $('drawer-body').querySelector('[data-key="autoToken"]');
        if (chk) chk.checked = true;
        if (hint) { hint.textContent = '已通过 Cookie 获取登录态，点「保存」后生效'; hint.className = 'cookie-hint'; }
      } catch (err) {
        if (hint) { hint.textContent = `获取失败：${err.message}`; hint.className = 'cookie-hint'; }
      } finally {
        tokenBtn.textContent = '同步 Cookie 换 token';
      }
      return;
    }
    // import
    tokenBtn.textContent = '读取中…';
    try {
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
        excludeAcceptAllOption: true
      });
      const file = await handle.getFile();
      const text = await file.text();
      const auth = JSON.parse(text);
      const tokens = auth?.tokens || {};
      if (!tokens.access_token || !tokens.account_id) {
        throw new Error('不是有效的 Codex auth.json（缺少 tokens.access_token / tokens.account_id）');
      }
      await chrome.storage.local.set({
        codexAuth: {
          access_token: tokens.access_token,
          account_id: tokens.account_id,
          savedAt: Date.now()
        }
      });
      // 勾选「启用」
      const chk = $('drawer-body').querySelector('[data-key="autoToken"]');
      if (chk) chk.checked = true;
      if (hint) { hint.textContent = '已导入登录态（token 仅存本机，10 天左右过期后需重导）'; hint.className = 'cookie-hint'; }
    } catch (err) {
      if (err.name !== 'AbortError' && hint) {
        hint.textContent = `导入失败：${err.message}`; hint.className = 'cookie-hint';
      }
    } finally {
      tokenBtn.textContent = '导入 auth.json';
    }
    return;
  }
  const btn = e.target.closest('[data-cookie-action]');
  if (!btn) return;
  const operator = btn.dataset.carrier
    || $('drawer-body').querySelector('[data-key="operator"]')?.value
    || $('drawer-body').querySelector('[data-key="platform"]')?.value
    || 'unicom';
  const hint = $('drawer-body').querySelector('[data-cookie-hint]');
  const cookieEl = $('drawer-body').querySelector('[data-key="cookie"]');

  if (btn.dataset.cookieAction === 'login') {
    const { getLoginUrl } = await import('./core/cookie-sync.js');
    window.open(getLoginUrl(operator), '_blank', 'noopener');
    if (hint) hint.textContent = '登录完成后回到这里点「同步浏览器 Cookie」';
    return;
  }
  if (btn.dataset.cookieAction === 'sync') {
    btn.textContent = '同步中…';
    try {
      const { syncBrowserCookie } = await import('./core/cookie-sync.js');
      const cookie = await syncBrowserCookie(operator);
      if (cookieEl) cookieEl.value = cookie;
      if (hint) hint.textContent = `已同步 ${cookie.split(';').length} 项 Cookie，记得点「保存」`;
    } catch (err) {
      if (hint) hint.textContent = `同步失败：${err.message}`;
    } finally {
      btn.textContent = '同步浏览器 Cookie';
    }
  }
});

// 平台切换：条件字段显隐 + 自动更新账单控制台跳转链接（仅当未自定义时）
$('drawer-body').addEventListener('change', (e) => {
  if (e.target?.dataset?.key === 'mode') {
    applyModeVisibility();
    return;
  }
  // 订阅额度：预置服务切换时自动填充 name/plan/mode/接口/字段路径
  if (e.target?.dataset?.key === 'preset') {
    const inst = getInstance(state.editingId);
    const widget = inst && WIDGET_MAP[inst.type];
    const preset = widget?.presets?.[e.target.value];
    if (preset) {
      $('drawer-body').querySelectorAll('[data-key]').forEach((f) => {
        if (preset[f.dataset.key] !== undefined) {
          if (f.type === 'checkbox') f.checked = !!preset[f.dataset.key];
          else f.value = preset[f.dataset.key];
        }
      });
      applyModeVisibility();
    }
    return;
  }
  if (e.target?.dataset?.key !== 'platform') return;
  applyPlatformVisibility();
  const inst = getInstance(state.editingId);
  const widget = inst && WIDGET_MAP[inst.type];
  if (!widget || typeof widget.defaultLinkUrl !== 'function') return;
  const cfg = {};
  $('drawer-body').querySelectorAll('[data-key]').forEach((f) => { cfg[f.dataset.key] = f.value.trim(); });
  const next = widget.defaultLinkUrl(cfg) || '';
  const linkEl = $('drawer-body').querySelector('[data-public="linkUrl"]');
  if (linkEl && (!linkEl.value.trim() || linkEl.value.trim() === state._prevDefaultUrl)) {
    linkEl.value = next;
  }
  state._prevDefaultUrl = next;
});

document.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  if (e.key === 'Escape') { if (state.mode === 'edit') setMode('view'); else { closeEditor(); closeLibrary(); closeSettings(); } }
  if (e.key === 'e' || e.key === 'E') setMode(state.mode === 'view' ? 'edit' : 'view');
});

// 后台数据更新后自动刷新视图
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some((k) => k.startsWith('cache:'))) {
    load().then(renderGrid);
  }
});

// 网络恢复时自动重测网络状态组件（network-status 依赖在线探测）
window.addEventListener('online', () => {
  const ns = state.layout.filter((i) => i.type === 'network-status');
  if (ns.length) {
    ns.forEach((i) => chrome.runtime.sendMessage({ action: 'refreshWidget', id: i.instanceId }));
    setTimeout(async () => { state.cache = await getAllCache(state.layout); renderGrid(); }, 800);
  }
});

load().then(renderGrid);
