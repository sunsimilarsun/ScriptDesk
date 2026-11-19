// AI API 用量与余额组件：六平台适配器 + 本地快照差分算日耗 + 双尺寸渲染。
// 所有请求经 ctx.netFetch，由 DNR 在网络层注入 Authorization / x-api-key 等受限头。
// 快照落在 chrome.storage.local 的 snapshots:<instanceId>，按日归档、保留近 7 天。

// ---------- 工具 ----------
const num = (v) => {
  if (typeof v === 'string' && v.trim() === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n) => Math.round(num(n) * 100) / 100;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function dateKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseDay(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1).getTime();
}
const daysBetween = (a, b) => Math.round((parseDay(b) - parseDay(a)) / 86400000);

// 由 response 拉 JSON；连通性检查：网络异常 / 非 2xx / 非 JSON 都给出明确原因，
// 避免错误响应体被当成正常数据解析出余额 0。
const snippet = (s, n = 80) => String(s || '').replace(/\s+/g, ' ').slice(0, n);
async function req(ctx, url, headers, method = 'GET', body = undefined) {
  let res;
  try {
    res = await ctx.netFetch(url, { method, headers, body });
  } catch (e) {
    throw new Error(`无法连接接口：${e.message}`);
  }
  let text = '';
  try { text = await res.text(); }
  catch (e) { throw new Error(`读取响应失败：${e.message}`); }
  let json;
  try { json = text ? JSON.parse(text) : {}; }
  catch (_) {
    throw new Error(`接口返回非 JSON（HTTP ${res.status}）${snippet(text) ? '：' + snippet(text) : ''}`);
  }
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || json?.msg ||
      (typeof json?.error === 'string' ? json.error : '') || json?.detail || snippet(text);
    throw new Error(`HTTP ${res.status}：${String(msg).slice(0, 120)}`);
  }
  return json;
}
// 标准 Bearer 头，允许 customHeaders 覆盖/补充
function bearer(config, extra = {}) {
  const headers = {
    'Authorization': `Bearer ${config.apiKey || ''}`,
    'Accept': 'application/json',
    ...extra
  };
  if (config.customHeaders) {
    try { Object.assign(headers, JSON.parse(config.customHeaders)); }
    catch (_) { /* 忽略非法自定义头，标准头仍可用 */ }
  }
  return headers;
}
// 当月第一天（YYYY-MM-DD），供 cost 类接口限定区间
function monthStart(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
const todayStr = (now = Date.now()) => dateKey(now);

// 硅基流动国内站：余额 API 已于 2026-08-14 下线（HTTP 410 / code 20092），
// 只能读控制台登录态：expensebill 响应头 x-subject-id → profile/peek 的 financialInfo.balance。
// 金额是 10⁻¹² 元为单位的整数字符串，需除以 1e12。
async function fetchSiliconFlowWeb(config, ctx) {
  const cookie = (config.cookie || '').trim();
  if (!cookie) {
    throw new Error('硅基流动国内站余额需控制台登录态：请先「去官网登录」，再「同步浏览器 Cookie」');
  }
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const referer = 'https://cloud.siliconflow.cn/';
  const base = { 'User-Agent': ua, 'Referer': referer, 'Cookie': cookie };

  // 第一步：拿 x-subject-id（无登录态会 307 到登录页，此时该头缺失）
  const step1 = await ctx.netFetch('https://cloud.siliconflow.cn/me/expensebill', { headers: base });
  const subject = step1.headers?.get?.('x-subject-id');
  if (!subject) throw new Error('控制台登录态失效：请重新登录 cloud.siliconflow.cn 并同步 Cookie');

  // 第二步：拿钱包余额
  const step2 = await req(ctx, 'https://cloud.siliconflow.cn/walletd-server/api/v1/subject/profile/peek', {
    ...base, 'x-subject-id': subject, 'Accept': 'application/json'
  });
  const raw = step2?.data?.financialInfo?.balance ?? step2?.financialInfo?.balance ?? step2?.data?.balance;
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) {
    throw new Error('控制台余额字段格式异常，请反馈此提示');
  }
  const total = round2(Number(raw) / 1e12);
  return {
    currency: '¥', primaryValue: total, primaryLabel: '余额', balance: total, isSpendType: false,
    extra: [
      { label: '数据源', value: '控制台登录态' },
      { label: '账户', value: subject.slice(0, 8) + '…' }
    ]
  };
}

