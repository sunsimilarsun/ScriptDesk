// Gemini 用量卡：展示 gemini.google.com 网页端订阅余量（5 小时 / 每周限额）。
// 取数方式：Gemini 用量数据走同源 batchexecute RPC，且登录态 Cookie 有 SameSite/CheckCookie 校验，
// 扩展 service worker 跨站 fetch 会被 Google 判 CookieMismatch。故由 content script
// （content/gemini-usage-content.js）注入在 gemini.google.com 页面里同源取数，写回 storage。
// 本组件（fetchData 在 service worker 执行）负责：
//   1) chrome.tabs.query 找已打开的 gemini.google.com 标签页
//   2) 命中则 sendMessage 触发 content script 立即同源刷新（8s 超时兜底）
//   3) 无标签页/超时则读 storage 缓存，卡片展示「上次同步时间」与温和提示
//   4) 完全无缓存才提示「请打开一次 gemini.google.com 以自动同步余量」

// ---------- 工具 ----------
const num = (v) => {
  if (typeof v === 'string' && v.trim() === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STORAGE_PREFIX = 'geminiUsageLive:';

// ---------- storage 缓存 ----------
async function getLive(accountIndex) {
  try {
    return (await chrome.storage.local.get([`${STORAGE_PREFIX}${accountIndex}`]))[`${STORAGE_PREFIX}${accountIndex}`] || null;
  } catch (_) { return null; }
}

// ---------- 查找已打开的 gemini 标签页并触发同步 ----------
// 向标签页的 MAIN world 注入取数函数并执行（绕开 content script 的 CSP 限制），
// 把结果写回 storage。返回 { ok, resp, error }。
async function collectFromTab(tabId, accountIndex) {
  try {
    // 注入 MAIN world 取数函数（每次覆盖，不拦截重复注入，保证重载后旧页也跑新版）
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['content/gemini-usage-main.js']
    });
    // 再执行取数，直接拿返回值
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (idx) => window.__scriptDeskCollectUsage ? window.__scriptDeskCollectUsage(idx) : { ok: false, error: 'MAIN 取数函数未挂载' },
      args: [accountIndex]
    });
    const resp = results && results[0] && results[0].result;
    if (resp) {
      // 写 storage（成功或失败都写，供卡片读取真实结果）
      const live = { ...resp, updatedAt: resp.updatedAt || Date.now() };
      try { await chrome.storage.local.set({ [`${STORAGE_PREFIX}${resp.accountIndex ?? accountIndex}`]: live }); } catch (_) {}
      return { ok: true, resp, error: '' };
    }
    return { ok: false, resp: null, error: '注入执行无返回' };
  } catch (e) {
    return { ok: false, resp: null, error: e.message };
  }
}

async function requestSync(accountIndex) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
  } catch (_) { tabs = []; }

  // 排序：目标账号索引优先；其次非休眠（discarded）优先、活跃优先
  const score = (t) => {
    const m = (t.url || '').match(/gemini\.google\.com\/u\/(\d+)/);
    const idx = m ? parseInt(m[1], 10) : 0;
    let s = 0;
    if (idx === accountIndex) s += 1000;
    if (!t.discarded) s += 100;
    if (t.active) s += 10;
    return s;
  };
  const ordered = tabs.slice().sort((a, b) => score(b) - score(a));

  for (const t of ordered) {
    if (t.id == null) continue;
    if (t.discarded) continue; // 跳过休眠页
    const { resp, error } = await collectFromTab(t.id, accountIndex);

    if (resp && resp.ok) {
      return { live: resp, fromTab: true, throttled: !!resp.throttled };
    }
    if (resp && resp.ok === false && resp.error) {
      // 取数失败：透传真实错误
      return { live: resp, fromTab: false, error: resp.error };
    }
    // 其余（注入失败）记录错误，尝试下一个标签页
  }

  const live = await getLive(accountIndex);
  return { live, fromTab: false };
}

// ---------- 核心取数 ----------
async function fetchGemini(config) {
  const accountIndex = parseInt(config.accountIndex || '0', 10) || 0;

  // 防御：历史 layout 可能残留过时的 rpcid/args/cookie 配置项。
  // 取数逻辑（content/gemini-usage-main.js）硬编码使用实测确认的 jSf9Qc，
  // 本组件只读取 accountIndex，天然忽略 config.rpcid/args/cookie，不受旧字段干扰。

  const { live, error } = await requestSync(accountIndex);

  if (live && live.ok && (live.windows || []).length) {
    return {
      name: 'Gemini',
      plan: live.plan || 'Gemini',
      planInfo: {
        plan: live.plan || 'Gemini',
        accountEmail: live.email || '',
        accountIndex: live.accountIndex ?? accountIndex,
        source: 'content-script'
      },
      windows: live.windows,
      warn: '',
      fetchedAt: live.updatedAt || Date.now(),
      live: true
    };
  }

  // content script 实际取数但失败：透传真实错误阶段，而不是误报「尚未同步」
  if (error || (live && live.ok === false && live.error)) {
    const errMsg = error || (live && live.error) || '未知错误';
    return {
      name: 'Gemini',
      plan: 'Gemini',
      planInfo: { plan: 'Gemini', accountEmail: live?.email || '', accountIndex, source: 'error' },
      windows: [{
        id: 'error',
        label: '同步失败',
        type: 'percent',
        usedPercent: null,
        usedText: errMsg,
        resetText: ''
      }],
      warn: '',
      fetchedAt: live?.updatedAt || null,
      live: false,
      error: errMsg
    };
  }

  // 有缓存但解析为空（含诊断）
  if (live && live.ok) {
    return {
      name: 'Gemini',
      plan: live.plan || 'Gemini',
      planInfo: {
        plan: live.plan || 'Gemini',
        accountEmail: live.email || '',
        accountIndex: live.accountIndex ?? accountIndex,
        source: 'content-script'
      },
      windows: [{
        id: 'unknown',
        label: '用量未解析',
        type: 'percent',
        usedPercent: null,
        usedText: '页面已同步但字段未匹配，可打开 gemini.google.com 用量页查看',
        resetText: ''
      }],
      warn: '',
      fetchedAt: live.updatedAt || Date.now(),
      live: true,
      diag: live.diag || ''
    };
  }

  // 完全无缓存
  return {
    name: 'Gemini',
    plan: 'Gemini',
    planInfo: { plan: 'Gemini', accountEmail: '', accountIndex, source: 'none' },
    windows: [{
      id: 'empty',
      label: '尚未同步',
      type: 'percent',
      usedPercent: null,
      usedText: '请打开一次 gemini.google.com 以自动同步余量',
      resetText: ''
    }],
    warn: '',
    fetchedAt: null,
    live: false
  };
}

