// 汇率与行情精简卡：Frankfurter（法币汇率）+ Coinbase（加密现货）+ 可选 Yahoo Finance 指数。
// 并发请求，单源失败不影响其他行；支持红涨绿跌 / 绿涨红跌切换。

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round = (n, p = 4) => { const f = 10 ** p; return Math.round(num(n) * f) / f; };

// 标的解析：FX:USD/CNY、CRYPTO:BTC-USD、INDEX:^GSPC 等，按行切分
export function parseSymbols(text) {
  const rows = String(text || '').split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
  return rows.map((r) => {
    const m = r.match(/^(FX|CRYPTO|INDEX)\s*:\s*([^\s]+)/i);
    if (!m) return null;
    return { kind: m[1].toUpperCase(), symbol: m[2].toUpperCase() };
  }).filter(Boolean);
}

// 默认标的
export const DEFAULT_SYMBOLS = 'FX:USD/CNY\nFX:HKD/CNY\nCRYPTO:BTC-USD\nCRYPTO:ETH-USD';

// Frankfurter 法币汇率：base 换 target，返回 { price, pct, label }
async function fetchFx(symbol, ctx) {
  const [base, target] = symbol.split('/');
  if (!base || !target) throw new Error('FX 标的格式应为 BASE/QUOTE');
  const url = `https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(base)}&symbols=${encodeURIComponent(target)}`;
  const res = await ctx.netFetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const price = num(json?.rates?.[target]);
  if (!price) throw new Error(`未找到 ${target} 汇率`);
  return { kind: 'FX', symbol, label: `${base}/${target}`, price, pct: null, change: null };
}

// Coinbase 现货：/products/{PAIR}/stats 返回 open/last/high/low
async function fetchCrypto(symbol, ctx) {
  const pair = symbol.replace('/', '-'); // BTC/USD -> BTC-USD
  const url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(pair)}/stats`;
  const res = await ctx.netFetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'ScriptDesk/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const last = num(json?.last);
  const open = num(json?.open);
  if (!last) throw new Error('缺少 last 价格');
  const pct = open > 0 ? (last - open) / open * 100 : null;
  const change = open > 0 ? last - open : null;
  return { kind: 'CRYPTO', symbol, label: pair, price: last, pct, change, base: json.base_currency || '' };
}

// Yahoo Finance v8 指数（可选）
async function fetchIndex(symbol, ctx) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  const res = await ctx.netFetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  const meta = result?.meta || {};
  const price = num(meta.regularMarketPrice);
  if (!price) throw new Error('缺少价格字段');
  const prev = num(meta.chartPreviousClose) || num(meta.previousClose);
  const pct = prev > 0 ? (price - prev) / prev * 100 : null;
  const change = prev > 0 ? price - prev : null;
  return { kind: 'INDEX', symbol, label: meta.symbol || symbol, price, pct, change, currency: meta.currency || '' };
}

export default {
  id: 'market',
  name: '汇率行情',
  defaultSize: 'medium',
  refreshMinutes: 15,

  settingsSchema: [
    { key: 'symbols', label: '标的清单（每行一个）', type: 'textarea', default: DEFAULT_SYMBOLS,
      placeholder: 'FX:USD/CNY\nCRYPTO:BTC-USD\nINDEX:^GSPC' },
    { key: 'colorMode', label: '涨跌配色', type: 'select', default: 'red-up', options: [
      { value: 'red-up', label: '红涨绿跌（中国习惯）' },
      { value: 'green-up', label: '绿涨红跌（国际习惯）' }
    ] }
  ],

  async fetchData(config, ctx) {
    const symbols = parseSymbols(config.symbols || DEFAULT_SYMBOLS);
    if (!symbols.length) throw new Error('请填写至少一个标的');
    const rows = await Promise.all(
      symbols.map(async (s) => {
        try {
          if (s.kind === 'FX') return { ...(await fetchFx(s.symbol, ctx)), ok: true };
          if (s.kind === 'CRYPTO') return { ...(await fetchCrypto(s.symbol, ctx)), ok: true };
          if (s.kind === 'INDEX') return { ...(await fetchIndex(s.symbol, ctx)), ok: true };
          return { kind: s.kind, symbol: s.symbol, label: s.symbol, ok: false, error: '未知类型' };
        } catch (err) {
          return { kind: s.kind, symbol: s.symbol, label: s.symbol, ok: false, error: err.message };
        }
      })
    );
    return { rows, colorMode: config.colorMode || 'red-up' };
  },

  render(data, config, inst) {
    const redUp = data.colorMode !== 'green-up';
    const cls = (pct) => {
      if (pct == null) return '';
      if (pct > 0) return redUp ? 'up' : 'down';
      if (pct < 0) return redUp ? 'down' : 'up';
      return '';
    };
    const rows = (data.rows || []).map((r) => {
      const pct = r.pct != null ? r.pct : null;
      const sign = pct != null ? (pct > 0 ? '+' : '') : '';
      const pctStr = pct != null ? `${sign}${round(pct, 2)}%` : '—';
      const priceStr = r.ok ? formatPrice(r.price) : '—';
      return `<div class="mk-row">
        <span class="mk-sym">${esc(r.label || r.symbol)}</span>
        <span class="mk-price">${esc(priceStr)}</span>
        <span class="mk-pct ${cls(pct)}">${pctStr}</span>
      </div>`;
    }).join('');
    return `<div class="w-head">
      <span class="w-title">${esc(inst?.title || '汇率行情')}</span>
      <span class="w-badge">${data.rows?.length ?? 0} 项</span>
    </div>
    <div class="mk-list">${rows || '<div class="w-empty">无数据</div>'}</div>`;
  },

  renderSmall(data, config, inst) {
    const first = (data.rows || [])[0];
    return `<div class="w-head"><span class="w-title">${esc(inst?.title || '汇率行情')}</span>
      <span class="w-badge">${data.rows?.length ?? 0}</span></div>
      <div class="mk-small">
        <div class="mk-small-sym">${esc(first?.label || '—')}</div>
        <div class="mk-small-price">${esc(first?.ok ? formatPrice(first.price) : '—')}</div>
      </div>`;
  }
};

function formatPrice(v) {
  const n = num(v);
  if (!n) return '0';
  if (Math.abs(n) >= 1000) return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  if (Math.abs(n) >= 1) return String(round(n, 2));
  return String(round(n, 4));
}
