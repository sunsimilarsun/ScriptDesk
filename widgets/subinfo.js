// 订阅余量组件：定时拉取 HEAD 响应头；作为角标来源时同步工具栏角标。
export default {
  id: 'subinfo',
  name: '订阅余量',
  defaultSize: 'medium',
  refreshMinutes: 240,
  canBeBadgeSource: true,

  settingsSchema: [
    { key: 'subUrl', label: '订阅链接', type: 'text', placeholder: '粘贴机场订阅 URL' }
  ],

  async fetchData(config, { netFetch, parseKv }) {
    const url = (config.subUrl || '').trim();
    if (!url) throw new Error('未配置订阅链接');

    const res = await netFetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': 'ClashforWindows/0.20.39' }
    });
    const header = res.headers.get('subscription-userinfo');
    if (!header) throw new Error('服务端未返回 subscription-userinfo');

    const total = parseKv(header, 'total');
    const used = parseKv(header, 'upload') + parseKv(header, 'download');
    const expire = parseKv(header, 'expire');
    const remainBytes = Math.max(0, total - used);

    return {
      remainGB: (remainBytes / 1024 ** 3).toFixed(1),
      totalGB: (total / 1024 ** 3).toFixed(1),
      usedGB: (used / 1024 ** 3).toFixed(1),
      percent: total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0,
      days: expire > 0 ? Math.max(0, Math.ceil((expire * 1000 - Date.now()) / 86400000)) : 0
    };
  },

  render(data, config, inst) {
    const low = data.percent >= 85 || (data.days > 0 && data.days <= 5);
    return `
      <div class="w-head">
        <span class="w-title">${inst?.title || '订阅余量'}</span>
        <span class="w-badge ${low ? 'warn' : ''}">${low ? '偏低' : '正常'}</span>
      </div>
      <div class="w-big">${data.remainGB}<small> GB 剩余</small></div>
      <div class="w-progress"><i style="width:${data.percent}%"></i></div>
      <div class="w-foot">
        <span>已用 ${data.usedGB} / ${data.totalGB}G</span>
        <span>剩 ${data.days} 天</span>
      </div>`;
  },

  updateBadge(data) {
    chrome.action.setBadgeText({ text: data ? `${Math.round(data.remainGB)}G` : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#2563EB' });
  }
};