// ---------- 渲染 ----------
function fmtCountdown(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  const diff = ms - Date.now();
  if (diff <= 0) return '即将重置';
  const total = Math.floor(diff / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时后重置`;
  if (h > 0) return `${h} 小时 ${m} 分后重置`;
  return `${m} 分钟后重置`;
}

// 精确重置时间（tooltip 用）
function fmtExact(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - num(ts);
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

function renderWindows(data, inst) {
  const planName = data.planInfo?.plan || data.plan || 'Gemini';
  const email = data.planInfo?.accountEmail || '';
  const badge = `<span class="w-badge sb-plan-badge">${esc(planName)}</span>`;
  const emailTitle = email ? `title="${esc(email)}"` : '';

  const rows = (data.windows || []).map((w) => {
    // 「剩余」视角：进度条显示剩余比例，剩余越少越告警
    const remaining = w.remaining;
    const totalLimit = w.totalLimit;
    const hasQuota = typeof remaining === 'number' && typeof totalLimit === 'number' && totalLimit > 0;
    const remainPct = hasQuota ? Math.min(100, Math.max(0, (remaining / totalLimit) * 100)) : null;
    const hasPct = remainPct !== null && remainPct !== undefined;
    // 告警反转：剩余 ≤5% 红色、≤20% 琥珀色
    const high = hasPct && remainPct <= 5;
    const mid = hasPct && remainPct <= 20 && remainPct > 5;
    const cls = high ? 'low' : mid ? 'mid' : '';
    const bar = hasPct
      ? `<div class="w-progress"><i class="${cls}" style="width:${Math.max(0, Math.min(100, remainPct))}%"></i></div>`
      : '';
    // 剩余百分比文案：整数或 1 位小数
    const remainPctText = hasPct
      ? (Number.isInteger(remainPct) ? `${remainPct}%` : `${remainPct.toFixed(1)}%`)
      : '';
    const remainText = hasQuota
      ? `剩余 ${remaining} / ${totalLimit}`
      : (w.usedText || '');
    const cd = w.resetMs ? fmtCountdown(w.resetMs) : (w.resetText || '');
    // tooltip：显示已用比例 + 精确重置时间
    const tipParts = [];
    if (hasQuota) tipParts.push(`已用 ${(100 - remainPct).toFixed(1)}%`);
    if (w.resetMs) tipParts.push(`重置 ${fmtExact(w.resetMs)}`);
    const tip = tipParts.length ? `title="${esc(tipParts.join(' · '))}"` : '';
    return `<div class="sb-win" ${tip}>
      <div class="sb-win-row"><span class="sb-win-label">${esc(w.label)}</span><span class="sb-win-cd">${esc(cd)}</span></div>
      <div class="sb-win-row">
        <span class="sb-win-pct ${cls}">${esc(remainText)}</span>
        ${remainPctText ? `<span class="sb-win-sub ${cls}">${esc(remainPctText)}</span>` : ''}
      </div>
      ${bar}
    </div>`;
  }).join('');

  let footer = '';
  if (data.fetchedAt) {
    footer = `<div class="sb-footer">上次同步：${timeAgo(data.fetchedAt)}</div>`;
  } else {
    footer = `<div class="sb-footer sb-footer-hint">打开 gemini.google.com 后自动同步</div>`;
  }

  return `
    <div class="w-head">
      <span class="w-title">${esc(inst?.title || data.name)}</span>
      ${badge}
    </div>
    ${email ? `<div class="sb-email" ${emailTitle}>${esc(email)}</div>` : ''}
    <div class="sb-win-list">${rows}</div>
    ${footer}`;
}

// ---------- 组件定义 ----------
export default {
  id: 'gemini-usage',
  name: 'Gemini 余量',
  defaultSize: 'small',
  refreshMinutes: 10,

  settingsSchema: [
    { key: 'accountIndex', label: 'Google 账号序号（0 = 默认主号）', type: 'number', default: 0,
      placeholder: '浏览器多账号时填对应序号，如 1 表示第 2 个账号' }
  ],

  defaultLinkUrl(config) {
    const idx = parseInt(config?.accountIndex || '0', 10);
    return idx > 0 ? `https://gemini.google.com/u/${idx}/usage` : 'https://gemini.google.com/usage';
  },

  async fetchData(config, ctx) {
    return fetchGemini(config);
  },

  renderSmall(data, config, inst) {
    return renderWindows(data, inst);
  },

  render(data, config, inst) {
    return renderWindows(data, inst);
  }
};
