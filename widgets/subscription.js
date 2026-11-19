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

  // 会员等级与到期：并行取 /backend-api/me（entitlement 含 expires_at / subscription_plan），
  // 同时把 wham/usage 的顶层 plan_type 一并传入作为最权威的等级来源
  const plan = await fetchPlan(headers, auth, ctx, json);

  return { json, windows, plan };
}

// 会员等级 + 到期：多源取权威值。
// 优先级：wham/usage 顶层 plan_type（当前活跃账号，最权威）
//   → /backend-api/me 顶层 plan_type + orgs 工作区回退
//   → entitlement.subscription_plan / has_active_subscription / expires_at
//   → JWT 的 chatgpt_plan_type（最后兜底，token 若为升级前签发会偏旧）
async function fetchPlan(headers, auth, ctx, usageJson) {
  // 0) wham/usage 顶层 plan_type（当前账号最权威等级）
  const usagePlan = normalizePlan(usageJson?.plan_type || usageJson?.account_plan_type || '');

  // 1) JWT 兜底等级（零额外请求）
  let jwtPlan = '';
  try {
    const seg = String(auth.access_token || '').split('.')[1];
    const payload = JSON.parse(atob(seg.replace(/-/g, '+').replace(/_/g, '/')));
    jwtPlan = (payload['https://api.openai.com/auth']?.chatgpt_plan_type) || '';
  } catch (_) { /* 忽略 */ }

  // 2) /backend-api/me 拿权威 entitlement + 工作区回退
  let mePlan = '', orgPlan = '', expiresAt = null, willRenew = null;
  try {
    const me = await reqJson(ctx, 'https://chatgpt.com/backend-api/me', headers);
    // 顶层 plan_type（正确路径，勿用 me.account.plan_type）
    mePlan = normalizePlan(me?.plan_type || me?.account?.plan_type || '');
    const ent = me?.entitlement || {};
    // entitlement 里权威订阅字段（accounts/check 同源）
    if (!mePlan || mePlan === 'Free') {
      mePlan = normalizePlan(ent?.subscription_plan || ent?.plan_type || mePlan);
    }
    // expires_at 可能是秒级（<1e12）或毫秒级时间戳
    if (ent?.expires_at) {
      let t = num(ent.expires_at);
      if (t > 0) { if (t < 1e12) t *= 1000; expiresAt = t; }
    }
    willRenew = ent?.has_active_subscription != null ? !!ent.has_active_subscription : null;
    // 工作区回退：Team/Enterprise 成员的个人 plan_type 可能是 free，
    // 但 orgs[].settings.workspace_plan_type 反映真实团队套餐
    const orgs = me?.orgs?.data || me?.organizations || [];
    for (const o of orgs) {
      const wp = o?.settings?.workspace_plan_type || o?.workspace_plan_type || '';
      if (wp) {
        const np = normalizePlan(wp);
        if (np && np !== 'Free' && (!orgPlan || orgPlan === 'Free')) orgPlan = np;
      }
    }
  } catch (_) { /* me 接口失败则用 usage/JWT 等级 */ }

  // 汇聚：usage 最权威 → me 顶层 → 工作区 → entitlement → JWT
  const plan = usagePlan || mePlan || orgPlan || normalizePlan(jwtPlan) || 'Free';
  const planRaw = usagePlan || mePlan || orgPlan || jwtPlan;
  return { plan, planRaw, expiresAt, willRenew };
}

// 归一化会员等级名（free/plus/pro/team/enterprise → 中文展示）
function normalizePlan(p) {
  const s = String(p || '').toLowerCase();
  if (!s || s === 'free') return 'Free';
  if (s === 'plus') return 'Plus';
  if (s === 'pro') return 'Pro';
  if (s === 'team') return 'Team';
  if (s === 'enterprise' || s === 'business') return 'Enterprise';
  // 其它值（如 "chatgptpro"）保留原样但首字母大写
  return s.charAt(0).toUpperCase() + s.slice(1);
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

  // 会员等级 + 到期：右上角 badge 显示等级，标题下显示到期倒计时/日期
  const planInfo = data.planInfo || {};
  const planName = planInfo.plan || (typeof data.plan === 'string' ? data.plan : '') || 'Codex';
  const planBadge = `<span class="w-badge sb-plan-badge">${esc(planName)}</span>`;
  let expiryLine = '';
  if (planInfo.expiresAt) {
    const diffMs = planInfo.expiresAt - Date.now();
    const expired = diffMs <= 0;
    const dateStr = new Date(planInfo.expiresAt).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
    expiryLine = `<div class="sb-expiry ${expired ? 'expired' : ''}">
      ${expired ? '已于 ' + esc(dateStr) + ' 到期' : '到期 ' + esc(dateStr) + '（' + fmtCountdown(diffMs) + '）'}
    </div>`;
  }

  return `
    <div class="w-head">
      <span class="w-title">${esc(inst?.title || data.name)}</span>
      ${planBadge}
    </div>
    ${expiryLine}
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

    const { windows, plan: planInfo } = await fetchCodex(config, ctx);

    // 预警：任一窗口剩余 <= 预警线即整体标红
    const warnLine = num(config.warnPercent || 20);
    const warn = windows.some((w) => w.remainPct !== null && w.remainPct <= warnLine);

    return { name, plan: plan || '', planInfo, windows, warn };
  },

  renderSmall(data, config, inst) {
    return renderWindows(data, inst);
  },

  render(data, config, inst) {
    return renderWindows(data, inst);
  }
};
