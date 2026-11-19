// 热榜聚合：免鉴权公开接口，验证「查看模式点条目跳子链接 / 编辑模式拦截跳转」。
const SOURCES = {
  v2ex: {
    label: 'V2EX',
    url: 'https://www.v2ex.com/api/topics/hot.json',
    parse(json) {
      return (json || []).slice(0, 8).map((t) => ({
        title: t.title,
        url: `https://www.v2ex.com/t/${t.id}`,
        meta: `${t.replies || 0} 回复`
      }));
    }
  },
  hn: {
    label: 'Hacker News',
    url: 'https://hacker-news.firebaseio.com/v0/topstories.json',
    async parse(json, netFetch) {
      const ids = (json || []).slice(0, 8);
      const items = await Promise.all(
        ids.map((id) => netFetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then((r) => r.json()))
      );
      return items.map((t) => ({
        title: t.title,
        url: t.url || `https://news.ycombinator.com/item?id=${t.id}`,
        meta: `${t.score || 0} 分 · ${t.descendants || 0} 评`
      }));
    }
  }
};

export default {
  id: 'hotlist',
  name: '热榜',
  defaultSize: 'large',
  refreshMinutes: 60,

  settingsSchema: [
    { key: 'source', label: '数据源', type: 'select', default: 'v2ex',
      options: [{ value: 'v2ex', label: 'V2EX' }, { value: 'hn', label: 'Hacker News' }] },
    { key: 'limit', label: '显示条数', type: 'number', default: 8 }
  ],

  async fetchData(config, { netFetch }) {
    const key = config.source === 'hn' ? 'hn' : 'v2ex';
    const src = SOURCES[key];
    const res = await netFetch(src.url);
    const json = await res.json();
    const items = await src.parse(json, netFetch);
    return { source: src.label, items: items.slice(0, Number(config.limit) || 8) };
  },

  render(data, config, inst) {
    const rows = (data.items || []).map(
      (it, i) => `<a class="w-list-item" href="${it.url}" target="_blank" rel="noopener">
        <span class="w-idx">${i + 1}</span>
        <span class="w-item-title">${it.title}</span>
        <span class="w-item-meta">${it.meta || ''}</span>
      </a>`
    ).join('');
    return `
      <div class="w-head">
        <span class="w-title">${inst?.title || data.source || '热榜'}</span>
        <span class="w-badge">${data.source || ''}</span>
      </div>
      <div class="w-list">${rows || '<div class="w-empty">暂无条目</div>'}</div>`;
  }
};
