// 通用网络层：在后台把受限请求头（UA / Cookie / Referer / Origin 等）交给 DNR 在网络层注入。
// 浏览器的 fetch() 禁止手动设置这些头，直接写会被静默丢弃；这里用会话级规则改写后即删。
let ruleSeq = 1000;

// 浏览器禁止脚本直接设置的头（forbidden headers）才必须交给 DNR 在网络层注入。
// Authorization / x-api-key / anthropic-version / Accept / OpenAI-Organization 等
// 均可直接传给 fetch——直传比 DNR 会话规则可靠得多（无生效时序问题）。
const DNR_ONLY = new Set([
  'cookie', 'cookie2', 'set-cookie',
  'user-agent', 'referer', 'origin', 'host',
  'content-length', 'connection', 'keep-alive',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
  'accept-charset', 'accept-encoding',
  'access-control-request-headers', 'access-control-request-method',
  'date', 'dnt', 'expect',
  'proxy-authorization', 'proxy-authenticate'
]);

export async function netFetch(url, { method = 'GET', headers = {}, body } = {}) {
  const directHeaders = {};
  const injectHeaders = [];
  for (const [header, value] of Object.entries(headers)) {
    if (value === undefined || value === null || value === '') continue;
    const name = header.toLowerCase();
    if (DNR_ONLY.has(name) || name.startsWith('sec-')) {
      injectHeaders.push({ header, operation: 'set', value: String(value) });
    } else {
      directHeaders[header] = String(value);
    }
  }

  const ruleId = ++ruleSeq;
  let ruleAdded = false;
  if (injectHeaders.length > 0) {
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        addRules: [{
          id: ruleId,
          priority: 1,
          action: { type: 'modifyHeaders', requestHeaders: injectHeaders },
          // 去掉 query，避免 urlFilter 对它做特殊解析；用完整 URL 前缀精确命中本请求
          condition: { urlFilter: url.split('?')[0], resourceTypes: ['xmlhttprequest'] }
        }]
      });
      ruleAdded = true;
    } catch (err) {
      console.warn('[netFetch] 无法注入受限请求头，将继续请求：', err);
    }
  }

  try {
    // credentials:'omit' —— 不携带浏览器自身 Cookie，鉴权完全由传入头决定，行为可预期
    // 15s 超时：避免接口挂起时「测试连接」一直转圈无反馈
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      return await fetch(url, { method, body, credentials: 'omit', headers: directHeaders, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  } finally {
    if (ruleAdded) {
      try {
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
      } catch (err) {
        console.warn('[netFetch] 清理规则失败：', err);
      }
    }
  }
}

// 读取单个响应头里的 key=value（订阅头形如 upload=1; download=2; total=3; expire=4）
export function parseKv(headerStr, key) {
  if (!headerStr) return 0;
  const m = headerStr.match(new RegExp(`${key}=(\\d+)`));
  return m ? Number(m[1]) : 0;
}
