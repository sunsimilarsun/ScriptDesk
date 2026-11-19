// 自定义 RSS / Atom 聚合：多订阅 URL 合并、按时间倒序、查看模式点击打开原文。
// 解析走 core/rss-parser.js（纯正则，无 DOMParser），请求统一经 netFetch。
import { parseFeed, mergeFeeds, decodeEntities } from '../core/rss-parser.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 多行订阅 URL 解析：按行/逗号/空白切分，去空去重，支持 "标题|url" 形式
export function parseFeedList(text) {
  const list = String(text || '').split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean);
  const urls = [];
  const seen = new Set();
  for (const raw of list) {
    const pipe = raw.lastIndexOf('|');
    const url = (pipe >= 0 ? raw.slice(pipe + 1) : raw).trim();
    const title = pipe >= 0 ? raw.slice(0, pipe).trim() : '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push({ url, title });
  }
  return urls;
}

export default {
  id: 'rss',
  name: 'RSS 订阅',
  defaultSize: 'large',
  refreshMinutes: 60,

  settingsSchema: [
    { key: 'feeds', label: '订阅地址（每行一个，可写「标题|URL」）', type: 'textarea',
      placeholder: 'https://example.com/feed.xml\n我的博客|https://blog.example.com/rss' },
    { key: 'maxItems', label: '最大条目数', type: 'number', default: 20 }
  ],

  async fetchData(config, ctx) {
    const list = parseFeedList(config.feeds);
    if (!list.length) throw new Error('请先填写至少一个订阅地址');
    const maxItems = Number(config.maxItems) || 20;

    const feeds = await Promise.all(
      list.map(async ({ url, title }) => {
        try {
          const res = await ctx.netFetch(url, { headers: { 'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' } });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const xml = await res.text();
          const items = parseFeed(xml, title);
          return { title, url, items };
        } catch (err) {
          // 单源失败不拖垮整体，记录错误但保留其他源
          return { title, url, items: [], error: err.message };
        }
      })
    );

    const items = mergeFeeds(feeds, maxItems);
    const errors = feeds.filter((f) => f.error).map((f) => `${f.title || f.url}: ${f.error}`);
    return {
      items: items.map((it) => ({
        title: it.title || it.link || '(无标题)',
        link: it.link || '',
        source: it.source || '',
        dateTs: it.dateTs || 0,
        date: it.dateTs ? new Date(it.dateTs).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) : ''
      })),
      sourceCount: feeds.length,
      okCount: feeds.filter((f) => !f.error && f.items.length).length,
      errors
    };
  },

  render(data, config, inst, rec) {
    const rows = (data.items || []).map((it, i) => {
      const title = esc(it.title);
      const src = it.source ? `<span class="rss-src">${esc(it.source)}</span>` : '';
      const date = it.date ? `<span class="rss-date">${esc(it.date)}</span>` : '';
      // 用 data-action="open-article" + data-url 承载链接，点击统一处理：
      // 查看模式打开原文，编辑模式由外层拦截（不会跳转）。
      return `<div class="rss-item" data-action="open-article" data-url="${esc(it.link)}" ${it.link ? '' : 'data-disabled="1"'}>
        <span class="w-idx">${i + 1}</span>
        <span class="w-item-title">${title}</span>
        ${src}${date}
      </div>`;
    }).join('');

    const head = `<div class="w-head">
      <span class="w-title">${esc(inst?.title || 'RSS 订阅')}</span>
      <span class="w-badge">${data.okCount ?? 0}/${data.sourceCount ?? 0} 源</span>
    </div>`;

    const errs = (data.errors || []).length
      ? `<div class="rss-warn">${(data.errors || []).length} 个源失败：${esc((data.errors || []).join('；').slice(0, 200))}</div>`
      : '';

    return `${head}${errs}<div class="w-list rss-list">${rows || '<div class="w-empty">暂无条目</div>'}</div>`;
  },

  renderSmall(data, config, inst) {
    const first = (data.items || [])[0];
    return `<div class="w-head"><span class="w-title">${esc(inst?.title || 'RSS 订阅')}</span>
      <span class="w-badge">${data.okCount ?? 0} 源</span></div>
      <div class="rss-small">
        <div class="rss-small-count">${(data.items || []).length}<small> 条</small></div>
        <div class="rss-small-latest">${esc(first?.title || '暂无')}</div>
      </div>`;
  }
};

// 供 newtab.js 动态 import 使用：点击条目时打开原文链接
export function openArticle(url) {
  if (!url) return;
  window.open(url, '_blank', 'noopener');
}

export { decodeEntities };