// ---------- 六平台适配器 ----------
// 每个适配器返回：{ currency, primaryValue, primaryLabel, balance, isSpendType, extra[] , ... }
// balance 是"用于差分的量"：余额型=可用余额（越大越富余）；消费型=-累计消费（消费增加则 balance 下降）。
// 二者统一满足：今日消耗 = max(0, 基线 balance - 当前 balance)，语义一致。
const PLATFORMS = {
  deepseek: {
    name: 'DeepSeek',
    consoleUrl: 'https://platform.deepseek.com/usage',
    async fetch(config, ctx) {
      const json = await req(ctx, 'https://api.deepseek.com/user/balance', bearer(config));
      const infos = json.balance_infos;
      if (!Array.isArray(infos) || !infos.length) {
        throw new Error('响应缺少 balance_infos，请确认 Key 具备余额查询权限');
      }
      // 官方可能按币种返回多条（CNY / USD）；优先取人民币账户，避免误取到余额为 0 的那条。
      const info = infos.find((x) => String(x?.currency || '').toUpperCase() === 'CNY') || infos[0] || {};
      const rawTotal = info.total_balance;
      // 欠费账户该字段可能是 "--" / "--.--" / null / 空串，num() 会静默变 0 —— 明确识别并提示。
      const t = String(rawTotal ?? '').trim().toLowerCase();
      if (['', '--', '-', 'null', 'n/a'].includes(t) || /^-{2,}(\.-+|\.\d+)?$/.test(t)) {
        throw new Error(`余额字段无效（total_balance=${JSON.stringify(rawTotal)}，可能是欠费账户），请把「测试连接」的原始响应发我`);
      }
      if (rawTotal === undefined) throw new Error('响应缺少 total_balance 字段');
      const cur = String(info.currency || 'CNY').toUpperCase();
      const currency = ['USD', 'US$'].includes(cur) ? '$' : '¥';
      const total = num(rawTotal);
      const gift = num(info.granted_balance);
      const topUp = num(info.topped_up_balance);
      return {
        currency, primaryValue: total, primaryLabel: total < 0 ? '欠费' : '余额',
        balance: total, isSpendType: false, overdue: total < 0,
        totalQuota: round2(gift + topUp),
        extra: [
          { label: '赠金', value: `${currency}${gift}` },
          { label: '充值', value: `${currency}${topUp}` }
        ]
      };
    }
  },

  siliconflow: {
    name: '硅基流动',
    consoleUrl: 'https://cloud.siliconflow.cn/me/expensebill',
    needsKey: false, // 国内站走控制台 Cookie，国际站才用 Key
    async fetch(config, ctx) {
      // 国内站默认走控制台登录态；手动切到 api 模式则走国际站 Key
      if ((config.sfMode || 'web') === 'web') {
        return fetchSiliconFlowWeb(config, ctx);
      }
      if (!config.apiKey) throw new Error('国际站模式请填写 API Key');
      const json = await req(ctx, 'https://api.siliconflow.com/v1/user/info', bearer(config));
      if (json.code === 20092) throw new Error('国内站余额 API 已下线，请把模式切回「控制台登录态」');
      if (json.code && json.code !== 20000) throw new Error(`接口返回错误码 ${json.code}：${json.msg || json.message || ''}`);
      const d = json.data || json;
      if (d.totalBalance === undefined && d.balance === undefined) {
        throw new Error('响应缺少 totalBalance 字段，请检查 Key 权限或接口结构');
      }
      const total = num(d.totalBalance ?? d.balance);
      const gift = num(d.balance ?? d.giftBalance ?? d.grantedBalance ?? d.bonus);
      const topUp = num(d.chargeBalance ?? d.topUpBalance ?? d.rechargeBalance);
      return {
        currency: '$', primaryValue: total, primaryLabel: '余额', balance: total, isSpendType: false,
        totalQuota: round2(gift + topUp),
        extra: [
          { label: '充值余额', value: `$${topUp}` },
          { label: '赠送余额', value: `$${gift}` }
        ]
      };
    }
  },

  openrouter: {
    name: 'OpenRouter',
    consoleUrl: 'https://openrouter.ai/activity',
    platforms: ['openrouter'],
    async fetch(config, ctx) {
      const mode = config.subApi || 'key';
      const url = mode === 'credits'
        ? 'https://openrouter.ai/api/v1/credits'
        : 'https://openrouter.ai/api/v1/key';
      const json = await req(ctx, url, bearer(config, {
        'HTTP-Referer': 'https://openrouter.ai/',
        'X-Title': 'ScriptDesk'
      }));
      const d = json.data || json;
      if (d.usage === undefined && d.total_usage === undefined) {
        throw new Error('响应缺少 usage 字段，请确认端点与 Key 权限');
      }
      // key: { usage, limit }；credits: { total_credits, total_usage }
      const used = num(mode === 'credits' ? (d.total_usage ?? d.usage) : d.usage);
      const limit = num(mode === 'credits' ? (d.total_credits ?? d.limit) : d.limit);
      const hasLimit = limit > 0;
      const remain = hasLimit ? Math.max(0, limit - used) : 0;
      return {
        currency: '$',
        primaryValue: hasLimit ? remain : used,
        primaryLabel: hasLimit ? '剩余额度' : '已用额度',
        balance: hasLimit ? remain : -used,
        isSpendType: !hasLimit,
        totalQuota: hasLimit ? limit : undefined,
        extra: [
          { label: hasLimit ? '总额度' : '额度', value: hasLimit ? `$${limit}` : '不限' },
          { label: '已用', value: `$${round2(used)}` }
        ]
      };
    }
  },

  newapi: {
    name: 'New API',
    consoleUrl: (config) => (config.baseUrl || '').replace(/\/+$/, ''),
    async fetch(config, ctx) {
      const base = (config.baseUrl || '').replace(/\/+$/, '');
      if (!base) throw new Error('未配置 Base URL');
      const h = bearer(config);
      const sub = await req(ctx, `${base}/v1/dashboard/billing/subscription`, h);
      const usage = await req(ctx, `${base}/v1/dashboard/billing/usage`, h);
      if (sub.hard_limit_usd === undefined && sub.soft_limit_usd === undefined && sub.total === undefined) {
        throw new Error('账单响应缺少额度字段（hard_limit_usd / soft_limit_usd）');
      }
      const limit = num(sub.hard_limit_usd ?? sub.soft_limit_usd ?? sub.total);
      const used = num(usage.total_usage ?? usage.total);
      const remain = Math.max(0, limit - used);
      return {
        currency: '$', primaryValue: remain, primaryLabel: '剩余额度', balance: remain, isSpendType: false,
        totalQuota: limit,
        extra: [
          { label: '总额度', value: `$${limit}` },
          { label: '本月已用', value: `$${round2(used)}` }
        ]
      };
    }
  },

  // MoeRouter 等 new-api 系中转站：真实人民币余额在 /api/user/self（需登录态访问令牌 nap_...，
  // 而非 sk- 开头的 API Key）。quota 按 quota_per_unit 换算美元，再按汇率折算人民币展示。
  moerouter: {
    name: 'MoeRouter',
    consoleUrl: 'https://moerouter.com/console',
    needsKey: false, // 走登录态访问令牌，不是 API Key
    async fetch(config, ctx) {
      const base = (config.baseUrl || 'https://moerouter.com').replace(/\/+$/, '');
      // 访问令牌两级降级：优先用组件里手动填的 accessToken，为空则回退读 webRequest 自动捕获的 moerouterAuth
      let token = (config.accessToken || '').trim();
      if (!token) {
        try {
          const got = await chrome.storage.local.get(['moerouterAuth']);
          token = got.moerouterAuth?.access_token || '';
        } catch (_) { /* storage 不可用视为无 */ }
      }
      if (!token) {
        throw new Error('未获取访问令牌：请打开 moerouter.com 登录一次（自动捕获），或手动粘贴 nap_ 开头的访问令牌');
      }
      // 访问令牌走 /api/user/self（Nap 前缀 access token，非 sk- API Key）
      const json = await req(ctx, `${base}/api/user/self`, {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      });
      const d = json.data || json;
      const quota = num(d.quota);
      const used = num(d.used_quota);
      if (d.quota === undefined && d.used_quota === undefined) {
        throw new Error('响应缺少 quota / used_quota 字段，请确认令牌有效或接口结构');
      }
      // new-api 口径：quota_per_unit 默认为 500000（= 1 美元），按汇率折算人民币
      const perUnit = num(config.quotaPerUnit || 500000);
      const rate = num(config.exchangeRate || 7.3);
      const totalCny = round2(quota / perUnit * rate);
      const usedCny = round2(used / perUnit * rate);
      const remainCny = round2(Math.max(0, totalCny - usedCny));
      return {
        currency: '¥', primaryValue: remainCny, primaryLabel: '余额', balance: remainCny, isSpendType: false,
        totalQuota: totalCny,
        extra: [
          { label: '账户', value: (d.display_name || d.username || d.id || '').slice(0, 14) || '—' },
          { label: '总额度', value: `¥${totalCny}` },
          { label: '已用', value: `¥${usedCny}` },
          { label: '请求次数', value: `${d.request_count ?? 0}` }
        ]
      };
    }
  },

  'openai-admin': {
    name: 'OpenAI Admin',
    consoleUrl: 'https://platform.openai.com/usage',
    async fetch(config, ctx) {
      const h = bearer(config, config.orgId ? { 'OpenAI-Organization': config.orgId } : {});
      const url = `https://api.openai.com/v1/organization/costs?start_date=${monthStart()}&end_date=${todayStr()}`;
      const json = await req(ctx, url, h);
      if (!Array.isArray(json.data)) throw new Error('响应缺少 data 数组，请确认 Admin Key 权限与日期参数');
      const rows = json.data;
      let sum = 0;
      for (const r of rows) {
        const a = r.amount;
        sum += num(a?.value ?? (typeof a === 'number' ? a : 0) ?? r.cost);
      }
      return {
        currency: '$', primaryValue: round2(sum), primaryLabel: '本月消费', balance: -sum, isSpendType: true,
        extra: [
          { label: '统计区间', value: `${monthStart().slice(5)} ~ ${todayStr().slice(5)}` },
          { label: '账单项', value: `${rows.length} 条` }
        ]
      };
    }
  },

  'anthropic-admin': {
    name: 'Anthropic Admin',
    consoleUrl: 'https://console.anthropic.com/settings/billing',
    async fetch(config, ctx) {
      const h = {
        'x-api-key': config.apiKey || '',
        'anthropic-version': '2023-06-01',
        'Accept': 'application/json',
        ...(config.customHeaders ? (() => { try { return JSON.parse(config.customHeaders); } catch (_) { return {}; } })() : {})
      };
      const url = `https://api.anthropic.com/v1/organizations/analytics/cost?start_date=${monthStart()}&end_date=${todayStr()}`;
      const json = await req(ctx, url, h);
      const rows = json.data || json.results;
      if (!Array.isArray(rows)) throw new Error('响应缺少 data/results 成本数组，请检查接口结构');
      let sum = 0;
      for (const r of rows) {
        sum += num(r.cost ?? r.cost_usd ?? r.amount?.value ?? r.amount ?? r.usage);
      }
      return {
        currency: '$', primaryValue: round2(sum), primaryLabel: '本月消费', balance: -sum, isSpendType: true,
        extra: [
          { label: '统计区间', value: `${monthStart().slice(5)} ~ ${todayStr().slice(5)}` },
          { label: '账单项', value: `${rows.length} 条` }
        ]
      };
    }
  },

  // WorkBuddy（腾讯 AI 编程助手）：余额 = 积分（Credits）。
  // 接口 POST /billing/meter/get-user-resource-summary。
  // 网页端鉴权是 Cookie 会话（非 Bearer token），Cookie 与浏览器 UA 强绑定；
  // 桌面端才用 Bearer accessToken（加密存本地，扩展读不到）。详见 fetchWorkbuddyResource。
  workbuddy: {
    name: 'WorkBuddy',
    consoleUrl: 'https://www.workbuddy.cn',
    needsKey: false, // 走 Cookie 会话（主）或 Bearer token（兜底），非 API Key
    async fetch(config, ctx) {
      const d = await fetchWorkbuddyResource(config, ctx);
      const totalCredits = d.TotalCredits ?? d.totalCredits ?? d.total_credits;
      if (totalCredits === undefined) {
        throw new Error('响应缺少 TotalCredits 字段，请确认登录态有效或接口结构');
      }
      // CreditGroups：plan_base / plan_bonus / addon / benefit 四类积分，逐类显示剩余
      const groups = Array.isArray(d.CreditGroups) ? d.CreditGroups : [];
      const groupLabel = { plan_base: '套餐基础', plan_bonus: '套餐赠送', addon: '加量包', benefit: '平台奖励' };
      const extra = [
        { label: '剩余积分', value: `${round2(totalCredits)}` }
      ];
      for (const g of groups) {
        const kind = g?.Kind || g?.kind || '';
        const remain = num(g?.RemainCredits ?? g?.remainCredits ?? g?.remain ?? g?.Remain);
        const label = groupLabel[kind] || kind || '积分';
        extra.push({ label, value: `${round2(remain)}` });
      }
      // 套餐名（若有）
      const planName = d.PlanName ?? d.planName ?? '';
      return {
        currency: '', primaryValue: round2(totalCredits), primaryLabel: '积分', balance: num(totalCredits), isSpendType: false,
        totalQuota: undefined,
        planName,
        extra: extra.slice(0, 5) // 最多展示 5 行明细
      };
    }
  }
};

