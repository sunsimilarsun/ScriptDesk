// GitHub 提交热力图：默认免 Token 抓取 contributions 页面正则提取；
// 可选 PAT 走 GraphQL contributionCalendar 覆盖私有仓库。
// 纯 CSS Grid 渲染 7 行列流热力图，自适应明暗主题。

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 从 contributions 页面 HTML 用正则提取 day 数据
// 页面结构：<td data-date="YYYY-MM-DD" data-level="0-4" ...>提交数</td> 以及 tool-tip 含 "N contributions"
export function parseContributionsHtml(html) {
  const days = [];
  // 匹配 <td ... data-date="..." data-level="..." ...>N contributions</td>
  const re = /data-date="(\d{4}-\d{2}-\d{2})"[^>]*data-level="(\d)"[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = re.exec(html))) {
    const date = m[1];
    const level = Number(m[2]);
    let count = 0;
    const tip = m[3].match(/(\d+)\s*contributions?/i);
    if (tip) count = Number(tip[1]);
    days.push({ date, level, count });
  }
  return days;
}

// 从 GraphQL contributionCalendar 响应提取（可选 PAT 路径）
export function parseGraphql(json) {
  const weeks = json?.data?.user?.contributionsCollection?.contributionCalendar?.weeks;
  if (!Array.isArray(weeks)) throw new Error('GraphQL 响应缺少 contributionCalendar.weeks');
  const days = [];
  for (const wk of weeks) {
    for (const d of wk.contributionDays || []) {
      if (!d.date) continue;
      const count = Number(d.contributionCount) || 0;
      // 将贡献数映射为 0-4 级
      let level = 0;
      if (count > 0) level = count >= 20 ? 4 : count >= 10 ? 3 : count >= 5 ? 2 : 1;
      days.push({ date: d.date, level, count });
    }
  }
  return days;
}

// 计算统计：总提交数、今日提交数、当前连续天数（Streak）
export function computeStats(days, now = new Date()) {
  const map = new Map();
  let total = 0;
  for (const d of days) {
    const c = Number(d.count) || 0;
    map.set(d.date, c);
    total += c;
  }
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const today = map.get(todayStr) || 0;

  // 连续天数：从今天（或昨天，若今天还没提交）往前数连续有提交的天
  let streak = 0;
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // 若今天无提交，从昨天开始
  if (!map.has(todayStr)) cursor.setDate(cursor.getDate() - 1);
  for (let i = 0; i < 400; i++) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
    if ((map.get(key) || 0) > 0) { streak++; }
    else break;
    cursor.setDate(cursor.getDate() - 1);
  }
  return { total, today, streak };
}

// 将 days 整理成按列（周）排列的行（7 天）流矩阵，方便 CSS Grid 渲染
export function buildGrid(days) {
  const map = new Map();
  for (const d of days) map.set(d.date, { level: d.level, count: d.count });
  // 取最早日期，对齐到周日（GitHub 周从周日开始）
  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!sorted.length) return { cols: [], totalDays: 0 };
  const first = new Date(sorted[0].date);
  // 回退到周日
  first.setDate(first.getDate() - first.getDay());
  const cols = [];
  const cursor = new Date(first);
  const today = new Date();
  // 最多渲染 53 列（约一年）
  for (let w = 0; w < 53; w++) {
    const col = [];
    for (let d = 0; d < 7; d++) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
      col.push({ date: key, level: map.get(key)?.level ?? -1, count: map.get(key)?.count ?? 0, future: cursor > today });
      cursor.setDate(cursor.getDate() + 1);
    }
    cols.push(col);
    if (cursor > today) break;
  }
  return { cols, totalDays: days.length };
}

// 图例颜色：level 0-4，用 CSS 变量控制明暗（用透明度叠加在 accent 上，自动适配主题）
const LEVEL_FILL = ['var(--gh-0)', 'var(--gh-1)', 'var(--gh-2)', 'var(--gh-3)', 'var(--gh-4)'];

