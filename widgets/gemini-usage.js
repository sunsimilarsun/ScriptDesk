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
async function requestSync(accountIndex, timeoutMs = 8000) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
  } catch (_) { tabs = []; }

  // 优先匹配目标账号索引 /u/{idx} 的标签页；否则退而求其次用任意 gemini 标签页
  const target = tabs.find((t) => {
    const m = (t.url || '').match(/gemini\.google\.com\/u\/(\d+)/);
    const idx = m ? parseInt(m[1], 10) : 0;
    return idx === accountIndex;
  }) || tabs[0];

  if (target && target.id != null) {
    try {
      const resp = await new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; resolve({ __timeout: true }); } }, timeoutMs);
        chrome.tabs.sendMessage(target.id, { action: 'geminiUsageRefresh', accountIndex }, (r) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          // 吞掉「Receiving end does not exist」——目标页未注入 content script 时属正常，走缓存降级
          void chrome.runtime.lastError;
          resolve(r || {});
        });
      });
      if (!resp.__timeout && resp && resp.ok) {
        const live = await getLive(resp.accountIndex ?? accountIndex);
        return { live, fromTab: true, throttled: !!resp.throttled };
      }
      if (!resp.__timeout && resp && resp.ok === false && resp.error) {
        const live = await getLive(accountIndex);
        return { live, fromTab: false, error: resp.error };
      }
    } catch (_) { /* 通信失败落回缓存 */ }
  }

  const live = await getLive(accountIndex);
  return { live, fromTab: false };
}

// ---------- 核心取数 ----------
async function fetchGemini(config) {
  const accountIndex = parseInt(config.accountIndex || '0', 10) || 0;

  const { live } = await requestSync(accountIndex);

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
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分后重置`;
  return `${m} 分钟后重置`;
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
    const pct = w.usedPercent;
    const hasPct = pct !== null && pct !== undefined;
    const high = hasPct && pct >= 95;
    const mid = hasPct && pct >= 80 && pct < 95;
    const cls = high ? 'low' : mid ? 'mid' : '';
    const bar = hasPct
      ? `<div class="w-progress"><i class="${cls}" style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>`
      : '';
    const cd = w.resetMs ? fmtCountdown(w.resetMs) : (w.resetText || '');
    return `<div class="sb-win">
      <div class="sb-win-row"><span class="sb-win-label">${esc(w.label)}</span><span class="sb-win-cd">${esc(cd)}</span></div>
      <div class="sb-win-row"><span class="sb-win-pct ${cls}">${esc(w.usedText || '')}</span></div>
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