// WorkBuddy 取数（网页端鉴权机制，已核实）：
// 网页 www.workbuddy.cn 登录后，「套餐与积分」页调 get-user-resource-summary 走的是
// Cookie 会话 + x-client-platform: web 鉴权（不是 Bearer token，Bearer 是桌面端专属，
// 桌面端 token 加密存 ~/.workbuddy/ 扩展读不到）。且 Cookie 会话与浏览器 User-Agent 强绑定：
// UA 版本不一致（哪怕旧一个大版本）服务端直接回 HTTP 401。
// 因此取数顺序改为：
//  1) Cookie 会话（chrome.cookies 读 HttpOnly Cookie + 浏览器真实 UA）—— 主路径
//  2) 手动/捕获的 Bearer accessToken + uid —— 兜底（桌面端 token 场景）
async function fetchWorkbuddyResource(config, ctx) {
  const url = 'https://www.workbuddy.cn/billing/meter/get-user-resource-summary';
  // 浏览器真实 UA（含准确 Chrome 大版本），避免硬编码导致 401；取不到时退回当前 UA 字符串
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent)
    || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';

  // 路径 1：Cookie 会话（网页端真实鉴权方式）
  const { cookieStr, names } = await readWorkbuddyCookie();
  let cookieErr = '';
  if (cookieStr) {
    try {
      const json = await req(ctx, url, {
        'Cookie': cookieStr,
        'x-client-platform': 'web',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Referer': 'https://www.workbuddy.cn/profile/plans-usage',
        'Origin': 'https://www.workbuddy.cn',
        'User-Agent': ua
      }, 'POST', '{}');
      return json?.data || json;
    } catch (err) {
      cookieErr = `${err.message}（已带 ${names.length} 个 Cookie：${names.slice(0, 6).join(', ')}${names.length > 6 ? '…' : ''}）`;
      console.warn('[workbuddy] Cookie 会话失败，尝试 Bearer token：', err.message);
    }
  } else {
    cookieErr = '浏览器未读到 workbuddy.cn 的登录 Cookie';
  }

  // 路径 2：Bearer token 兜底（桌面端 accessToken；X-Account-Uid 与 X-User-Id 双写兼容）
  let token = (config.workbuddyToken || '').trim();
  let uid = (config.workbuddyUid || '').trim();
  if (!token || !uid) {
    try {
      const got = await chrome.storage.local.get(['workbuddyAuth']);
      token = token || got.workbuddyAuth?.access_token || '';
      uid = uid || got.workbuddyAuth?.uid || '';
    } catch (_) { /* 忽略 */ }
  }
  if (token && uid) {
    try {
      const json = await req(ctx, url, {
        'Authorization': `Bearer ${token}`,
        'X-Account-Uid': uid,
        'X-User-Id': uid,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }, 'POST', '{}');
      return json?.data || json;
    } catch (err) {
      // token 也失效：清掉，下次不再用坏 token
      if (String(err.message).includes('401') || String(err.message).includes('invalid_token')) {
        try { await chrome.storage.local.remove('workbuddyAuth'); } catch (_) {}
      }
      throw new Error(
        `两种鉴权都失败。\n[1] Cookie 会话：${cookieErr || '未读取'}\n[2] Bearer token：${err.message}\n` +
        '→ 请在 Chrome 浏览器打开 workbuddy.cn 的「套餐与积分」页并确认已登录，再回来点「测试连接」'
      );
    }
  }

  throw new Error(
    `未获取 WorkBuddy 登录态。\n诊断：${cookieErr || '无 Cookie'}\n` +
    '→ 请在 Chrome 浏览器打开 https://www.workbuddy.cn/profile/plans-usage，确认右上角已显示头像（已登录），再回来点「测试连接」'
  );
}

