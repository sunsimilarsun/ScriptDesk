// 调度中心：遍历 layout 逐实例取数并缓存；页面打开只读缓存秒开。
import { WIDGET_MAP } from './core/registry.js';
import { netFetch, parseKv } from './core/dnr-fetch.js';
import { getLayout, getBadgeSource, getCache } from './core/storage.js';

const CTX = { netFetch, parseKv };

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

async function runInstance(inst, force = false) {
  const widget = WIDGET_MAP[inst.type];
  // 静态组件（如倒数日/快捷入口）没有 fetchData，直接跳过
  if (!widget || typeof widget.fetchData !== 'function') return;

  const cacheKey = `cache:${inst.instanceId}`;
  const prev = await getCache(inst.instanceId);
  const ttlMs = (widget.refreshMinutes || 120) * 60 * 1000;
  if (!force && prev.updatedAt && Date.now() - prev.updatedAt < ttlMs) {
    // 命中缓存时也要恢复角标（服务 worker 重启后角标可能丢失）
    if (inst.isBadgeSource && widget.updateBadge && prev.data) widget.updateBadge(prev.data);
    return;
  }

  try {
    // 注入 instanceId，供快照类组件按实例隔离存储（如 ai-balance 的 snapshots:<id>）
    const data = await widget.fetchData(inst.config || {}, { ...CTX, instanceId: inst.instanceId });
    await chrome.storage.local.set({ [cacheKey]: { data, updatedAt: Date.now(), error: null } });

    // 只有被选为角标来源的那张 subinfo 卡回写工具栏角标与旧 popup 数据
    if (inst.isBadgeSource && widget.updateBadge) {
      widget.updateBadge(data);
      await chrome.storage.local.set({ subData: data, lastUpdate: formatTime(Date.now()) });
    }
  } catch (err) {
    // 容错：保留旧 data，只写 error，卡片不白屏
    await chrome.storage.local.set({
      [cacheKey]: { ...prev, error: err.message, lastAttempt: Date.now() }
    });
  }
}

async function refreshAll(force = false) {
  const layout = await getLayout(); // 内部会做旧配置迁移
  await Promise.allSettled(layout.map((inst) => runInstance(inst, force)));
}

// 刷新单个实例
async function refreshInstance(instanceId) {
  const layout = await getLayout();
  const inst = layout.find((i) => i.instanceId === instanceId);
  if (inst) await runInstance(inst, true);
}

async function clearBadgeIfNoSource() {
  const source = await getBadgeSource();
  if (!source) chrome.action.setBadgeText({ text: '' });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('widget_tick', { periodInMinutes: 30 });
  refreshAll(true);
});

chrome.runtime.onStartup.addListener(() => {
  refreshAll(false).then(clearBadgeIfNoSource);
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'widget_tick') refreshAll(false);
});

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.action === 'refresh') {
    // 兼容旧 popup：刷新当前角标来源实例
    getBadgeSource().then(async (src) => {
      if (src) await runInstance(src, true);
      sendResponse({ success: true });
    });
    return true;
  }
  if (req.action === 'refreshAll') {
    refreshAll(true).then(() => sendResponse({ success: true }));
    return true;
  }
  if (req.action === 'refreshWidget' && req.id) {
    refreshInstance(req.id).then(() => sendResponse({ success: true }));
    return true;
  }
  if (req.action === 'layoutChanged') {
    // 画布结构变更后：强制拉新实例并清理无来源时的角标残留
    refreshAll(true).then(clearBadgeIfNoSource).then(() => sendResponse({ success: true }));
    return true;
  }
});

// ---------- Codex token 自动捕获 ----------
// ChatGPT 网页的 Codex 面板会调用 wham/usage，其请求头带现成的 OAuth token。
// 这里拦截该请求，把 Authorization Bearer token + account_id 写入 storage，
// 使「订阅额度」卡无需 codex login / 手动导入 auth.json 也能自动拿到登录态。
//
// 性能要点：wham/usage 会被网页高频请求，因此这里做两重防护：
//  1) 仅当 token 与已存的相比真正变化时才写 storage（避免无意义写入触发的 storage.onChanged 风暴）；
//  2) 写后只刷新「订阅额度」那一张卡（refreshInstance），绝不全量 refreshAll。
let _lastCodexToken = null; // 已写入 storage 的 token，用于去重

