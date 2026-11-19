// 通用 JSON 卡：任意 URL + 自定义 Headers（走 netFetch）+ 点号路径取值 + 单位/前缀/后缀。
// 万能兜底组件：API 余额、服务状态等都能变成一张卡。
function getByPath(obj, path) {
  if (!path) return obj;
  return String(path).split('.').reduce((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    return acc[key];
  }, obj);
}

export default {
  id: 'generic-json',
  name: '通用 JSON',
  defaultSize: 'small',
  refreshMinutes: 120,

  settingsSchema: [
    { key: 'url', label: '接口 URL', type: 'text', placeholder: 'https://api.example.com/balance' },
    { key: 'headers', label: '请求头 (JSON)', type: 'textarea', placeholder: '{"Authorization":"Bearer xxx"}', default: '{}' },
    { key: 'valuePath', label: '取值路径', type: 'text', placeholder: 'data.balance 或 balance_infos.0.total_balance' },
    { key: 'label', label: '指标名称', type: 'text', default: '余额' },
    { key: 'prefix', label: '前缀', type: 'text', default: '' },
    { key: 'suffix', label: '后缀/单位', type: 'text', default: '' }
  ],

  async fetchData(config, { netFetch }) {
    const url = (config.url || '').trim();
    if (!url) throw new Error('未配置接口 URL');

    let headers = {};
    if (config.headers) {
      try { headers = JSON.parse(config.headers); }
      catch { throw new Error('请求头不是合法 JSON'); }
    }

    const res = await netFetch(url, { headers });
    const json = await res.json();
    const raw = getByPath(json, (config.valuePath || '').trim());
    if (raw === undefined || raw === null) throw new Error(`路径 ${config.valuePath || '(空)'} 未取到值`);

    return {
      value: typeof raw === 'number' ? raw : String(raw),
      label: config.label || '数值'
    };
  },

  render(data, config, inst) {
    return `
      <div class="w-head">
        <span class="w-title">${inst?.title || data.label}</span>
        <span class="w-badge">JSON</span>
      </div>
      <div class="w-big">${config.prefix || ''}${data.value}<small>${config.suffix || ''}</small></div>
      <div class="w-foot"><span>${data.label}</span></div>`;
  }
};