// 读 workbuddy 域全部 Cookie（含 HttpOnly），返回 { cookieStr, names }
// 关键：chrome://newtab 覆盖页里 chrome.cookies 可能读不到 Cookie（浏览器安全限制），
// 页面上下文通过消息委托给 background service worker 读取（那里 chrome.cookies 肯定可用）；
// service worker 里则直接读。
async function readWorkbuddyCookie() {
  const empty = { cookieStr: '', names: [] };
  const domains = ['workbuddy.cn', 'www.workbuddy.cn', 'workbuddy.ai', 'www.workbuddy.ai'];

  // 页面上下文（有 window）→ 委托 background 读
  if (typeof window !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    try {
      const res = await chrome.runtime.sendMessage({ action: 'readCookies', domains });
      if (res && res.cookieStr) return { cookieStr: res.cookieStr, names: res.names || [] };
      if (res && res.error) console.warn('[workbuddy] background 读 Cookie 失败：', res.error);
    } catch (e) {
      console.warn('[workbuddy] 委托 background 读 Cookie 异常：', e.message);
    }
  }

  // service worker 上下文直接读
  try {
    const all = [];
    for (const d of domains) {
      try {
        const list = await chrome.cookies.getAll({ domain: d });
        if (Array.isArray(list)) all.push(...list);
      } catch (_) { /* 单个域失败继续 */ }
    }
    try {
      const allCookies = await chrome.cookies.getAll({});
      for (const c of allCookies) {
        const host = String(c.domain || '').replace(/^\./, '').toLowerCase();
        if (domains.some((d) => host === d || host.endsWith('.' + d))) {
          all.push(c);
        }
      }
    } catch (_) { /* 忽略 */ }

    const seen = new Map();
    for (const c of all) {
      if (c.name && c.value !== undefined) seen.set(`${c.name}@${c.domain}${c.path}`, c);
    }
    const cookies = [...seen.values()];
    const names = cookies.map((c) => c.name);
    const pairs = cookies.map((c) => `${c.name}=${c.value}`);
    return { cookieStr: pairs.length ? pairs.join('; ') : '', names };
  } catch (_) {
    return empty;
  }
}

