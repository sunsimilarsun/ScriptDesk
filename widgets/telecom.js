// 话费/流量/语音三环组件：多运营商适配器 + 纯原生 SVG 渲染。
// 所有网络请求统一经 netFetch，由 DNR 在网络层注入 Cookie / User-Agent / Referer。
import { syncBrowserCookie, extractToken } from '../core/cookie-sync.js';

// ---------- 工具 ----------
function getByPath(obj, path) {
  if (!path) return obj;
  return String(path).split('.').reduce((a, k) => (a == null ? undefined : a[k]), obj);
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
// 合并手动 Cookie 与浏览器 Cookie（同名以浏览器登录态为准）
function mergeCookie(base, extra) {
  const map = new Map();
  for (const part of String(base || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) map.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  for (const part of String(extra || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) map.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return [...map].map(([k, v]) => `${k}=${v}`).join('; ');
}

// 自定义请求头 JSON → 对象；大小写不敏感的取值/合并
function parseHeaders(text) {
  if (!text) return {};
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    throw new Error('自定义请求头不是合法 JSON');
  }
}
function headerValue(headers, name) {
  const key = Object.keys(headers || {}).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : '';
}

// ---------- 中国联通 ----------
const UNICOM_NEW_URL = 'https://mxx.client.10010.com/servicequerybusiness/balancenew/accountBalancenew.htm';
const UNICOM_OLD_URL = 'https://m.client.10010.com/mobileserviceimportant/home/queryUserInfoSeven?version=iphone_c@10.0100&desmobiel=&showType=0';
const UNICOM_USAGE_FIVE_URL = 'https://m.client.10010.com/mobileService/home/queryUserInfoFive.htm';
// 余量查询页 yuliangchaxunsfwt 实际调用的接口（与话费页同域，可直接复用同步到的 Cookie）
const UNICOM_OCS_USAGE_URL = 'https://mxx.client.10010.com/servicequerybusiness/operationservice/queryOcsPackageFlowLeftContentRevisedInJune';
// queryUserInfoSeven 解析器：data.dataList 里按 type 取 话费/流量/语音
// queryUserInfoFive/Seven 的 data.dataList 下标：0 流量、1 话费、2 语音、3 积分。
// 先按 type/name 识别，识别不到再按下标兜底，避免不同省份字段命名不一致。
function parseUnicomList(dataList) {
  const list = Array.isArray(dataList) ? dataList : [];
  const find = (...types) => list.find((i) => types.includes(String(i.type || i.name || '').toLowerCase()));
  const at = (i) => list[i] || {};
  const fee = find('fee', 'balance', '话费', 'balancefee', 'accountbalance') || at(1);
  const flow = find('flow', 'data', '流量', 'flux', 'remainingflow', 'generalflow') || at(0);
  const voice = find('voice', '语音', 'minute', 'callminute') || at(2);
  return {
    fee: num(fee?.number ?? fee?.value ?? fee?.balance),
    flow: num(flow?.number ?? flow?.value ?? flow?.balance),
    flowUnit: flow?.unit || 'GB',
    flowTotal: num(flow?.total ?? flow?.totalNumber),
    voice: num(voice?.number ?? voice?.value ?? voice?.balance),
    voiceUnit: voice?.unit || '分钟',
    voiceTotal: num(voice?.total ?? voice?.totalNumber)
  };
}

// 新版综合账单：curntbalancecust 就是页面顶部的「剩余话费」
function parseUnicomBalance(json) {
  const raw = json?.curntbalancecust ?? json?.balance ?? json?.fee;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new Error('联通余额响应缺少 curntbalancecust 字段');
  }
  return {
    operator: 'unicom',
    fee: num(raw),
    flow: null,
    voice: null,
    flowUnit: 'GB',
    voiceUnit: '分钟',
    detail: {
      carryOver: json.newCarryOverArrears ?? null,
      deposit: json.newDepositForTheMonth ?? null,
      consumed: json.realfeecustnew ?? null
    }
  };
}

// 余量查询页 OCS 响应（queryOcsPackageFlowLeftContentRevisedInJune）：
//   剩余流量 = summary.sumresource − summary.rzbMonthused（MB，精确到流量卡展示口径）
//   总量 = summary.sumresource（MB）；语音剩余 = voiceSumresource（分钟）；短信剩余 = smsSumresource（条）
//   remainPercent 是"剩余占封顶量"的比例，不作为"剩余/总量"百分比。
function parseUnicomOcsUsage(json) {
  if (!json || String(json?.code) !== '0000') return null;
  const s = json.summary || {};
  const totalFlowRaw = s.sumresource;
  const usedFlowRaw = s.rzbMonthused;
  const hasFlow = totalFlowRaw !== undefined && totalFlowRaw !== null && String(totalFlowRaw).trim() !== ''
    && usedFlowRaw !== undefined && usedFlowRaw !== null && String(usedFlowRaw).trim() !== '';
  const voiceRaw = json.voiceSumresource;
  const smsRaw = json.smsSumresource;
  const hasVoice = voiceRaw !== undefined && voiceRaw !== null && String(voiceRaw).trim() !== '';
  const hasSms = smsRaw !== undefined && smsRaw !== null && String(smsRaw).trim() !== '';
  if (!hasFlow && !hasVoice && !hasSms) return null;

  // 流量：剩余 = 总量 − 已用，单位从 MB 换算为 GB 展示
  const flowUnitRaw = String(json.canuseFlowAllUnit || '').toUpperCase();
  let flow = null, flowTotal = null;
  let flowUnit = 'MB';
  if (hasFlow) {
    flow = Math.max(0, num(totalFlowRaw) - num(usedFlowRaw));
    flowTotal = num(totalFlowRaw);
    if (flowUnitRaw === 'MB') {
      flow = Math.round(flow / 1024 * 100) / 100;
      flowTotal = Math.round(flowTotal / 1024 * 100) / 100;
      flowUnit = 'GB';
    } else {
      flowUnit = json.canuseFlowAllUnit || 'MB';
    }
  }
  return {
    flow,
    flowUnit,
    flowTotal,
    voice: hasVoice ? num(voiceRaw) : null,
    voiceUnit: json.canuseVoiceAllUnit || '分钟',
    voiceTotal: hasVoice ? num(voiceRaw) + num(json.voiceHeadUsed) : null,
    sms: hasSms ? num(smsRaw) : null,
    smsUnit: json.smsUnit || '条'
  };
}

// 会话失效判定：无 dataList 或响应里出现登录/过期关键词
function unicomExpired(json) {
  if (!json) return true;
  const text = JSON.stringify(json).toLowerCase();
  if (!json?.data?.dataList && /login|登录|token|expire|失效|过期|超时/.test(text)) return true;
  return /not.?login|未登录|登录失效|会话过期|token.*(expire|invalid)/.test(text);
}

// token_online 续期：请求 onLine.htm 刷新登录态后，重新从浏览器 Cookie 罐同步
async function renewUnicom(config, ctx) {
  const token = config.token_online || extractToken(config.cookie || '');
  if (!token) throw new Error('会话已过期，请重新同步 Cookie 或填写 token_online');
  const url = `https://m.client.10010.com/mobileService/onLine.htm?token_online=${encodeURIComponent(token)}`;
  // 续期请求本身也走 netFetch 注入 UA / Referer
  await ctx.netFetch(url, { headers: { 'User-Agent': ctx.UA.unicom, 'Referer': ctx.REFERER.unicom } });

  // 浏览器登录态刷新后，从 Cookie 罐重新读取并合并
  let fresh = '';
  try { fresh = await syncBrowserCookie('unicom'); } catch (_) { /* 保留原 Cookie 兜底 */ }
  return mergeCookie(config.cookie, fresh);
}

// ---------- 多运营商适配器框架 ----------
const ADAPTERS = {
  unicom: {
    name: '中国联通',
    url: UNICOM_NEW_URL,
    oldUrl: UNICOM_OLD_URL,
    uaKey: 'unicom',

    async fetch(config, ctx) {
      return (config.unicomApi || 'new') === 'old'
        ? this.fetchOld(config, ctx)
        : this.fetchNew(config, ctx);
    },

    // 当前页面实际调用的接口：POST 表单，version=WT 必需
    async fetchNew(config, ctx) {
      const extra = parseHeaders(config.customHeaders);
      const headers = {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'Referer': ctx.REFERER?.unicomPage || 'https://imgxx.client.10010.com/shengyuhuafeiwt2024/index.html#/',
        'Origin': ctx.ORIGIN?.unicomH5 || 'https://imgxx.client.10010.com',
        ...extra
      };
      // 手动 Cookie 与自定义头里的 Cookie 合并，手动值优先
      headers.Cookie = mergeCookie(headerValue(headers, 'Cookie'), config.cookie || '');

      // 与页面 axios 拦截器一致：即使无业务参数，也要带 version=WT
      const body = 'duanlianjieabc=&channelCode=&serviceType=&saleChannel=&externalSources=&contactCode=&version=WT';
      const res = await ctx.netFetch(this.url, { method: 'POST', headers, body });
      if (!res.ok) throw new Error(`联通余额接口 HTTP ${res.status}`);

      let json;
      try { json = await res.json(); }
      catch { throw new Error('联通余额接口返回的不是 JSON'); }

      if (json === '999999' || String(json?.code) === '1001') {
        throw new Error('联通登录态已失效：请在「剩余话费」页重新登录，再点同步浏览器 Cookie');
      }
      if (!json || String(json.code) !== '0000') {
        throw new Error(json?.msg ? `联通余额查询失败：${json.msg}` : '联通余额查询失败，请稍后重试');
      }
      const base = parseUnicomBalance(json);
      const usage = await this.fetchUsage(config, ctx);
      // 旧余量接口只补流量/语音，话费仍以新接口为准
      return usage ? { ...base, ...usage, fee: base.fee } : base;
    },

    // 流量/语音：优先用余量查询页 OCS 接口（与话费页同域 Cookie），失败再退回 APP 旧接口。
    // 拿不到就返回 null，卡片显示 --，不把失败伪装成 0。
    async fetchUsage(config, ctx) {
      if ((config.unicomUsageMode || 'auto') === 'off') return null;

      // 1) 余量查询页 yuliangchaxunsfwt 当前实际调用的接口
      if (config.cookie) {
        try {
          const headers = {
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'Referer': 'https://imgxx.client.10010.com/',
            'Origin': 'https://imgxx.client.10010.com',
            'Cookie': config.cookie
          };
          const body = 'duanlianjieabc=&channelCode=&serviceType=&saleChannel=&externalSources=&contactCode=&ticket=&ticketPhone=&ticketChannel=&version=WT&userNumber=&language=chinese';
          const res = await ctx.netFetch(UNICOM_OCS_USAGE_URL, { method: 'POST', headers, body });
          if (res.ok) {
            const text = await res.text();
            let json;
            try { json = JSON.parse(text); } catch { json = text; }
            if (json !== '999999' && String(json?.code) === '0000') {
              const parsed = parseUnicomOcsUsage(json);
              if (parsed && (parsed.flow !== null || parsed.voice !== null)) return parsed;
            }
          }
        } catch (_) { /* 继续尝试旧接口 */ }
      }

      // 2) 旧 APP 余量接口：需要 a_token，或同步到的 Cookie 里恰好含 APP 登录态
      const token = String(config.unicomUsageToken || '').trim();
      const attempts = [];
      if (token) {
        attempts.push(
          { url: UNICOM_USAGE_FIVE_URL, cookie: `a_token=${token}` },
          { url: this.oldUrl, cookie: `a_token=${token}` }
        );
      }
      if (config.cookie) {
        attempts.push(
          { url: UNICOM_USAGE_FIVE_URL, cookie: config.cookie },
          { url: this.oldUrl, cookie: config.cookie }
        );
      }

      for (const attempt of attempts) {
        try {
          const res = await ctx.netFetch(attempt.url, {
            headers: {
              'User-Agent': ctx.UA.unicom,
              'Referer': ctx.REFERER.unicom,
              'Cookie': attempt.cookie
            }
          });
          if (!res.ok) continue;
          const text = await res.text();
          let json;
          try { json = JSON.parse(text); } catch { json = text; }
          if (json === '999999' || /熔断|接口熔断/.test(String(json?.msg || ''))) continue;
          if (String(json?.code) === '1001' || String(json?.code) === '9999') continue;
          const list = json?.data?.dataList;
          if (!Array.isArray(list) || !list.length) continue;
          const parsed = parseUnicomList(list);
          if (parsed.flow > 0 || parsed.voice > 0) return parsed;
        } catch (_) { /* 尝试下一个接口 */ }
      }
      return null;
    },

    // 旧接口保留，便于回退对比
    async fetchOld(config, ctx) {
      const headers = {
        'User-Agent': ctx.UA.unicom,
        'Referer': ctx.REFERER.unicom,
        'Cookie': config.cookie || ''
      };
      let res = await ctx.netFetch(this.oldUrl, { headers });
      let json = await res.json();

      if (unicomExpired(json) && (config.token_online || extractToken(config.cookie || ''))) {
        const renewed = await renewUnicom(config, ctx);
        res = await ctx.netFetch(this.oldUrl, { headers: { ...headers, Cookie: renewed } });
        json = await res.json();
      }
      if (unicomExpired(json) || !json?.data?.dataList) {
        throw new Error('旧接口会话已过期，请改用新版接口或重新同步 Cookie');
      }
      return { operator: 'unicom', ...parseUnicomList(json.data.dataList) };
    }
  },

  // 中国电信：框架已预留，接口 URL / 解析按实际抓包补充即可
  telecom: {
    name: '中国电信',
    url: '',
    uaKey: 'telecom',
    async fetch(config, ctx) {
      if (!config.customUrl) throw new Error('电信适配器待配置：请使用 custom 模式填写接口 URL 与字段路径');
      return genericFetch(config, ctx, 'telecom');
    }
  },

  // 中国移动：框架已预留，同上
  mobile: {
    name: '中国移动',
    url: '',
    uaKey: 'mobile',
    async fetch(config, ctx) {
      if (!config.customUrl) throw new Error('移动适配器待配置：请使用 custom 模式填写接口 URL 与字段路径');
      return genericFetch(config, ctx, 'mobile');
    }
  },

  // 自定义接口：URL + Headers(JSON) + 点号路径映射到 fee / flow / voice
  custom: {
    name: '自定义',
    async fetch(config, ctx) {
      return genericFetch(config, ctx, 'custom');
    }
  }
};

// custom / 电信移动框架共用：点号路径取值
async function genericFetch(config, ctx, operator) {
  const url = (config.customUrl || '').trim();
  if (!url) throw new Error('未配置接口 URL');
  let headers = {};
  if (config.customHeaders) {
    try { headers = JSON.parse(config.customHeaders); }
    catch { throw new Error('请求头不是合法 JSON'); }
  }
  // 手动 Cookie 始终注入（可与自定义头里的 Cookie 合并）
  if (config.cookie) headers.Cookie = mergeCookie(headers.Cookie, config.cookie);

  const res = await ctx.netFetch(url, { headers });
  const json = await res.json();
  const pick = (p) => getByPath(json, p);
  const fee = num(pick(config.pathFee));
  const flow = num(pick(config.pathFlow));
  const voice = num(pick(config.pathVoice));
  if (!config.pathFee && !config.pathFlow && !config.pathVoice) {
    throw new Error('未配置字段路径（fee / flow / voice）');
  }
  const flowTotal = num(pick(config.pathFlowTotal));
  const voiceTotal = num(pick(config.pathVoiceTotal));
  return {
    operator, fee, flow, voice,
    flowUnit: config.flowUnit || 'GB',
    voiceUnit: config.voiceUnit || '分钟',
    flowTotal, voiceTotal
  };
}

// ---------- 组件定义 ----------
export default {
  id: 'telecom',
  name: '话费三环',
  defaultSize: 'medium',
  refreshMinutes: 180,

  settingsSchema: [
    { key: 'operator', label: '运营商', type: 'select', default: 'unicom', options: [
      { value: 'unicom', label: '中国联通' },
      { value: 'telecom', label: '中国电信（框架）' },
      { value: 'mobile', label: '中国移动（框架）' },
      { value: 'custom', label: '自定义接口' }
    ] },
    { key: 'unicomApi', label: '联通接口版本', type: 'select', default: 'new', options: [
      { value: 'new', label: '新版综合账单（推荐）' },
      { value: 'old', label: '旧版 queryUserInfoSeven' }
    ] },
    { key: 'unicomUsageMode', label: '流量/语音来源', type: 'select', default: 'auto', options: [
      { value: 'auto', label: '自动尝试（推荐）' },
      { value: 'off', label: '不查询，只显示话费' }
    ] },
    { key: 'unicomUsageToken', label: '联通 APP a_token（仅本机填写）', type: 'password', placeholder: '从联通 APP 首页“流量查询”抓包获取，用于流量/语音' },
    { key: 'cookie', label: 'Cookie（建议在「剩余话费」或「余量查询」页登录后同步）', type: 'cookie', placeholder: '点下方按钮同步，或粘贴抓包 Cookie' },
    { key: 'token_online', label: 'token_online（联通续期用，可选）', type: 'text', placeholder: '会话失效时自动续期' },
    { key: 'warnFee', label: '话费预警线（元）', type: 'number', default: 20 },
    { key: 'customUrl', label: '自定义接口 URL', type: 'text', placeholder: '电信/移动/custom 模式填写' },
    { key: 'customHeaders', label: '自定义请求头（JSON）', type: 'textarea', placeholder: '{"User-Agent":"...","Referer":"..."}', default: '{}' },
    { key: 'pathFee', label: '话费字段路径', type: 'text', placeholder: 'data.balance' },
    { key: 'pathFlow', label: '流量字段路径', type: 'text', placeholder: 'data.flow' },
    { key: 'pathVoice', label: '语音字段路径', type: 'text', placeholder: 'data.voice' },
    { key: 'pathFlowTotal', label: '流量总量路径（算百分比）', type: 'text', placeholder: 'data.flowTotal' },
    { key: 'pathVoiceTotal', label: '语音总量路径（算百分比）', type: 'text', placeholder: 'data.voiceTotal' },
    { key: 'flowUnit', label: '流量单位', type: 'text', default: 'GB' },
    { key: 'voiceUnit', label: '语音单位', type: 'text', default: '分钟' }
  ],

  async fetchData(config, ctx) {
    // 补全各运营商 UA / Referer 供续期与适配器使用
    const enriched = {
      ...ctx,
      UA: {
        unicom: 'ChinaUnicom4.x/10.01 (iPhone; iOS 16.0)',
        telecom: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
        mobile: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
      },
      REFERER: {
        unicom: 'https://m.client.10010.com/',
        unicomPage: 'https://imgxx.client.10010.com/shengyuhuafeiwt2024/index.html#/',
        telecom: 'https://m.189.cn/',
        mobile: 'https://m.10086.cn/'
      },
      ORIGIN: {
        unicomH5: 'https://imgxx.client.10010.com'
      }
    };
    const adapter = ADAPTERS[config.operator] || ADAPTERS.unicom;
    const data = await adapter.fetch(config, enriched);
    // 计算剩余百分比（无总量时不显示百分比，给 -1 让渲染走中性态）
    data.flowPercent = data.flowTotal > 0 ? Math.min(100, Math.round(data.flow / data.flowTotal * 100)) : -1;
    data.voicePercent = data.voiceTotal > 0 ? Math.min(100, Math.round(data.voice / data.voiceTotal * 100)) : -1;
    data.warnFee = Number(config.warnFee || 20);
    return data;
  },

  render(data, config, inst, rec) {
    const id = String(inst?.instanceId || 'x').replace(/[^a-zA-Z0-9_-]/g, '');
    const expired = rec?.error && /过期|续期|登录|cookie|token/i.test(rec.error);
    const brand = { unicom: '#e60012', telecom: '#0066cc', mobile: '#0078d4', custom: '#64748b' }[data.operator] || '#2563eb';
    const lowFee = num(data.fee) < num(data.warnFee || 20);
    const head = `
      <div class="w-head">
        <span class="w-title">${inst?.title || '话费三环'}</span>
        ${expired
          ? `<span class="w-badge warn" style="cursor:pointer" data-action="renew">已过期 · 点击续期</span>`
          : `<span class="w-badge">${ADAPTERS[data.operator]?.name || '自定义'}</span>`}
      </div>`;

    // 渐变环：ID 含 instanceId，避免多卡 SVG 定义冲突
    const ring = (key, value, unit, percent, c1, c2, size) => {
      const gid = `tc-${key}-${id}`;
      const p = percent >= 0 ? Math.max(0, Math.min(100, percent)) : -1;
      const r = 30, c = 2 * Math.PI * r;
      const off = p >= 0 ? (c * (1 - p / 100)).toFixed(1) : c.toFixed(1);
      return `<div class="tc-ring" style="width:${size}px;height:${size}px">
        <svg viewBox="0 0 80 80" width="${size}" height="${size}">
          <defs><linearGradient id="${gid}" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/>
          </linearGradient></defs>
          <circle cx="40" cy="40" r="${r}" fill="none" stroke="var(--track)" stroke-width="7"/>
          ${p >= 0 ? `<circle cx="40" cy="40" r="${r}" fill="none" stroke="url(#${gid})" stroke-width="7"
            stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off}"
            transform="rotate(-90 40 40)"/>` : ''}
          <text x="40" y="38" text-anchor="middle" class="tc-ring-val">${value}</text>
          <text x="40" y="51" text-anchor="middle" class="tc-ring-unit">${p >= 0 ? p + '%' : unit}</text>
        </svg>
      </div>`;
    };

    const feeBlock = `<div class="tc-fee ${lowFee ? 'low' : ''}">
        <div class="tc-fee-num">${data.fee ?? '--'}<small> 元</small></div>
        <div class="tc-fee-label">剩余话费 ${lowFee ? '· 偏低' : ''}</div>
      </div>`;
    const brandBar = `<i class="tc-brand" style="background:${brand}"></i>`;
    const flowRing = ring('flow', data.flow ?? '--', data.flowUnit || 'GB', data.flowPercent, '#2563eb', '#38bdf8', 78);
    const voiceRing = ring('voice', data.voice ?? '--', data.voiceUnit || '分钟', data.voicePercent, '#7c3aed', '#f472b6', 78);

    return `${head}<div class="tc-body tc-medium">
        <div class="tc-col">${brandBar}${feeBlock}</div>
        <div class="tc-col tc-ring-col">${flowRing}<div class="tc-ring-label">流量 ${data.flowUnit || 'GB'}</div></div>
        <div class="tc-col tc-ring-col">${voiceRing}<div class="tc-ring-label">语音 ${data.voiceUnit || '分钟'}</div></div>
      </div>`;
  },

  // 小卡：话费在上，下方双环
  renderSmall(data, config, inst, rec) {
    const id = String(inst?.instanceId || 'x').replace(/[^a-zA-Z0-9_-]/g, '');
    const lowFee = num(data.fee) < num(data.warnFee || 20);
    const ring = (key, value, unit, percent, c1, c2) => {
      const gid = `tc-${key}-${id}`;
      const p = percent >= 0 ? Math.max(0, Math.min(100, percent)) : -1;
      const r = 26, c = 2 * Math.PI * r;
      const off = p >= 0 ? (c * (1 - p / 100)).toFixed(1) : c.toFixed(1);
      return `<div class="tc-ring" style="width:60px;height:60px">
        <svg viewBox="0 0 68 68" width="60" height="60">
          <defs><linearGradient id="${gid}" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/>
          </linearGradient></defs>
          <circle cx="34" cy="34" r="${r}" fill="none" stroke="var(--track)" stroke-width="6"/>
          ${p >= 0 ? `<circle cx="34" cy="34" r="${r}" fill="none" stroke="url(#${gid})" stroke-width="6"
            stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off}"
            transform="rotate(-90 34 34)"/>` : ''}
          <text x="34" y="32" text-anchor="middle" class="tc-ring-val">${value}</text>
          <text x="34" y="44" text-anchor="middle" class="tc-ring-unit">${p >= 0 ? p + '%' : unit}</text>
        </svg></div>`;
    };
    return `<div class="w-head"><span class="w-title">${inst?.title || '话费三环'}</span>
        <span class="w-badge ${lowFee ? 'warn' : ''}">¥${data.fee ?? '--'}</span></div>
      <div class="tc-small">
        <div class="tc-small-top tc-fee ${lowFee ? 'low' : ''}">剩余话费 <b>${data.fee ?? '--'}</b> 元</div>
        <div class="tc-small-rings">
          ${ring('flow', data.flow ?? '--', data.flowUnit || 'GB', data.flowPercent, '#2563eb', '#38bdf8')}
          ${ring('voice', data.voice ?? '--', data.voiceUnit || '分钟', data.voicePercent, '#7c3aed', '#f472b6')}
        </div>
      </div>`;
  }
};
