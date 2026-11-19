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