// ---------- 本地快照差分（纯函数，便于测试） ----------
// prevSnaps: [{date, baseBalance, balance, spend, recharged, updatedAt}]
// 返回 { snapshots, todaySpend, trend, recharged }
export function computeSnapshots(prevSnaps, balance, now = Date.now()) {
  const b = round2(balance);
  const today = dateKey(now);
  let snaps = Array.isArray(prevSnaps) ? prevSnaps.slice() : [];
  // 只保留近 7 天（含今天），丢弃未来异常记录
  snaps = snaps.filter((s) => s && s.date && daysBetween(s.date, today) >= 0 && daysBetween(s.date, today) <= 6);
  snaps.sort((a, b2) => (a.date < b2.date ? -1 : a.date > b2.date ? 1 : 0));

  let rec = snaps.find((s) => s.date === today);
  if (!rec) {
    // 新的一天：期初基线 = 最近一条观测余额（余额连续）
    const last = snaps.length ? snaps[snaps.length - 1] : null;
    const base = last ? num(last.balance) : b;
    rec = { date: today, baseBalance: base, balance: b, spend: 0, recharged: false, updatedAt: now };
    snaps.push(rec);
  }

  const delta = num(rec.baseBalance) - b;
  if (delta > 0) {
    // 余额下降 → 正常消耗，累计当天消耗
    rec.spend = round2(delta);
  } else if (delta < 0) {
    // 余额上涨（充值）→ 平滑重置当日基线，今日消耗归零，避免出现负数
    rec.baseBalance = b;
    rec.spend = 0;
    rec.recharged = true;
  }
  rec.balance = b;
  rec.updatedAt = now;

  // 近 7 天趋势（6 天前 → 今天）
  const trend = [];
  for (let d = 6; d >= 0; d--) {
    const key = dateKey(now - d * 86400000);
    const s = snaps.find((x) => x.date === key);
    trend.push({ date: key, spend: s ? num(s.spend) : 0 });
  }

  return {
    snapshots: snaps,
    todaySpend: num(rec.spend),
    trend,
    recharged: !!rec.recharged
  };
}

