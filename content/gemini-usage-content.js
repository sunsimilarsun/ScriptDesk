// Gemini 用量 Content Script：在 gemini.google.com 页面上下文里同源取数。
// 为什么必须走这里：Gemini 登录态 Cookie 是 SameSite=Lax/Strict，且 Google 有 CheckCookie 校验，
// 扩展 service worker（chrome-extension:// 源）的跨站 fetch 即使 credentials:include 也会被判 CookieMismatch。
// 而本脚本注入在 gemini.google.com 页面里，用页面的同源 fetch（same-origin），
// Cookie / UA / Sec-Fetch-* / 指纹全部真实，Google 无法区分，100% 通过校验。
//
// 职责：
//   1) 同源 GET /u/{idx}/usage 提取 SNlM0e、邮箱（oPEP7c）、bl、f.sid
//   2) 同源 POST /_/BardChatUi/data/batchexecute 拉用量
//   3) 回传 background 持久化（含账号索引、邮箱、updatedAt）
//   4) 3~5 分钟冷却节流；收到 background 主动刷新消息则绕过冷却立即拉取

(() => {
  if (window.__scriptDeskGeminiUsageLoaded) return; // 防重复注入
  window.__scriptDeskGeminiUsageLoaded = true;

  const STORAGE_PREFIX = 'geminiUsageLive:';
  const COOLDOWN_MS = 4 * 60 * 1000; // 4 分钟冷却

  // 从 location.pathname 提取账号索引 /u/(\d+)，无则 0
  function currentAccountIndex() {
    const m = location.pathname.match(/\/u\/(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }

  // 从当前页面 HTML 提取参数（若页面已加载则直接用 document）
  function extractFromHtml(html) {
    const snlM0e =
      (html.match(/"SNlM0e":"([^"]+)"/) || [])[1] ||
      (html.match(/'SNlM0e':'([^']+)'/))?.[1] || '';
    const email =
      (html.match(/"oPEP7c":"([^"]+)"/) || [])[1] ||
      (html.match(/"([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})"/) || [])[1] || '';
    const bl = (html.match(/"bl":"([^"]+)"/) || [])[1] || '';
    const fSid = (html.match(/"f\.sid":"([^"]+)"/) || [])[1] ||
                 (html.match(/"FdrFJe":"([^"]+)"/) || [])[1] || '';
    return { snlM0e, email, bl, fSid };
  }

  // 套餐名提取
  function extractPlan(html) {
    const t = html || '';
    if (/AI\s*Ultra|Google\s*AI\s*Ultra/i.test(t)) return 'AI Ultra';
    if (/AI\s*Pro|Google\s*AI\s*Pro/i.test(t)) return 'AI Pro';
    if (/AI\s*Plus|Google\s*AI\s*Plus/i.test(t)) return 'AI Plus';
    if (/Gemini\s*Advanced/i.test(t)) return 'Gemini Advanced';
    return 'Free';
  }

  // 解析 batchexecute 响应（与组件侧 parseUsageResponse 同逻辑）
  function parseUsageResponse(raw) {
    const windows = [];
    if (!raw) return windows;
    let text = String(raw).replace(/^\)\]\}'\s*/m, '');
    const payloads = [];
    const strRe = /"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = strRe.exec(text)) !== null) {
      const s = m[1];
      if (s.startsWith('[') && /\d/.test(s) && s.length > 10 && s.length < 20000) {
        try { payloads.push(JSON.parse(s)); } catch (_) {}
      }
    }
    try { payloads.push(JSON.parse(text)); } catch (_) {}
    for (const p of payloads) { walkForUsage(p, windows); if (windows.length >= 4) break; }
    return windows;
  }

  function walkForUsage(node, out, depth = 0) {
    if (out.length >= 8 || depth > 16) return;
    if (!Array.isArray(node)) {
      if (node && typeof node === 'object') {
        for (const k of Object.keys(node)) walkForUsage(node[k], out, depth + 1);
      }
      return;
    }
    if (node.length === 4) {
      const limit = node[0], fraction = node[1], period = node[2], reset = node[3];
      if (typeof limit === 'number' && limit > 0 &&
          typeof fraction === 'number' && fraction >= 0 && fraction <= 1.5 &&
          (period === 1 || period === 2)) {
        let resetMs = null;
        if (Array.isArray(reset) && reset.length > 0) {
          const r0 = reset[0];
          if (Array.isArray(r0) && r0.length >= 1) {
            const sec = Number(r0[0]);
            if (sec > 1600000000) resetMs = sec * 1000;
          } else if (typeof r0 === 'number' && r0 > 1600000000) {
            resetMs = r0 * 1000;
          }
        }
        out.push({
          limit, fraction, period, resetMs,
          label: period === 2 ? '每周限额' : '5 小时限额',
          usedPercent: Math.round(Math.min(100, fraction * 100)),
          usedText: `${Math.round(Math.min(100, fraction * 100))}%`
        });
        return;
      }
    }
    for (const item of node) walkForUsage(item, out, depth + 1);
  }

  // 核心：同源取数
  async function collect(force = false) {
    const idx = currentAccountIndex();
    // 冷却节流（按账号索引记上次同步）；force 绕过
    const cooldownKey = `${STORAGE_PREFIX}cooldown:${idx}`;
    if (!force) {
      try {
        const got = await chrome.storage.local.get([cooldownKey]);
        const last = got[cooldownKey] || 0;
        if (Date.now() - last < COOLDOWN_MS) {
          return { ok: true, throttled: true, accountIndex: idx };
        }
      } catch (_) {}
    }

    try {
      // 阶段 1：同源 GET /u/{idx}/usage
      const usagePath = idx > 0 ? `/u/${idx}/usage` : '/usage';
      const pageRes = await fetch(usagePath, { credentials: 'same-origin' });
      if (!pageRes.ok) {
        return { ok: false, error: `usage 页 HTTP ${pageRes.status}`, accountIndex: idx };
      }
      const html = await pageRes.text();
      const meta = extractFromHtml(html);
      if (!meta.snlM0e) {
        return { ok: false, error: '未提取到 SNlM0e（可能未登录或被重定向）', accountIndex: idx, email: meta.email, plan: extractPlan(html) };
      }

      // 阶段 2：同源 POST batchexecute（复用页面已抓包确认的 rpcid）
      const rpcid = 'ESY5D';
      const args = [null,[2,3,7,8,9,10,11,16,18,19,20,23,24,25,26,27,28,29,31,32,33,34,35,37,39,40,41,42,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,64,65,66,67,68,70,72,77,78,79,87,89,91,92,93,94,96,97,99,100,101,102,103,104,105,106,108,109,110,111,112,113,114,115,116,117,118,119,121,122,123,124,126,127,128,129,130,131,132,133,136,137,138,139,140,141,145,146,147,148,152,154,155,158,160,161,162,163,165,166,171,174,175,176,177,178,179,180,181,182,183,184,185,187,188,189,191,192,193,194,195,197,198,199,200,201,202,203,204,205,206,207,210,211,215,217,221,222,223,228,232,233,234,235,236,238,239,244,245,247,248,249,250,251,252,254,255,257,259,260,261,265,266,270,272,280,287,291,293,296,297,301,315,316,317,318,319,320]];
      const fReq = JSON.stringify([[rpcid, JSON.stringify(args), null, 'generic']]);
      const body = new URLSearchParams();
      body.append('f.req', fReq);
      body.append('at', meta.snlM0e);

      const rpcRes = await fetch('/_/BardChatUi/data/batchexecute', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: body.toString()
      });
      if (!rpcRes.ok) {
        return { ok: false, error: `batchexecute HTTP ${rpcRes.status}`, accountIndex: idx, email: meta.email, plan: extractPlan(html) };
      }
      const raw = await rpcRes.text();
      const windows = parseUsageResponse(raw);

      // 若解析为空，附诊断摘要供后续对齐字段
      let diag = '';
      if (!windows.length) {
        diag = String(raw).slice(0, 400);
      }

      const result = {
        ok: true,
        accountIndex: idx,
        email: meta.email,
        plan: extractPlan(html),
        windows,
        diag,
        updatedAt: Date.now()
      };

      // 写冷却 + 持久化
      try { await chrome.storage.local.set({ [cooldownKey]: Date.now() }); } catch (_) {}
      try {
        await chrome.storage.local.set({ [`${STORAGE_PREFIX}${idx}`]: result });
      } catch (_) {}
      // 仅「非 force 的自动同步」才回传 background 让卡片即时更新；
      // force（响应 sendMessage 的主动刷新）不回传，避免 refreshTypeOnly → sendMessage → 回传 的死循环。
      if (!force) {
        try {
          chrome.runtime.sendMessage({ action: 'geminiUsageSynced', accountIndex: idx }).catch(() => {});
        } catch (_) {}
      }

      return result;
    } catch (err) {
      return { ok: false, error: err.message, accountIndex: idx };
    }
  }

  // 页面空闲后自动同步一次（带冷却）
  function autoSync() {
    collect(false);
  }

  // 监听 background 的主动刷新消息
  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req && req.action === 'geminiUsageRefresh') {
      // 若消息指定了账号索引且与当前页不符，跳过
      if (req.accountIndex !== undefined && req.accountIndex !== currentAccountIndex()) {
        sendResponse({ ok: false, skipped: true, accountIndex: currentAccountIndex() });
        return true;
      }
      collect(true).then((result) => sendResponse(result)).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true; // 异步响应
    }
  });

  // 页面加载完成即触发一次自动同步（document_idle 时已可用）
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(autoSync, 800);
  } else {
    document.addEventListener('DOMContentLoaded', () => setTimeout(autoSync, 800));
  }
})();
