// Cookie 同步：按运营商域名读取浏览器当前登录态，拼接成标准 Cookie 字符串。
// 依赖 manifest 的 "cookies" 权限 + host_permissions。
export const CARRIERS = {
  unicom: {
    name: '中国联通',
    domains: ['10010.com'],
    // 余额页实际运行在 imgxx 域，接口在 mxx 域；两个 URL 都扫一遍，避免漏掉单边 Cookie
    urls: [
      'https://imgxx.client.10010.com/shengyuhuafeiwt2024/index.html',
      'https://imgxx.client.10010.com/yuliangchaxunsfwt/index.html',
      'https://mxx.client.10010.com/',
      'https://m.client.10010.com/'
    ],
    loginUrl: 'https://imgxx.client.10010.com/shengyuhuafeiwt2024/index.html#/',
    ua: 'ChinaUnicom4.x/10.01 (iPhone; iOS 16.0)',
    referer: 'https://imgxx.client.10010.com/shengyuhuafeiwt2024/index.html#/'
  },
  telecom: {
    name: '中国电信',
    domains: ['189.cn'],
    loginUrl: 'https://m.189.cn/',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    referer: 'https://m.189.cn/'
  },
  mobile: {
    name: '中国移动',
    domains: ['10086.cn'],
    loginUrl: 'https://m.10086.cn/',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    referer: 'https://m.10086.cn/'
  },
  // 硅基流动国内站：余额 API 已下线，只能读控制台登录态（.siliconflow.cn 域）
  siliconflow: {
    name: '硅基流动',
    domains: ['siliconflow.cn'],
    loginUrl: 'https://cloud.siliconflow.cn/me/expensebill',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    referer: 'https://cloud.siliconflow.cn/'
  },
  // ChatGPT / Codex：套餐限额来自内部接口 wham/usage，登录态靠 chatgpt.com 域 Cookie
  chatgpt: {
    name: 'ChatGPT / Codex',
    domains: ['chatgpt.com'],
    urls: [
      'https://chatgpt.com/settings/usage',
      'https://chatgpt.com/'
    ],
    loginUrl: 'https://chatgpt.com/settings/usage?tab=overview',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    referer: 'https://chatgpt.com/'
  },
  // MoeRouter 等 new-api 系中转站：真实余额在 /api/user/self，登录态靠 moerouter.com 域 Cookie + nap_ 访问令牌
  moerouter: {
    name: 'MoeRouter',
    domains: ['moerouter.com'],
    urls: [
      'https://moerouter.com/console',
      'https://moerouter.com/'
    ],
    loginUrl: 'https://moerouter.com/sign-in',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    referer: 'https://moerouter.com/'
  }
};

// 读取某运营商域名下的全部 Cookie，拼成 "name=value; ..." 标准串
export async function syncBrowserCookie(operator) {
  const carrier = CARRIERS[operator];
  if (!carrier) throw new Error(`未知运营商：${operator}`);

  const all = [];
  for (const domain of carrier.domains || []) {
    const list = await chrome.cookies.getAll({ domain });
    all.push(...list);
  }
  // 某些登录态只挂在具体站点下，按 URL 再补一次
  for (const url of carrier.urls || []) {
    const list = await chrome.cookies.getAll({ url });
    all.push(...list);
  }

  // 同名 Cookie 可能来自不同子域/路径，去重（保留最后写入的一个）
  const seen = new Map();
  for (const c of all) {
    seen.set(`${c.name}@${c.domain}${c.path}`, c);
  }
  const pairs = [...seen.values()]
    .filter((c) => c.name && c.value !== undefined)
    .map((c) => `${c.name}=${c.value}`);

  if (!pairs.length) {
    throw new Error(`浏览器里没有 ${carrier.name} 的登录 Cookie，请先点「去官网登录」并登录`);
  }
  return pairs.join('; ');
}

// 从 Cookie 串里提取 token_online（联通续期用）
export function extractToken(cookieStr, name = 'token_online') {
  const m = String(cookieStr || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1].trim()) : '';
}

// 官网登录链接（编辑抽屉按钮用）
export function getLoginUrl(operator) {
  return CARRIERS[operator]?.loginUrl || '';
}
