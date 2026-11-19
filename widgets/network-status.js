// 当前网络状态：直连 / 分流代理 / 全局代理 / 离线。
// 双路探测（国内直连出口 + 海外代理出口 + 204 延迟）并行，对比出口 IP 自动判定。
// 国内外出口均解析 ip / country / countryCode / region / rtt，缓存后渲染国旗 + 国家名 + IP + 延迟。
// 海外首选 api.ip.sb/geoip，降级 ipwho.is；国内首选 myip.ipip.net/json，降级 ipip.net 纯文本。
// 可选读本机代理控制器（Clash 等）的当前模式；AbortController 4.5s 超时。

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// 探测端点
const PROBES = {
  domestic: {
    // 国内出口：优先 JSON（含国家/省），降级纯文本
    ipUrl: 'https://myip.ipip.net/json',
    ipFallbackUrl: 'https://myip.ipip.net',
    latencyUrl: 'https://www.baidu.com',
    label: '国内直连'
  },
  overseas: {
    // 海外出口：优先 geoip JSON，降级 ipwho.is
    ipUrl: 'https://api.ip.sb/geoip',
    ipFallbackUrl: 'https://ipwho.is/',
    latencyUrl: 'https://www.google.com/generate_204',
    label: '海外代理'
  }
};

// 两位国家码 → 国旗 Emoji（地区指示符号）
export function countryToFlag(code) {
  if (!code || code === 'INTL' || code === 'XX') return '🌐';
  const cc = String(code).toUpperCase().replace(/[^A-Z]/g, '');
  if (cc.length !== 2) return '🌐';
  const base = 0x1F1E6;
  return String.fromCodePoint(base + cc.charCodeAt(0) - 65, base + cc.charCodeAt(1) - 65);
}

// 常用国家码 → 中文名（未命中则回退英文名/码）
const COUNTRY_ZH = {
  CN: '中国', US: '美国', JP: '日本', KR: '韩国', GB: '英国', UK: '英国',
  DE: '德国', FR: '法国', SG: '新加坡', HK: '中国香港', TW: '中国台湾',
  MO: '中国澳门', AU: '澳大利亚', CA: '加拿大', RU: '俄罗斯', IN: '印度',
  NL: '荷兰', SE: '瑞典', CH: '瑞士', IT: '意大利', ES: '西班牙', BR: '巴西',
  TH: '泰国', VN: '越南', MY: '马来西亚', ID: '印度尼西亚', PH: '菲律宾'
};
export function countryName(code, en) {
  if (!code || code === 'INTL') return '海外';
  if (COUNTRY_ZH[code]) return COUNTRY_ZH[code];
  return en || code;
}

// 带超时的探测请求（AbortController 4.5s 超时，原生 fetch 以拿到 signal）
async function fetchWithTimeout(url, headers = {}, ms = 4500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { headers, signal: ctrl.signal, credentials: 'omit' });
  } finally {
    clearTimeout(timer);
  }
}

// 探活 + 延迟（rtt）
async function probe(url, headers = {}) {
  const started = Date.now();
  const res = await fetchWithTimeout(url, headers);
  const ms = Date.now() - started;
  return { ok: res.ok, status: res.status, rtt: ms };
}

// 判断是否 IPv6
export function isIPv6(ip) {
  return /:/.test(String(ip || '')) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip || ''));
}

// 解析 ipip.net 纯文本："当前 IP：1.2.3.4  来自于：中国 北京 联通"
function parseIpipText(text) {
  const ip = text.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/)?.[1] || '';
  const loc = text.match(/来自于[:：]\s*([^\n]+)/)?.[1]?.trim() || '';
  return { ip, countryCode: /中国|CN/i.test(loc) ? 'CN' : (ip ? 'INTL' : ''), region: loc, country: '' };
}

// 解析 ipip.net JSON：{ "country_name":"中国","region_name":"北京","city_name":"...", "ip":"..." }
function parseIpipJson(json) {
  const ip = json.ip || json.myip || '';
  const cn = json.country_name || '';
  const region = [json.province_name || json.region_name || '', json.city_name || ''].filter(Boolean).join(' ');
  const codeMap = { '中国': 'CN', '中国香港': 'HK', '中国台湾': 'TW', '中国澳门': 'MO' };
  const code = codeMap[cn] || (ip ? 'INTL' : '');
  return { ip, countryCode: code, region: region || cn, country: cn };
}

