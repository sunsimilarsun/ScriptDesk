// Codex / ChatGPT 套餐限额卡（精简版）。
// 专做一件事：读已导入的 Codex 登录态（access_token + account_id），
// 调 chatgpt.com/backend-api/wham/usage 接口，渲染「5小时 / 周」两档限额进度条与重置倒计时。
// 不再保留本地周期模式与通用抓取字段（用户定调：全组件精简，只做 Codex 用量）。

// ---------- 工具 ----------
const num = (v) => {
  if (typeof v === 'string' && v.trim() === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 百分比值归一化：0~1 视作比例乘 100；0~100 直接取整；越界截断
function toPctSafe(v) {
  if (v === undefined || v === null || v === '') return null;
  const p = num(v);
  if (!Number.isFinite(p)) return null;
  if (p > 1 && p <= 100) return Math.round(p);
  if (p >= 0 && p <= 1) return Math.round(p * 100);
  return Math.max(0, Math.min(100, p));
}

// 毫秒 → 「N天M小时」或「N小时M分」人类可读倒计时
function fmtCountdown(ms) {
  if (ms == null || !Number.isFinite(ms)) return '--';
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
}

// ---------- 取数 ----------
async function reqJson(ctx, url, headers) {
  let res;
  try { res = await ctx.netFetch(url, { headers }); }
  catch (e) { throw new Error(`无法连接接口：${e.message}`); }
  let text = '';
  try { text = await res.text(); }
  catch (e) { throw new Error(`读取响应失败：${e.message}`); }
  let json;
  try { json = text ? JSON.parse(text) : {}; }
  catch (_) { throw new Error(`接口返回非 JSON（HTTP ${res.status}）`); }
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || json?.msg || String(res.status);
    // 401/403 多为 token 过期：给出可操作的指引而非干巴巴的状态码
    const hint = (res.status === 401 || res.status === 403)
      ? '（登录态失效：请跑一次 codex login，或重新「导入 auth.json」）' : '';
    throw new Error(`HTTP ${res.status}：${String(msg).slice(0, 120)}${hint}`);
  }
  return json;
}

// 解析 wham/usage 的 rate_limit，产出多窗口（5小时 / 周 等），按 limit_window_seconds 分辨命名
function parseWindows(json) {
  const rl = json && typeof json === 'object' ? json.rate_limit : null;
  if (!rl || typeof rl !== 'object') return null;
  const slots = [rl.primary_window, rl.secondary_window].filter((w) => w && typeof w === 'object');
  if (!slots.length) return null;
  return slots.map((w) => {
    const secs = num(w.limit_window_seconds);
    const label = secs >= 604800 ? '周限额' : secs >= 86400 ? '日限额' : secs >= 18000 ? '5小时限额' : '限额';
    const usedPct = toPctSafe(w.used_percent);
    let resetMs = null;
    if (w.reset_at) {
      let t = num(w.reset_at);
      if (t > 0) { if (t < 1e12) t *= 1000; resetMs = t; }
    }
    return { label, usedPct, remainPct: usedPct === null ? null : 100 - usedPct, resetMs };
  });
}

// 核心取数：读 storage 的 codexAuth → 注入 Bearer 头 → 调 wham/usage → 解析窗口
async function fetchCodex(config, ctx) {
  // 读已导入的登录态
  let auth = {};
  try {
    const got = await chrome.storage.local.get(['codexAuth']);
    auth = got.codexAuth || {};
  } catch (_) { /* storage 不可用则视为未导入 */ }
  if (!auth.access_token) {
    throw new Error('尚未获取 Codex 登录态：请打开 chatgpt.com 登录一次（或编辑卡片点「导入 auth.json」）');
  }

  const headers = {
    'Authorization': `Bearer ${auth.access_token}`,
    'Accept': 'application/json'
  };
  if (auth.account_id) headers['ChatGPT-Account-Id'] = auth.account_id;

  const url = 'https://chatgpt.com/backend-api/wham/usage';
  const json = await reqJson(ctx, url, headers);
  const windows = parseWindows(json);
  if (!windows) {
    throw new Error('接口未返回 rate_limit 用量数据（可能账号无套餐限额）');
  }
  return { json, windows };
}

// ---------- 渲染 ----------
function renderWindows(data, inst) {
  const rows = data.windows.map((w) => {
    const pct = w.remainPct;
    const low = pct !== null && pct <= 20;
    const cd = fmtCountdown(w.resetMs ? w.resetMs - Date.now() : null);
    const pctLabel = pct !== null ? `剩余 ${pct}%` : '';
    const bar = pct !== null
      ? `<div class="w-progress"><i class="${low ? 'warn' : ''}" style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>`
      : '';
    return `<div class="sb-win">
      <div class="sb-win-row"><span class="sb-win-label">${esc(w.label)}</span><span class="sb-win-cd">${esc(cd)}</span></div>
      <div class="sb-win-row"><span class="sb-win-pct ${low ? 'low' : ''}">${pctLabel}</span></div>
      ${bar}
    </div>`;
  }).join('');
  return `
    <div class="w-head">
      <span class="w-title">${esc(inst?.title || data.name)}</span>
      <span class="w-badge ${data.warn ? 'warn' : ''}">${esc(data.plan || 'Codex')}</span>
    </div>
    <div class="sb-win-list">${rows}</div>`;
}

// ---------- 组件定义 ----------
export default {
  id: 'subscription',
  name: '订阅额度',
  defaultSize: 'small',
  refreshMinutes: 60,

  settingsSchema: [
    { key: 'name', label: '服务名', type: 'text', default: 'Codex', placeholder: '如 Codex / ChatGPT' },
    { key: 'plan', label: '套餐档位（展示用）', type: 'text', default: '', placeholder: '如 Plus / Pro，留空显示默认' },
    { key: 'autoToken', label: 'Codex 登录态（打开 chatgpt.com 登录后自动捕获，导入 auth.json 为兜底）', type: 'token-import', default: false },
    { key: 'warnPercent', label: '剩余百分比预警线（低于则红色高亮）', type: 'number', default: 20 }
  ],

  defaultLinkUrl() { return 'https://chatgpt.com/settings/usage?tab=overview'; },

  async fetchData(config, ctx) {
    const name = (config.name || '').trim() || 'Codex';
    const plan = (config.plan || '').trim();

    const { windows } = await fetchCodex(config, ctx);

    // 预警：任一窗口剩余 <= 预警线即整体标红
    const warnLine = num(config.warnPercent || 20);
    const warn = windows.some((w) => w.remainPct !== null && w.remainPct <= warnLine);

    return { name, plan, windows, warn };
  },

  renderSmall(data, config, inst) {
    return renderWindows(data, inst);
  },

  render(data, config, inst) {
    return renderWindows(data, inst);
  }
};
