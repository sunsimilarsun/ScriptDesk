// 纯正则 RSS 2.0 / Atom 解析器（Service Worker 中无 DOMParser，禁用）。
// 支持 CDATA、HTML 实体、RSS 2.0 <item> 与 Atom <entry>，多订阅源合并按时间倒序。

// 解码 HTML 实体（&amp; &lt; &gt; &quot; &#39; &#x27; 及十进制/十六进制数字实体）
export function decodeEntities(str) {
  return String(str ?? '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ''; } })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

// 去掉标签与 CDATA 包裹，再解实体、压缩空白
function clean(raw) {
  return decodeEntities(
    String(raw ?? '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]*>/g, '')
  ).replace(/\s+/g, ' ').trim();
}

// 取单个标签内容：优先取带属性匹配（如 <link href="..."> 无闭合），再退回普通配对标签
function tagContent(block, tag) {
  // 自闭合 / 无闭合：<link href="..."/> 或 <link ...>
  const self = block.match(new RegExp(`<${tag}\\b[^>]*?(?:href|src|url)=["']([^"']+)["'][^>]*\\/?>`, 'i'));
  if (self) return self[1];
  const pair = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return pair ? pair[1] : '';
}

// 解析 ISO/RFC 日期，容错各种格式；失败返回 0（排到最前或最后由调用方决定）
export function parseDate(str) {
  const s = String(str ?? '').trim();
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

// 从 XML 文本解析条目。返回 [{title, link, desc, date, dateTs, source}]
// 自动识别 RSS 2.0 (<item>) 与 Atom (<feed> + <entry>)。
export function parseFeed(xml, sourceTitle = '') {
  const text = String(xml ?? '');
  const items = [];

  // Atom：<feed> 容器下 <entry>
  if (/<feed\b/i.test(text) && /<entry\b/i.test(text)) {
    const entries = text.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
    const feedTitle = tagContent(text, 'title');
    for (const e of entries) {
      const title = clean(tagContent(e, 'title'));
      const linkRaw = tagContent(e, 'link');
      // Atom 的 link 可能是 <link href="..."/> 或 <link rel="alternate" href="..."/>
      const link = linkRaw || (e.match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1] || '');
      const desc = clean(tagContent(e, 'summary') || tagContent(e, 'content'));
      const date = tagContent(e, 'updated') || tagContent(e, 'published');
      items.push({ title, link, desc, date, dateTs: parseDate(date), source: sourceTitle || clean(feedTitle) });
    }
  } else {
    // RSS 2.0：<item> 与 <entry> 都按 item 兜底
    const blocks = text.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) || [];
    const feedTitle = tagContent(text, 'title');
    for (const b of blocks) {
      const title = clean(tagContent(b, 'title'));
      const link = tagContent(b, 'link') || (b.match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1] || '');
      const desc = clean(tagContent(b, 'description') || tagContent(b, 'summary') || tagContent(b, 'content'));
      const date = tagContent(b, 'pubDate') || tagContent(b, 'dc:date') || tagContent(b, 'updated') || tagContent(b, 'published');
      items.push({ title, link, desc, date, dateTs: parseDate(date), source: sourceTitle || clean(feedTitle) });
    }
  }

  // 过滤无标题且无链接的空条目
  return items.filter((it) => it.title || it.link);
}

// 合并多个源的条目：按时间倒序，去重（按 link 优先、退 title），截取最大条数。
export function mergeFeeds(feeds, maxItems = 20) {
  const seen = new Set();
  const merged = [];
  for (const feed of feeds) {
    for (const it of feed.items || []) {
      const key = it.link || it.title || '';
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(it);
    }
  }
  merged.sort((a, b) => (b.dateTs || 0) - (a.dateTs || 0));
  return merged.slice(0, Math.max(1, Number(maxItems) || 20));
}