// 解析 ip.sb/geoip JSON：{ "ip":"...","country":"US","country_code":"US","region":"...","organization":"..." }
function parseIpSb(json) {
  return {
    ip: json.ip || '',
    countryCode: json.country_code || json.country || '',
    country: json.country || '',
    region: [json.region || json.city || '', json.organization || ''].filter(Boolean).join(' ')
  };
}

// 解析 ipwho.is JSON：{ "ip":"...","country":"United States","country_code":"US","region":"California","city":"..." }
function parseIpwhois(json) {
  return {
    ip: json.ip || '',
    countryCode: json.country_code || '',
    country: json.country || '',
    region: [json.region || json.city || '', json.connection?.org || ''].filter(Boolean).join(' ')
  };
}

// ---------- IP 纯净度 ----------
// 用 ip-api.com（http，免费无需 key）的 proxy/hosting/mobile 三字段判定纯净度；
// 数据中心 / 代理 / VPN 出口纯净度低，住宅 / 移动网络高。
const DC_HINTS = /(LLC|Corp|Inc\.|Hosting|Cloud|Datacenter|Data Center|DataCentre|VPS|Server|Telecom|Network|Internet|Backbone|Broadband|VPN|Proxy|GmbH|Ltd\.|S\.A\.|B\.V\.|SAS|Digital|Technologies?|Solutions|Infrastructure)/i;

async function fetchIpPurity(ip) {
  if (!ip || isIPv6(ip)) return null; // ip-api 对 IPv6 支持有限，且纯 IPv6 不做机房判定
  // 优先 ip-api.com（http 免费版含 proxy/hosting/mobile）；扩展后台 fetch 可发 http
  try {
    const res = await fetchWithTimeout(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,query,proxy,hosting,mobile`,
      { 'Accept': 'application/json' }, 4000
    );
    if (res.ok) {
      const json = await res.json();
      if (json?.status === 'success') {
        return scorePurity({
          proxy: !!json.proxy, hosting: !!json.hosting, mobile: !!json.mobile,
          source: 'ip-api'
        });
      }
    }
  } catch (_) { /* 降级到启发式 */ }
  // 降级：ipwho.is 的 org/domain 机房特征启发式
  try {
    const res = await fetchWithTimeout(`https://ipwho.is/${encodeURIComponent(ip)}`, { 'Accept': 'application/json' }, 4000);
    if (res.ok) {
      const json = await res.json();
      const org = json?.connection?.org || json?.connection?.isp || '';
      const domain = json?.connection?.domain || '';
      const dc = DC_HINTS.test(`${org} ${domain}`);
      return scorePurity({ proxy: false, hosting: dc, mobile: false, source: 'ipwho.is', org });
    }
  } catch (_) { /* 忽略 */ }
  return null;
}

// 由 proxy/hosting/mobile 信号计算纯净度等级与文案
function scorePurity({ proxy, hosting, mobile, source, org }) {
  let level, label, cls, desc;
  if (mobile) {
    level = 5; label = '移动网络'; cls = 'ok';
    desc = '移动蜂窝出口，纯净度高';
  } else if (proxy || hosting) {
    level = 2; label = '数据中心 / 代理'; cls = 'warn';
    desc = (proxy ? '代理 ' : '') + (hosting ? '机房 ' : '') + '出口，纯净度低';
  } else {
    level = 4; label = '住宅 / 直连'; cls = 'ok';
    desc = '普通住宅宽带出口，纯净度较高';
  }
  if (source === 'ipwho.is' && org) {
    desc += ` · ${org}`;
  }
  return { level, label, cls, desc, proxy: !!proxy, hosting: !!hosting, mobile: !!mobile, source };
}

// 从单个端点解析出口信息；成功返回 {ip,countryCode,country,region}，失败抛错
async function resolveFrom(url, parseFn, headers = {}) {
  const res = await fetchWithTimeout(url, headers);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (typeof parseFn === 'function' && typeof data === 'object') return parseFn(data);
  if (typeof data === 'string') return { ip: (data.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/)?.[0] || ''), countryCode: '', country: '', region: '' };
  return { ip: '', countryCode: '', country: '', region: '' };
}

// 解析一路出口：主端点 → 降级端点，均失败返回空对象
async function resolveIp(probe) {
  const attempts = [
    { url: probe.ipUrl, fn: probe.ipUrl.includes('ipip.net') ? parseIpipJson : parseIpSb },
    { url: probe.ipFallbackUrl, fn: probe.ipFallbackUrl.includes('ipip.net') ? parseIpipText : parseIpwhois }
  ].filter((a) => a.url);
  for (const a of attempts) {
    try {
      const r = await resolveFrom(a.url, a.fn);
      if (r.ip) return r;
    } catch (_) { /* 尝试降级端点 */ }
  }
  return { ip: '', countryCode: '', country: '', region: '' };
}