// ---------- 迷你柱状图（纯 SVG，渐变 ID 含 instanceId） ----------
function barChart(trend, instanceId) {
  const id = String(instanceId || 'x').replace(/[^a-zA-Z0-9_-]/g, '');
  const W = 160, H = 76, pad = 6, n = Math.max(1, trend.length);
  const vals = trend.map((t) => Math.max(0, num(t.spend)));
  const max = Math.max(...vals, 0.01);
  const slot = (W - pad * 2) / n;
  const bw = slot * 0.6;
  const baseY = H - 16;
  let bars = '';
  vals.forEach((v, i) => {
    const h = Math.max(2, (v / max) * (baseY - 12));
    const x = pad + i * slot + (slot - bw) / 2;
    const y = baseY - h;
    const today = i === vals.length - 1;
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="url(#ab-bar-${id})" opacity="${today ? 1 : 0.5}"/>`;
    if (today && v > 0) {
      bars += `<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 3).toFixed(1)}" text-anchor="middle" class="ab-bar-val">${v.toFixed(1)}</text>`;
    }
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" aria-label="近7天消耗">
    <defs><linearGradient id="ab-bar-${id}" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0%" stop-color="#2563eb"/><stop offset="100%" stop-color="#38bdf8"/>
    </linearGradient></defs>
    <line x1="0" y1="${baseY}" x2="${W}" y2="${baseY}" stroke="var(--track)" stroke-width="1"/>
    ${bars}
    <text x="${pad}" y="${H - 3}" class="ab-bar-axis">${esc(trend[0]?.date?.slice(5) || '')}</text>
    <text x="${W - pad}" y="${H - 3}" text-anchor="end" class="ab-bar-axis">今天</text>
  </svg>`;
}

// 编辑抽屉「测试连接」用：走同一套适配器与鉴权，但不写快照、不改缓存
export async function testConnection(config, ctx) {
  const platform = config.platform || 'deepseek';
  const adapter = PLATFORMS[platform] || PLATFORMS.deepseek;
  if (adapter.needsKey !== false && !config.apiKey) throw new Error('请先填写 API Key');
  // moerouter 走登录态访问令牌（needsKey=false），token 为空时由适配器内部报错提示
  const data = await adapter.fetch(config, ctx);
  return {
    platformName: adapter.name,
    primaryValue: data.primaryValue,
    primaryLabel: data.primaryLabel,
    currency: data.currency
  };
}

// ---------- 组件定义 ----------
export default {
  id: 'ai-balance',
  name: 'AI 余额',
  defaultSize: 'medium',
  refreshMinutes: 120,

  settingsSchema: [
    { key: 'platform', label: '平台', type: 'select', default: 'deepseek', options: [
      { value: 'deepseek', label: 'DeepSeek' },
      { value: 'siliconflow', label: '硅基流动' },
      { value: 'openrouter', label: 'OpenRouter' },
      { value: 'newapi', label: 'New API / 自建中转' },
      { value: 'moerouter', label: 'MoeRouter 中转站' },
      { value: 'workbuddy', label: 'WorkBuddy 积分' },
      { value: 'openai-admin', label: 'OpenAI Admin' },
      { value: 'anthropic-admin', label: 'Anthropic Admin' }
    ] },
    { key: 'apiKey', label: 'API Key（仅存本机）', type: 'password', testable: true, platforms: ['deepseek', 'siliconflow', 'openrouter', 'newapi', 'openai-admin', 'anthropic-admin'], placeholder: 'sk-... / x-api-key' },
    { key: 'accessToken', label: '访问令牌（MoeRouter 用，nap_ 开头）', type: 'password', platforms: ['moerouter'], carrier: 'moerouter', testable: true, placeholder: 'nap_...（登录后自动捕获，或手动粘贴）' },
    { key: 'quotaPerUnit', label: '额度换算单位（quota 每单位对应美元）', type: 'number', platforms: ['moerouter'], default: 500000 },
    { key: 'exchangeRate', label: '美元兑人民币汇率', type: 'number', platforms: ['moerouter'], default: 7.3 },
    { key: 'workbuddyUid', label: '账户 UID（可选兜底，Cookie 失效时用）', type: 'text', platforms: ['workbuddy'], placeholder: '32ee4e68-...（留空即可，走 Cookie 会话）' },
    { key: 'workbuddyToken', label: '访问令牌（可选兜底，桌面端 token）', type: 'password', platforms: ['workbuddy'], carrier: 'workbuddy', testable: true, placeholder: '留空即可，登录 workbuddy.cn 后自动读 Cookie' },
    { key: 'sfMode', label: '硅基流动取数方式', type: 'select', default: 'web', platforms: ['siliconflow'], options: [
      { value: 'web', label: '国内站 · 控制台登录态（默认，API 已下线）' },
      { value: 'api', label: '国际站 · API Key（api.siliconflow.com）' }
    ] },
    { key: 'cookie', label: '硅基流动控制台 Cookie', type: 'cookie', platforms: ['siliconflow'], placeholder: '点下方按钮登录并同步，或粘贴抓包 Cookie' },
    { key: 'baseUrl', label: 'Base URL（New API 用）', type: 'text', platforms: ['newapi'], placeholder: 'https://api.your-domain.com' },
    { key: 'orgId', label: 'Organization ID（OpenAI Admin 可选）', type: 'text', platforms: ['openai-admin'], placeholder: 'org-...' },
    { key: 'subApi', label: 'OpenRouter 端点', type: 'select', default: 'key', platforms: ['openrouter'], options: [
      { value: 'key', label: '/api/v1/key' },
      { value: 'credits', label: '/api/v1/credits' }
    ] },
    { key: 'warnBalance', label: '余额预警线（低于则高亮；消费型为消费超过线）', type: 'number', default: 10 },
    { key: 'customHeaders', label: '额外请求头（JSON，可选）', type: 'textarea', placeholder: '{"X-Custom":"value"}', default: '{}' }
  ],

  // 供「添加组件」自动填充账单控制台链接；切换平台时编辑抽屉联动更新
  defaultLinkUrl(config) {
    const p = PLATFORMS[config?.platform] || PLATFORMS.deepseek;
    return typeof p.consoleUrl === 'function' ? p.consoleUrl(config || {}) : p.consoleUrl;
  },

  async fetchData(config, ctx) {
    const platform = config.platform || 'deepseek';
    const adapter = PLATFORMS[platform] || PLATFORMS.deepseek;
    // 硅基流动国内站走控制台 Cookie，不需要 API Key；其余平台必须配 Key
    if (adapter.needsKey !== false && !config.apiKey) throw new Error('未配置 API Key');

    const base = await adapter.fetch(config, ctx);

    // 快照：按实例隔离，落盘 chrome.storage.local，保留近 7 天
    const storeKey = `snapshots:${ctx.instanceId || 'default'}`;
    let prev = [];
    try {
      const got = await chrome.storage.local.get([storeKey]);
      prev = got[storeKey] || [];
    } catch (_) { /* 存储不可用时退化为内存态 */ }
    const snap = computeSnapshots(prev, base.balance, Date.now());
    try { await chrome.storage.local.set({ [storeKey]: snap.snapshots }); }
    catch (_) { /* 忽略写入失败，不影响展示 */ }

    return {
      platform,
      platformName: adapter.name,
      ...base,
      todaySpend: snap.todaySpend,
      trend: snap.trend,
      recharged: snap.recharged,
      warnBalance: num(config.warnBalance || 10)
    };
  },

  // small 1×1：平台名 + 主指标大字 + 预警 + 今日消耗
  renderSmall(data, config, inst) {
    const low = data.isSpendType
      ? num(data.primaryValue) > num(data.warnBalance)
      : num(data.primaryValue) < num(data.warnBalance);
    return `
      <div class="w-head">
        <span class="w-title">${esc(inst?.title || data.platformName || 'AI 余额')}</span>
        <span class="w-badge ${low ? 'warn' : ''}">${esc(data.platformName || 'AI')}</span>
      </div>
      <div class="ab-big ${low ? 'low' : ''}">${data.currency ? esc(data.currency) : ''}${esc(data.overdue ? Math.abs(num(data.primaryValue)) : (data.primaryValue ?? '--'))}<small> ${esc(data.primaryLabel || '')}</small></div>
      <div class="ab-foot"><span>今日消耗</span><b>${data.currency ? esc(data.currency) : ''}${esc(data.todaySpend ?? 0)}</b></div>
      ${data.recharged ? '<div class="ab-tag">今日已充值 · 基线已重置</div>' : ''}`;
  },

  // medium 2×1：左侧主指标 + 明细，右侧近 7 天消耗迷你柱状图
  render(data, config, inst) {
    const low = data.isSpendType
      ? num(data.primaryValue) > num(data.warnBalance)
      : num(data.primaryValue) < num(data.warnBalance);
    const cur = data.currency || ''; // 空 currency（如 WorkBuddy 积分）不显示货币符号
    const details = (data.extra || []).map((e) =>
      `<div class="ab-detail"><span>${esc(e.label)}</span><b>${esc(e.value)}</b></div>`).join('');
    const id = String(inst?.instanceId || 'x').replace(/[^a-zA-Z0-9_-]/g, '');
    return `
      <div class="w-head">
        <span class="w-title">${esc(inst?.title || data.platformName || 'AI 余额')}</span>
        <span class="w-badge ${low ? 'warn' : ''}">${esc(data.platformName || 'AI')}${low ? ' · 预警' : ''}</span>
      </div>
      <div class="ab-medium">
        <div class="ab-left">
          <div class="ab-big ${low ? 'low' : ''}">${esc(cur)}${esc(data.overdue ? Math.abs(num(data.primaryValue)) : (data.primaryValue ?? '--'))}<small> ${esc(data.primaryLabel || '')}</small></div>
          <div class="ab-details">
            ${details}
            <div class="ab-detail"><span>今日消耗</span><b class="ab-today">${esc(cur)}${esc(data.todaySpend ?? 0)}</b></div>
          </div>
          ${data.recharged ? '<div class="ab-tag">今日已充值 · 基线已重置</div>' : ''}
        </div>
        <div class="ab-chart">
          <div class="ab-chart-title">近 7 天消耗${cur ? `（${esc(cur)}）` : ''}</div>
          ${barChart(data.trend || [], id)}
        </div>
      </div>`;
  }
};
