// 当前网络状态：直连 / 分流代理 / 全局代理 / 离线。
// 双路探测（国内直连出口 + 海外代理出口 + 204 延迟）并行，对比出口 IP 自动判定。
// 可选读本机代理控制器（Clash 等）的当前模式；AbortController 4.5s 超时。

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// 探测端点：国内直连（能区分出口 IP 归属地），海外（被代理时应走代理出口）
const PROBES = {
  domestic: {
    ipUrl: 'https://myip.ipip.net',           // 返回纯文本含 IP 与归属地
    latencyUrl: 'https://www.baidu.com',      // 国内 204/快速可达性
    label: '国内直连'
  },
  overseas: {
    ipUrl: 'https://api.ipify.org?format=json', // 海外出口 IP
    latencyUrl: 'https://www.google.com/generate_204', // 海外 204
    label: '海外代理'
  }
};

// 带超时的探测请求（AbortController 4.5s 超时）。
// 用原生 fetch 以拿到 signal 控制；探测端点无需受限头，不走 netFetch。
async function fetchWithTimeout(url, headers = {}, ms = 4500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { headers, signal: ctrl.signal, credentials: 'omit' });
  } finally {
    clearTimeout(timer);
  }
}

async function probe(url, headers = {}) {
  const started = Date.now();
  const res = await fetchWithTimeout(url, headers);
  const ms = Date.now() - started;
  return { ok: res.ok, status: res.status, ms };
}

// 从 IP 查询接口提取出口 IP 与归属地/国旗
async function resolveIp(url, headers = {}) {
  const res = await fetchWithTimeout(url, headers);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  // ipip.net 文本形如："当前 IP：1.2.3.4  来自于：中国 北京 联通"
  const ipM = text.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
  const locM = text.match(/来自于[:：]\s*([^\n]+)/);
  const jsonIp = (() => { try { const j = JSON.parse(text); return j.ip; } catch { return ''; } })();
  const ip = ipM?.[1] || jsonIp || '';
  const loc = locM?.[1]?.trim() || (ip ? '海外' : '');
  const country = /中国|CN/i.test(loc) ? 'CN' : (ip ? 'INTL' : '');
  const flag = country === 'CN' ? '🇨🇳' : (ip ? '🌐' : '');
  return { ip, loc, country, flag };
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
    // 两路可达且出口一致：要么全局代理（国内也走代理），要么都直连
    // 若国内探测点延迟异常高且出口属海外，视为全局代理
    const intl = !/中国|CN/i.test(domestic.loc || '');
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
      resolveIp(PROBES.domestic.ipUrl),
      resolveIp(PROBES.overseas.ipUrl),
      probe(PROBES.domestic.latencyUrl, { 'Accept': '*/*' }),
      probe(PROBES.overseas.latencyUrl, { 'Accept': '*/*' }),
      fetchProxyMode(config)
    ]);

    const domestic = {
      ip: dIpP.status === 'fulfilled' ? dIpP.value.ip : '',
      loc: dIpP.status === 'fulfilled' ? dIpP.value.loc : '',
      flag: dIpP.status === 'fulfilled' ? dIpP.value.flag : '',
      country: dIpP.status === 'fulfilled' ? dIpP.value.country : '',
      ok: dLatP.status === 'fulfilled' && dLatP.value.ok,
      latency: dLatP.status === 'fulfilled' ? dLatP.value.ms : null
    };
    const overseas = {
      ip: oIpP.status === 'fulfilled' ? oIpP.value.ip : '',
      loc: oIpP.status === 'fulfilled' ? oIpP.value.loc : '',
      flag: oIpP.status === 'fulfilled' ? oIpP.value.flag : '',
      country: oIpP.status === 'fulfilled' ? oIpP.value.country : '',
      ok: oLatP.status === 'fulfilled' && oLatP.value.ok,
      latency: oLatP.status === 'fulfilled' ? oLatP.value.ms : null
    };

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
    return `<div class="w-head">
      <span class="w-title">${esc(inst?.title || '网络状态')}</span>
      <span class="w-badge ${statusClass}">${esc(data.label || '')}</span>
    </div>
    <div class="ns-body">
      <div class="ns-status">
        <span class="ns-dot ${statusClass}"></span>
        <div class="ns-status-text">
          <b>${esc(data.label || '')}</b>
          <span>${esc(data.desc || '')}</span>
        </div>
      </div>
      ${data.proxyMode ? `<div class="ns-mode">代理模式：${esc(data.proxyMode)}</div>` : ''}
      <div class="ns-lat">
        <span>国内 ${lat(data.domestic?.latency)}</span>
        <span>海外 ${lat(data.overseas?.latency)}</span>
      </div>
      <button class="ns-probe" data-action="reprobe">重新探测</button>
    </div>`;
  },

  renderSmall(data, config, inst) {
    const statusClass = { direct: 'ok', split: 'warn', global: 'accent', offline: 'err' }[data.status] || '';
    const lat = (n) => (n == null ? '—' : `${n}ms`);
    return `<div class="w-head"><span class="w-title">${esc(inst?.title || '网络状态')}</span>
      <span class="w-badge ${statusClass}">${esc(data.label || '')}</span></div>
      <div class="ns-small">
        <div class="ns-dot ${statusClass}"></div>
        <div class="ns-small-lat">国内 ${lat(data.domestic?.latency)} · 海外 ${lat(data.overseas?.latency)}</div>
        <button class="ns-probe" data-action="reprobe">重新探测</button>
      </div>`;
  }
};