function extractCodexAuth(details) {
  try {
    const authHeader = details.requestHeaders?.find(
      (h) => h.name.toLowerCase() === 'authorization'
    )?.value || '';
    if (!authHeader.startsWith('Bearer ')) return;
    const token = authHeader.slice(7).trim();
    if (!token) return;
    // token 未变化则直接跳过（高频请求的主要去重点）
    if (token === _lastCodexToken) return;

    const acctHeader = details.requestHeaders?.find(
      (h) => h.name.toLowerCase() === 'chatgpt-account-id'
    )?.value || '';

    // 解析 JWT payload 里的 chatgpt_account_id（兜底 account_id 头缺失时）
    let accountId = acctHeader;
    if (!accountId) {
      try {
        const seg = token.split('.')[1];
        const json = atob(seg.replace(/-/g, '+').replace(/_/g, '/'));
        const payload = JSON.parse(json);
        accountId = payload['https://api.openai.com/auth']?.chatgpt_account_id || '';
      } catch (_) { /* 忽略解析失败 */ }
    }

    _lastCodexToken = token;
    const record = { access_token: token, account_id: accountId, savedAt: Date.now(), source: 'webRequest' };
    chrome.storage.local.set({ codexAuth: record }).then(() => {
      // 仅刷新「订阅额度」卡，避免高频触发导致全量卡顿
      refreshSubscriptionOnly();
    });
  } catch (_) { /* 静默：捕获失败不影响其它组件 */ }
}

// 只刷新 type=subscription 的实例（token 变化时让额度卡即时更新，不波及其它组件）
async function refreshSubscriptionOnly() {
  return refreshTypeOnly('subscription');
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  extractCodexAuth,
  { urls: ['*://chatgpt.com/backend-api/wham/usage*'] },
  ['requestHeaders']
);

// ---------- MoeRouter token 自动捕获 ----------
// MoeRouter 等 new-api 系中转站网页登录后会调 /api/user/self 查询个人余额，
// 其请求头带现成的访问令牌（Authorization: Bearer nap_...）。
// 这里拦截该请求写入 storage，使「AI 余额 · MoeRouter」卡无需手动粘贴令牌。
// 同样做 token 去重 + 精准刷新（只刷新 ai-balance 实例），避免高频风暴。
let _lastMoerouterToken = null;

function extractMoerouterAuth(details) {
  try {
    const authHeader = details.requestHeaders?.find(
      (h) => h.name.toLowerCase() === 'authorization'
    )?.value || '';
    if (!authHeader.startsWith('Bearer ')) return;
    const token = authHeader.slice(7).trim();
    if (!token || !token.startsWith('nap_')) return; // 只认 new-api 访问令牌
    if (token === _lastMoerouterToken) return;

    _lastMoerouterToken = token;
    chrome.storage.local.set({
      moerouterAuth: { access_token: token, savedAt: Date.now(), source: 'webRequest' }
    }).then(() => {
      refreshTypeOnly('ai-balance');
    });
  } catch (_) { /* 静默 */ }
}

// 只刷新指定 type 的实例（token 变化时让对应卡即时更新，不波及其它组件）
async function refreshTypeOnly(type) {
  try {
    const layout = await getLayout();
    const matches = layout.filter((i) => i.type === type);
    await Promise.allSettled(matches.map((inst) => runInstance(inst, true)));
  } catch (_) { /* 静默 */ }
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  extractMoerouterAuth,
  { urls: ['*://moerouter.com/api/user/self*'] },
  ['requestHeaders']
);

// ---------- WorkBuddy token 自动捕获 ----------
// WorkBuddy 网页（workbuddy.cn）登录后会调 billing/meter/get-user-resource-summary 等接口，
// 请求头带 Authorization: Bearer <accessToken> + X-Account-Uid。拦截并写入 storage，
// 使「AI 余额 · WorkBuddy」卡无需手动粘贴。同样去重 + 精准刷新。
let _lastWorkbuddyToken = null;

function extractWorkbuddyAuth(details) {
  try {
    const authHeader = details.requestHeaders?.find(
      (h) => h.name.toLowerCase() === 'authorization'
    )?.value || '';
    if (!authHeader.startsWith('Bearer ')) return;
    const token = authHeader.slice(7).trim();
    if (!token) return;
    const uid = details.requestHeaders?.find(
      (h) => h.name.toLowerCase() === 'x-account-uid'
    )?.value || '';
    if (!uid) return;
    if (token === _lastWorkbuddyToken) return;

    _lastWorkbuddyToken = token;
    chrome.storage.local.set({
      workbuddyAuth: { access_token: token, uid, savedAt: Date.now(), source: 'webRequest' }
    }).then(() => {
      refreshTypeOnly('ai-balance');
    });
  } catch (_) { /* 静默 */ }
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  extractWorkbuddyAuth,
  { urls: ['*://www.workbuddy.cn/billing/*', '*://workbuddy.cn/billing/*', '*://copilot.tencent.com/v2/billing/*'] },
  ['requestHeaders']
);