// 判定网络类型：对比两路可达性与出口 IP
function classify(domestic, overseas) {
  const dOk = domestic.ok;
  const oOk = overseas.ok;
  if (!dOk && !oOk) return { status: 'offline', label: '离线', desc: '双路均不可达' };

  const dIp = domestic.ip || '';
  const oIp = overseas.ip || '';

  if (dOk && oOk && dIp && oIp && dIp !== oIp) {
    return { status: 'split', label: '分流代理', desc: '国内直连 + 海外代理出口，出口 IP 不同' };
  }
  if (dOk && oOk && dIp && oIp && dIp === oIp) {
    const intl = domestic.countryCode && domestic.countryCode !== 'CN' && domestic.countryCode !== 'INTL';
    return {
      status: intl ? 'global' : 'direct',
      label: intl ? '全局代理' : '直连',
      desc: intl ? '国内出口 IP 也来自海外，疑似全局代理' : '两路同出口，直连'
    };
  }
  if (dOk && !oOk) return { status: 'direct', label: '直连', desc: '国内可达，海外不可达' };
  if (!dOk && oOk) return { status: 'global', label: '全局代理', desc: '海外可达，国内不可达' };
  return { status: 'direct', label: '直连', desc: '' };
}

// 读取本机代理控制器当前模式（如 Clash API /configs -> mode）
async function fetchProxyMode(config) {
  const url = String(config.proxyUrl || '').trim();
  if (!url) return null;
  const base = url.replace(/\/+$/, '');
  const headers = {};
  if (config.proxySecret) headers['Authorization'] = `Bearer ${config.proxySecret}`;
  try {
    const res = await fetchWithTimeout(`${base}/configs`, headers, 4000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return { mode: json?.mode || json?.general?.mode || '', raw: json };
  } catch (err) {
    return { mode: '', error: err.message };
  }
}

// 导出便于测试
export function buildEndpointInfo(ip, countryCode, country, region, rtt) {
  return {
    ip, countryCode, country,
    region: region || '',
    flag: countryToFlag(countryCode),
    name: countryName(countryCode, country),
    rtt: rtt ?? null
  };
}

export default {
  id: 'network-status',
  name: '网络状态',
  defaultSize: 'small',
  refreshMinutes: 5,

  settingsSchema: [
    { key: 'proxyUrl', label: '代理控制器 URL（可选）', type: 'text', placeholder: 'http://127.0.0.1:9090' },
    { key: 'proxySecret', label: '控制器 Secret（可选）', type: 'password', placeholder: 'Clash secret' }
  ],

  async fetchData(config, ctx) {
    // 双路探测并行
    const [dIpP, oIpP, dLatP, oLatP, proxyModeP] = await Promise.allSettled([
      resolveIp(PROBES.domestic),
      resolveIp(PROBES.overseas),
      probe(PROBES.domestic.latencyUrl, { 'Accept': '*/*' }),
      probe(PROBES.overseas.latencyUrl, { 'Accept': '*/*' }),
      fetchProxyMode(config)
    ]);

    const dRtt = dLatP.status === 'fulfilled' ? dLatP.value.rtt : null;
    const oRtt = oLatP.status === 'fulfilled' ? oLatP.value.rtt : null;
    const dOk = dLatP.status === 'fulfilled' && dLatP.value.ok;
    const oOk = oLatP.status === 'fulfilled' && oLatP.value.ok;

    const dIp = dIpP.status === 'fulfilled' ? dIpP.value : { ip: '', countryCode: '', country: '', region: '' };
    const oIp = oIpP.status === 'fulfilled' ? oIpP.value : { ip: '', countryCode: '', country: '', region: '' };

    const domestic = buildEndpointInfo(dIp.ip, dIp.countryCode, dIp.country, dIp.region, dRtt);
    domestic.ok = dOk;
    domestic.latency = dRtt;

    const overseas = buildEndpointInfo(oIp.ip, oIp.countryCode, oIp.country, oIp.region, oRtt);
    overseas.ok = oOk;
    overseas.latency = oRtt;

    // 两路出口 IP 纯净度并行查询（失败不影响主状态）
    const [dPurityP, oPurityP] = await Promise.allSettled([
      fetchIpPurity(dIp.ip),
      fetchIpPurity(oIp.ip)
    ]);
    domestic.purity = dPurityP.status === 'fulfilled' ? dPurityP.value : null;
    overseas.purity = oPurityP.status === 'fulfilled' ? oPurityP.value : null;

    const cls = classify(domestic, overseas);
    const proxyMode = proxyModeP.status === 'fulfilled' ? proxyModeP.value : null;

    return {
      ...cls,
      domestic,
      overseas,
      proxyMode: proxyMode?.mode || null,
      proxyError: proxyMode?.error || null,
      updatedAt: Date.now()
    };
  },

  render(data, config, inst) {
    const statusClass = { direct: 'ok', split: 'warn', global: 'accent', offline: 'err' }[data.status] || '';
    const lat = (n) => (n == null ? '—' : `${n}ms`);
    const fmtIp = (ip) => isIPv6(ip) ? shortenIpv6(ip) : ip;
    const col = (side, title) => {
      const s = data[side] || {};
      const purity = s.purity;
      const purityTag = purity
        ? `<div class="ns-purity ${purity.cls}" title="${esc(purity.desc || '')}">${esc(purity.label || '')}</div>`
        : '';
      return `<div class="ns-col">
        <div class="ns-col-title">${esc(title)}</div>
        <div class="ns-col-flag">${esc(s.flag || '🌐')}</div>
        <div class="ns-col-name">${esc(s.name || '未知')}${s.region ? `<span class="ns-col-region">${esc(s.region)}</span>` : ''}</div>
        <div class="ns-ip" data-ip="${esc(s.ip || '')}" title="${esc(s.ip ? '点击复制 ' + s.ip : '')}">${esc(fmtIp(s.ip) || '—')}</div>
        <div class="ns-col-rtt">${lat(s.latency)}</div>
        ${purityTag}
      </div>`;
    };
    return `<div class="w-head">
      <span class="w-title">${esc(inst?.title || '网络状态')}</span>
      <span class="w-badge ${statusClass}">${esc(data.label || '')}</span>
    </div>
    <div class="ns-body ns-medium">
      <div class="ns-status">
        <span class="ns-dot ${statusClass}"></span>
        <div class="ns-status-text">
          <b>${esc(data.label || '')}</b>
          <span>${esc(data.desc || '')}</span>
        </div>
      </div>
      ${data.proxyMode ? `<div class="ns-mode">代理模式：${esc(data.proxyMode)}</div>` : ''}
      <div class="ns-cols">
        ${col('domestic', '国内直连')}
        ${col('overseas', '海外代理')}
      </div>
      <button class="ns-probe" data-action="reprobe">重新探测</button>
    </div>`;
  },

  renderSmall(data, config, inst) {
    const statusClass = { direct: 'ok', split: 'warn', global: 'accent', offline: 'err' }[data.status] || '';
    const lat = (n) => (n == null ? '—' : `${n}ms`);
    // 主出口：分流/全局时以海外出口为主，直连/离线以国内为主
    const main = data.status === 'split' || data.status === 'global' ? data.overseas : data.domestic;
    const m = main || {};
    const fmtIp = (ip) => isIPv6(ip) ? shortenIpv6(ip) : ip;
    const purity = m.purity;
    const purityTag = purity
      ? `<div class="ns-purity ${purity.cls}" title="${esc(purity.desc || '')}">纯净度 · ${esc(purity.label || '')}</div>`
      : '';
    return `<div class="w-head"><span class="w-title">${esc(inst?.title || '网络状态')}</span>
      <span class="w-badge ${statusClass}">${esc(data.label || '')}</span></div>
      <div class="ns-small">
        <div class="ns-small-main">
          <span class="ns-dot ${statusClass}"></span>
          <span class="ns-small-flag">${esc(m.flag || '🌐')}</span>
          <span class="ns-small-name">${esc(m.name || '未知')}</span>
        </div>
        <div class="ns-ip ns-ip-mono" data-ip="${esc(m.ip || '')}" title="${esc(m.ip ? '点击复制 ' + m.ip : '')}">${esc(fmtIp(m.ip) || '—')}</div>
        ${purityTag}
        <div class="ns-small-lat">国内 ${lat(data.domestic?.latency)} · 海外 ${lat(data.overseas?.latency)}</div>
        <button class="ns-probe" data-action="reprobe">重新探测</button>
      </div>`;
  }
};

// 超长 IPv6 中间省略（保留前 6 与后 4 个字符），避免撑破卡片
function shortenIpv6(ip) {
  const s = String(ip || '');
  if (s.length <= 18) return s;
  return `${s.slice(0, 9)}…${s.slice(-5)}`;
}
