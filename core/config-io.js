// 配置导出 / 导入：把 layout 与全局 settings 序列化为可迁移的 JSON。
// 导出仅含 schemaVersion / settings / layout，不含 cache:* 缓存数据；
// 支持可选脱敏敏感凭据（API Key / 订阅链接 / Cookie）。
// 导入时校验结构合法性后返回待覆盖对象，由调用方确认并写回 storage 触发刷新。

export const CONFIG_SCHEMA_VERSION = 1;

// 需要脱敏的字段键（组件 config 里的敏感凭据），统一小写便于匹配
const SENSITIVE_KEYS = new Set([
  'suburl',          // 订阅链接
  'cookie',          // 运营商 / 控制台 Cookie
  'apikey',          // API Key
  'token',           // 各类 token
  'unicomusagetoken',// 联通 APP token
  'proxysecret',     // 代理控制器 secret
  'pat',             // GitHub PAT
  'password',
  'secret'
]);

// 判断某个 config 字段是否敏感
export function isSensitiveKey(key) {
  return SENSITIVE_KEYS.has(String(key || '').toLowerCase());
}

// 对单个值脱敏：字符串保留首尾少量字符，中间用 * 掩盖；非字符串返回占位
export function redactValue(value) {
  if (value === undefined || value === null || value === '') return value;
  const s = String(value);
  if (s.length <= 6) return '*'.repeat(s.length);
  return `${s.slice(0, 3)}${'*'.repeat(Math.min(s.length - 6, 12))}${s.slice(-3)}`;
}

// 深拷贝并（可选）脱敏 layout 中各组件的 config 敏感字段
export function redactLayout(layout, redact = false) {
  const out = JSON.parse(JSON.stringify(layout || []));
  if (!redact) return out;
  for (const inst of out) {
    const cfg = inst.config || {};
    for (const key of Object.keys(cfg)) {
      if (isSensitiveKey(key)) cfg[key] = redactValue(cfg[key]);
    }
  }
  return out;
}

// 组装导出对象：{ schemaVersion, settings, layout }，不含缓存
export function buildExport({ layout = [], settings = {} } = {}) {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    settings: JSON.parse(JSON.stringify(settings || {})),
    layout: JSON.parse(JSON.stringify(layout || []))
  };
}

// 校验导入数据：结构合法返回 { ok:true, value:{settings,layout} }，否则 { ok:false, error }
export function validateImport(data) {
  if (!data || typeof data !== 'object') return { ok: false, error: '不是有效的 JSON 对象' };
  if (data.schemaVersion !== undefined && !Number.isInteger(data.schemaVersion)) {
    return { ok: false, error: 'schemaVersion 字段非法' };
  }
  if (!Array.isArray(data.layout)) return { ok: false, error: '缺少 layout 数组' };
  for (const inst of data.layout) {
    if (!inst || typeof inst !== 'object' || typeof inst.type !== 'string') {
      return { ok: false, error: 'layout 中含非法条目（缺少 type）' };
    }
    if (!inst.instanceId) inst.instanceId = `inst_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }
  const settings = data.settings && typeof data.settings === 'object' ? data.settings : {};
  return { ok: true, value: { settings, layout: data.layout } };
}

// 生成导出文件名（含日期）
export function exportFilename(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `scriptdesk-config-${y}${m}${d}.json`;
}

// 触发浏览器下载
export function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