export default {
  id: 'github-heatmap',
  name: 'GitHub 热力图',
  defaultSize: 'large',
  refreshMinutes: 360,

  settingsSchema: [
    { key: 'username', label: 'GitHub 用户名', type: 'text', placeholder: 'octocat' },
    { key: 'pat', label: 'Personal Access Token（可选，覆盖私有仓库）', type: 'password', placeholder: 'ghp_... 留空则免 Token' }
  ],

  defaultLinkUrl(config) {
    const u = String(config?.username || '').trim();
    return u ? `https://github.com/${u}` : 'https://github.com/';
  },

  async fetchData(config, ctx) {
    const username = String(config.username || '').trim();
    if (!username) throw new Error('请填写 GitHub 用户名');
    const pat = String(config.pat || '').trim();

    let days;
    if (pat) {
      // GraphQL 路径：覆盖私有仓库
      const query = JSON.stringify({
        query: `query($user:String!){ user(login:$user){ contributionsCollection { contributionCalendar { weeks { contributionDays { date contributionCount } } } } } }`,
        variables: { user: username }
      });
      const res = await ctx.netFetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${pat}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: query
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`GraphQL HTTP ${res.status}${t ? '：' + t.slice(0, 120) : ''}`);
      }
      const json = await res.json();
      if (json?.errors?.length) throw new Error(json.errors[0].message || 'GraphQL 错误');
      days = parseGraphql(json);
    } else {
      // 免 Token：抓 contributions 页面
      const res = await ctx.netFetch(`https://github.com/users/${username}/contributions`, {
        headers: { 'Accept': 'text/html, */*' }
      });
      if (!res.ok) throw new Error(`contributions 页面 HTTP ${res.status}（用户是否存在？）`);
      const html = await res.text();
      days = parseContributionsHtml(html);
    }

    if (!days.length) throw new Error('未提取到提交数据，页面结构可能已变化');

    const stats = computeStats(days, new Date());
    const grid = buildGrid(days);
    return { username, ...stats, grid, hasPat: !!pat };
  },

  render(data, config, inst) {
    const cells = data.grid?.cols.map((col) => col.map((d) => {
      const fill = d.level >= 0 ? LEVEL_FILL[d.level] : 'var(--gh-0)';
      const tip = `${d.date} · ${d.count} 次提交`;
      const cls = d.level < 0 ? 'gh-cell empty' : 'gh-cell';
      return `<span class="${cls}" style="background:${fill}" title="${esc(tip)}"></span>`;
    }).join('')).join('') || '';

    const gridHtml = `<div class="gh-grid" role="img" aria-label="提交热力图">${cells}</div>`;

    const statsHtml = `<div class="gh-stats">
      <div class="gh-stat"><b>${data.total ?? 0}</b><span>总提交</span></div>
      <div class="gh-stat"><b>${data.today ?? 0}</b><span>今日</span></div>
      <div class="gh-stat"><b>${data.streak ?? 0}</b><span>连续天数</span></div>
    </div>`;

    return `<div class="w-head">
      <span class="w-title">${esc(inst?.title || `@${data.username}`)}</span>
      <span class="w-badge">${data.hasPat ? '私有+公开' : '公开'}</span>
    </div>
    <div class="gh-body">${statsHtml}${gridHtml}</div>`;
  },

  renderSmall(data, config, inst) {
    return `<div class="w-head"><span class="w-title">${esc(inst?.title || `@${data.username}`)}</span>
      <span class="w-badge">GitHub</span></div>
      <div class="gh-small">
        <div class="gh-small-today">今日 <b>${data.today ?? 0}</b></div>
        <div class="gh-small-streak">连续 <b>${data.streak ?? 0}</b> 天</div>
        <div class="gh-small-total">累计 ${data.total ?? 0} 次提交</div>
      </div>`;
  }
};
