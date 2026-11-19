// 组件注册表：新增组件只需在此 import 并加入数组，其余全部自动生效。
import subinfo from '../widgets/subinfo.js';
import hotlist from '../widgets/hotlist.js';
import genericJson from '../widgets/generic-json.js';
import countdown from '../widgets/countdown.js';
import telecom from '../widgets/telecom.js';
import aiBalance from '../widgets/ai-balance.js';
import rss from '../widgets/rss.js';
import githubHeatmap from '../widgets/github-heatmap.js';
import market from '../widgets/market.js';
import networkStatus from '../widgets/network-status.js';
import subscription from '../widgets/subscription.js';
import geminiUsage from '../widgets/gemini-usage.js';

export const WIDGETS = [subinfo, telecom, aiBalance, hotlist, genericJson, countdown, rss, githubHeatmap, market, networkStatus, subscription, geminiUsage];

// 按 type 建索引，后台按实例调度时用
export const WIDGET_MAP = Object.fromEntries(WIDGETS.map((w) => [w.id, w]));

export function getWidget(id) {
  return WIDGET_MAP[id] || null;
}

// 创建一个组件类型的默认实例骨架（供「添加组件」用）
export function createInstance(type, overrides = {}) {
  const widget = WIDGET_MAP[type];
  if (!widget) return null;
  const config = {};
  for (const field of widget.settingsSchema || []) {
    if (field.default !== undefined) config[field.key] = field.default;
  }
  // 组件可声明 defaultLinkUrl(config) 自动填充账单控制台等默认跳转
  const defaultLink = typeof widget.defaultLinkUrl === 'function'
    ? (widget.defaultLinkUrl(config) || '') : '';
  return {
    type,
    title: widget.name,
    size: widget.defaultSize || 'small',
    linkUrl: defaultLink,
    openInNewTab: false,
    config,
    ...overrides
  };
}
