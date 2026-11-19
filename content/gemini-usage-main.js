// Gemini 用量 MAIN world 取数函数。
// 为什么要在 MAIN world：content script（isolated world）里的 fetch 会被页面 CSP 的
// connect-src 拦截（报 Failed to fetch）。而本脚本用 chrome.scripting.executeScript 注入到
// 页面主世界，fetch 走页面自身上下文，同源请求受 connect-src 'self' 放行，100% 通过。
// 纯函数：不依赖 chrome.* API，只在页面 window 上挂一个全局取数函数，
// 由 background 通过 executeScript({ world: 'MAIN', func }) 调用并拿返回值。
(() => {
  // 注意：这里【不要】做「已存在就 return」的防重复注入拦截。
  // 扩展重载后，已打开的 Gemini 标签页内存里残留的是旧版函数；
  // 若此处拦截，executeScript 注入会跳过更新，继续跑旧代码。故每次注入都直接覆盖。
  // 用版本号标记便于排查：重载后 __scriptDeskGeminiMainVersion 会递增。
  const VERSION = 3;
  window.__scriptDeskGeminiMainVersion = VERSION;
  window.__scriptDeskGeminiMain = true;

  function currentAccountIndex() {
    const m = location.pathname.match(/\/u\/(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }

  function extractFromHtml(html) {
    const snlM0e =
      (html.match(/"SNlM0e":"([^"]+)"/) || [])[1] ||
      (html.match(/'SNlM0e':'([^']+)'/))?.[1] || '';
    const email =
      (html.match(/"oPEP7c":"([^"]+)"/) || [])[1] ||
      (html.match(/"([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})"/) || [])[1] || '';
    return { snlM0e, email };
  }

  // 优先从 window.WIZ_global_data 直接读，不再为拿 SNlM0e 去 fetch /usage。
  // 任意 gemini 页面的 WIZ_global_data 里都有 SNlM0e(at)/oPEP7c(邮箱)/cfb2h(bl)/FdrFJe(f.sid)。
  function metaFromWiz() {
    const w = window.WIZ_global_data || {};
    const snlM0e = w.SNlM0e || '';
    const email = w.oPEP7c || '';
    const bl = w.cfb2h || '';
    const fSid = w.FdrFJe || '';
    return { snlM0e, email, bl, fSid };
  }

  function extractPlan(html) {
    const t = html || '';
    if (/AI\s*Ultra|Google\s*AI\s*Ultra/i.test(t)) return 'AI Ultra';
    if (/AI\s*Pro|Google\s*AI\s*Pro/i.test(t)) return 'AI Pro';
    if (/AI\s*Plus|Google\s*AI\s*Plus/i.test(t)) return 'AI Plus';
    if (/Gemini\s*Advanced/i.test(t)) return 'Gemini Advanced';
    return 'Free';
  }

  // 解析 batchexecute 的分块响应。
  // 真实响应形态：
  //   )]}'\n232\n[["wrb.fr","jSf9Qc","[2,[[...]],false]",...],["di",342],...]\n25\n[["e",4,...]]
  // 步骤：剥离 )]}' 前缀 → 按 \n 逐行 → 跳过纯数字长度行 → 对 [ 开头的行 JSON.parse
  //   → 得到二维帧数组 → 遍历外层找 frame[0]==='wrb.fr' && frame[1]===rpcid && typeof frame[2]==='string'
  //   → 对 frame[2] 二次 JSON.parse 得到 payload。
  function parseWrbFrames(raw, rpcid) {
    const text = String(raw || '').replace(/^\)\]\}'\s*/m, '');
    const lines = text.split('\n');
    for (const line of lines) {
      const s = line.trim();
      if (!s || !s.startsWith('[')) continue; // 跳过空行和纯数字长度行（如 232、25）
      let outer;
      try { outer = JSON.parse(s); } catch (_) { continue; }
      if (!Array.isArray(outer)) continue;
      for (const frame of outer) {
        if (Array.isArray(frame) && frame[0] === 'wrb.fr' && frame[1] === rpcid && typeof frame[2] === 'string') {
          try { return JSON.parse(frame[2]); } catch (_) { return null; }
        }
      }
    }
    return null;
  }

  // 从 payload 解析窗口列表（严格按实测下标）
  function windowsFromPayload(payload) {
    const windows = [];
    if (!Array.isArray(payload) || !Array.isArray(payload[1])) return windows;
    const list = payload[1];
    for (const item of list) {
      if (!Array.isArray(item)) continue;
      const remaining = item[0];          // 剩余点数（不是上限）
      const usedFraction = item[1];       // 已用比例 0~1
      const windowType = item[2];         // 1=5 小时限额，2=每周限额
      const totalLimit = item[6];         // 总额度上限
      // 重置时间：item[3][0][0] 是 Unix 秒级时间戳
      let resetMs = null;
      const resetArr = item[3];
      if (Array.isArray(resetArr) && Array.isArray(resetArr[0]) && typeof resetArr[0][0] === 'number') {
        resetMs = resetArr[0][0] * 1000;
      }
      if (typeof remaining !== 'number' || typeof usedFraction !== 'number') continue;

      const usedPercent = Math.min(100, Math.max(0, usedFraction * 100));
      const pctText = Number.isInteger(usedPercent)
        ? `${usedPercent}%`
        : `${usedPercent.toFixed(1)}%`;
      windows.push({
        remaining,
        totalLimit,
        usedFraction,
        windowType,
        resetMs,
        label: windowType === 2 ? '每周限额' : '5 小时限额',
        usedPercent,
        usedText: pctText,
        tooltip: `剩余 ${remaining} / ${totalLimit}`
      });
    }
    // 按 windowType 升序（5 小时限额在每周限额上方）
    windows.sort((a, b) => a.windowType - b.windowType);
    return windows;
  }

  function parseUsageResponse(raw, rpcid) {
    const payload = parseWrbFrames(raw, rpcid);
    if (!payload) return { windows: [], statusEnum: null, extraCreditsEnabled: null };
    return {
      windows: windowsFromPayload(payload),
      statusEnum: payload[0] ?? null,           // 套餐/状态枚举值
      extraCreditsEnabled: payload[2] ?? null   // 是否开启额外 AI 积分
    };
  }

  // 取数主函数：返回 { ok, accountIndex, email, plan, windows, diag, error }
  async function collectUsage(accountIndexArg) {
    const idx = Number.isInteger(accountIndexArg) && accountIndexArg >= 0 ? accountIndexArg : currentAccountIndex();
    try {
      // 优先直接读 window.WIZ_global_data（任意页都有 SNlM0e/邮箱），不再 fetch /usage
      let meta = metaFromWiz();
      let plan = extractPlan(document.documentElement ? document.documentElement.innerHTML : '');

      // 读不到 SNlM0e 才回退 fetch HTML（带 redirect: 'manual' 检测跨域 302）
      if (!meta.snlM0e) {
        const usagePath = idx > 0 ? `/u/${idx}/usage` : '/usage';
        const usageUrl = `${location.origin}${usagePath}`;
        let pageRes;
        try {
          pageRes = await fetch(usageUrl, { credentials: 'same-origin', redirect: 'manual' });
        } catch (e) {
          return { ok: false, accountIndex: idx, error: `usage 页请求异常：${e.message}` };
        }
        // redirect: 'manual' 下，跨域 302 会返回 opaqueredirect，读不到内容
        if (pageRes.type === 'opaqueredirect') {
          return { ok: false, accountIndex: idx, error: 'usage 页发生跨域重定向（可能未登录，302 到 accounts.google.com）' };
        }
        if (!pageRes.ok) {
          return { ok: false, accountIndex: idx, error: `usage 页 HTTP ${pageRes.status}` };
        }
        if (pageRes.url && /accounts\.google\.com/i.test(pageRes.url)) {
          return { ok: false, accountIndex: idx, error: '登录态失效：已重定向到 accounts.google.com 登录页' };
        }
        const html = await pageRes.text();
        meta = extractFromHtml(html);
        plan = extractPlan(html);
        if (!meta.snlM0e) {
          return { ok: false, accountIndex: idx, email: meta.email, plan, error: '未提取到 SNlM0e（可能未登录或被重定向）' };
        }
      }

      // ---------- 请求构造（对齐已实测返回 200 的格式） ----------
      const rpcid = 'jSf9Qc';
      // URL 路径前缀按 location.pathname 动态获取（默认账号为空字符串 → 路径就是 /_/BardChatUi/data/batchexecute）
      const pathPrefix = location.pathname.match(/^(\/u\/\d+)/)?.[1] || '';
      // Body：f.req 为标准三层嵌套，args 为字符串 '[]'
      const fReq = JSON.stringify([[['jSf9Qc', '[]', null, 'generic']]]);
      const body = new URLSearchParams();
      body.append('f.req', fReq);
      body.append('at', meta.snlM0e);

      // Query 参数：rpcids / source-path / hl=en / rt=c，有值时附带 bl 和 f.sid
      const qp = new URLSearchParams();
      qp.set('rpcids', rpcid);
      qp.set('source-path', idx > 0 ? `/u/${idx}/usage` : '/usage');
      qp.set('hl', 'en');
      qp.set('rt', 'c');
      if (meta.bl) qp.set('bl', meta.bl);
      if (meta.fSid) qp.set('f.sid', meta.fSid);

      const rpcUrl = `${location.origin}${pathPrefix}/_/BardChatUi/data/batchexecute?${qp.toString()}`;
      const rpcRes = await fetch(rpcUrl, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
        body: body.toString()
      });
      if (!rpcRes.ok) {
        return { ok: false, accountIndex: idx, email: meta.email, plan, error: `batchexecute HTTP ${rpcRes.status}` };
      }
      const raw = await rpcRes.text();
      const parsed = parseUsageResponse(raw, rpcid);
      const windows = parsed.windows;
      let diag = '';
      if (!windows.length) {
        diag = String(raw).slice(0, 500);
        // 解析不到用量：把原始响应摘要打印到页面 console，方便对齐字段下标
        try {
          console.log('[ScriptDesk][Gemini] batchexecute 响应前 500 字：\n' + diag);
        } catch (_) {}
      }

      return {
        ok: true,
        accountIndex: idx,
        email: meta.email,
        plan,
        windows,
        statusEnum: parsed.statusEnum,
        extraCreditsEnabled: parsed.extraCreditsEnabled,
        diag,
        updatedAt: Date.now()
      };
    } catch (err) {
      return { ok: false, accountIndex: idx, error: err.message };
    }
  }

  window.__scriptDeskCollectUsage = collectUsage;
})();
