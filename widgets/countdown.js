// 倒数日 / 快捷跳转卡：纯本地、无网络请求，验证静态组件混排。
// 有 targetDate 时显示倒数日；否则退化成快捷入口卡。
export default {
  id: 'countdown',
  name: '倒数日 / 快捷入口',
  defaultSize: 'small',

  // 无 fetchData —— 后台调度会直接跳过，起始页本地渲染
  settingsSchema: [
    { key: 'targetDate', label: '目标日期 (YYYY-MM-DD)', type: 'date', default: '' },
    { key: 'dateName', label: '事件名称', type: 'text', default: '重要日子' }
  ],

  render(data, config, inst) {
    const dateStr = (config.targetDate || '').trim();
    if (dateStr) {
      const target = new Date(`${dateStr}T00:00:00`).getTime();
      const days = Math.ceil((target - Date.now()) / 86400000);
      const text = days > 0 ? `还有 ${days} 天` : days === 0 ? '就是今天' : `已过去 ${Math.abs(days)} 天`;
      return `
        <div class="w-head">
          <span class="w-title">${inst?.title || config.dateName || '倒数日'}</span>
          <span class="w-badge ${days >= 0 && days <= 7 ? 'warn' : ''}">倒数</span>
        </div>
        <div class="w-big" style="font-size:26px">${text}</div>
        <div class="w-foot"><span>${dateStr} · ${config.dateName || ''}</span></div>`;
    }
    return `
      <div class="w-head">
        <span class="w-title">${inst?.title || '快捷入口'}</span>
        <span class="w-badge">快捷</span>
      </div>
      <div class="w-big" style="font-size:20px">打开站点 →</div>
      <div class="w-foot"><span>${(inst?.linkUrl || '点设置填写跳转地址').slice(0, 28)}</span></div>`;
  }
};
