// 通用网络层：把真正受限的头（Cookie / Referer / Origin / Host 等）交给 DNR 网络层注入。
// 注意：User-Agent 从 DNR_ONLY 移除——扩展上下文（service worker / 扩展页面）里 fetch 可直接
// 设置 User-Agent（扩展特权不受浏览器 forbidden header 限制），直传比 DNR 可靠；
// DNR 的 modifyHeaders 对 User-Agent 的修改在 Chrome 中不可靠，可能导致 UA 未生效而被 401。
// 浏览器禁止脚本直接设置的头（forbidden headers）才必须交给 DNR 在网络层注入。
// Authorization / x-api-key / anthropic-version / Accept / OpenAI-Organization 等
// 均可直接传给 fetch——直传比 DNR 会话规则可靠得多（无生效时序问题）。
const DNR_ONLY = new Set([
  'cookie', 'cookie2', 'set-cookie',
  'referer', 'origin', 'host',
  'content-length', 'connection', 'keep-alive',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
  'accept-charset', 'accept-encoding',
  'access-control-request-headers', 'access-control-request-method',
  'date', 'dnt', 'expect',
  'proxy-authorization', 'proxy-authenticate'
]);

// DNR 会话规则 ID 生成：不能用模块级递增序号——page 上下文（newtab）与 service worker
// （background）各有一份独立的序号，但共享同一个 DNR session 规则空间，两边从 1000 起跳
// 必然撞 ID（报 "Rule with id 1001 does not have a unique ID"），导致 Cookie 等受限头
// 注入失败。这里改用「进程内自增 + 时间戳高位 + 随机低位」拼出全局唯一 ID。
// DNR 规则 ID 合法范围是 1 ~ 2^31-1（实际要求 < 2^31 且为正整数），这里控制在安全区间。
let _seq = 0;
function nextRuleId() {
  _seq = (_seq + 1) % 1000;
  const t = Date.now() % 1000000; // 后 6 位，随时间变化，避免跨上下文/重启撞号
  const r = Math.floor(Math.random() * 1000);
  // 合成：t(6位) * 1000 + r，最高约 10^9，远小于 2^31；加 _seq 微扰
  return (t * 1000 + r + _seq) % 2000000000;
}

// 清理本扩展可能残留的 session 规则（service worker 被回收 / 异常中断时规则可能没删干净）
async function clearStaleRules() {
  try {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    const ids = (existing || []).map((r) => r.id);
    if (ids.length) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
    }
  } catch (_) { /* 清理失败不影响主流程 */ }
}

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

  const ruleId = nextRuleId();
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
      // 若 ID 冲突（残留规则占号），清掉旧规则后重试一次，确保受限头（Cookie 等）真正注入
      if (String(err?.message || '').includes('unique') || String(err?.message || '').includes('id')) {
        console.warn('[netFetch] 规则 ID 冲突，清理残留规则后重试：', err?.message);
        await clearStaleRules();
        try {
          await chrome.declarativeNetRequest.updateSessionRules({
            addRules: [{
              id: ruleId,
              priority: 1,
              action: { type: 'modifyHeaders', requestHeaders: injectHeaders },
              condition: { urlFilter: url.split('?')[0], resourceTypes: ['xmlhttprequest'] }
            }]
          });
          ruleAdded = true;
        } catch (err2) {
          console.warn('[netFetch] 重试注入仍失败，将继续请求：', err2);
        }
      } else {
        console.warn('[netFetch] 无法注入受限请求头，将继续请求：', err);
      }
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
