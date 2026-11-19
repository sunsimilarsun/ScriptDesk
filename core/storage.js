// 多实例数据层：layout（画布实例数组） + cache:<instanceId>（各实例数据缓存）。
// 纯 localStorage 抽象，负责 UID、迁移、CRUD，供后台与起始页共用。
export const LAYOUT_KEY = 'layout';

export function newInstanceId() {
  return `inst_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// 读取 layout；首次升级时把旧 config:subinfo 无损迁移成第一张 isBadgeSource 实例
export async function getLayout() {
  const stored = await chrome.storage.local.get([LAYOUT_KEY]);
  if (Array.isArray(stored[LAYOUT_KEY])) return stored[LAYOUT_KEY];

  // 迁移：检测 v2.0 的旧配置
  const old = await chrome.storage.local.get(['config:subinfo', 'subUrl', 'ui:widgets']);
  const subUrl = (old['config:subinfo']?.subUrl || old.subUrl || '').trim();
  const ui = old['ui:widgets'] || {};
  const layout = [];

  if (subUrl) {
    layout.push({
      instanceId: newInstanceId(),
      type: 'subinfo',
      title: '订阅余量',
      size: ui.subinfo?.size || 'medium',
      linkUrl: '',
      openInNewTab: false,
      isBadgeSource: true,
      config: { subUrl }
    });
  }

  await chrome.storage.local.set({ [LAYOUT_KEY]: layout });
  return layout;
}

export async function saveLayout(layout) {
  await chrome.storage.local.set({ [LAYOUT_KEY]: layout });
}

export async function getInstancesByType(type) {
  const layout = await getLayout();
  return layout.filter((i) => i.type === type);
}

export async function getBadgeSource() {
  const layout = await getLayout();
  return layout.find((i) => i.isBadgeSource && i.type === 'subinfo') || null;
}

// 读取某实例的缓存
export async function getCache(instanceId) {
  const key = `cache:${instanceId}`;
  const store = await chrome.storage.local.get([key]);
  return store[key] || {};
}

// 一次性读取全部实例缓存，供起始页秒开渲染
export async function getAllCache(layout) {
  const keys = layout.map((i) => `cache:${i.instanceId}`);
  if (!keys.length) return {};
  return chrome.storage.local.get(keys);
}
