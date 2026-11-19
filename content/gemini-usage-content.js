// Gemini 用量 Content Script（isolated world）：轻量监听 + 通知。
// 取数逻辑已迁移到 content/gemini-usage-main.js（MAIN world），由 background 通过
// chrome.scripting.executeScript({ world: 'MAIN' }) 注入执行，以绕开页面 CSP 对
// content script fetch 的 connect-src 拦截（Failed to fetch）。
//
// 本脚本职责：
//   1) 页面加载完成后，通知 background 有 gemini 页面打开，触发一次卡片刷新
//   2) 响应 background 的主动刷新消息（兼容旧路径，实际取数仍在 background 侧完成）
(() => {
  if (window.__scriptDeskGeminiUsageLoaded) return;
  window.__scriptDeskGeminiUsageLoaded = true;

  const COOLDOWN_MS = 4 * 60 * 1000;

  function currentAccountIndex() {
    const m = location.pathname.match(/\/u\/(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }

  // 页面加载后通知 background（带冷却，避免每次切换对话都触发）
  function notify() {
    const idx = currentAccountIndex();
    const key = `geminiUsageLive:cooldown:${idx}`;
    chrome.storage.local.get([key]).then((got) => {
      const last = got[key] || 0;
      if (Date.now() - last < COOLDOWN_MS) return;
      chrome.storage.local.set({ [key]: Date.now() }).catch(() => {});
      chrome.runtime.sendMessage({ action: 'geminiUsageSynced', accountIndex: idx }).catch(() => {});
    }).catch(() => {});
  }

  // 响应 background 主动刷新（兼容路径：background 实际用 MAIN world 取数，这里只作 ack）
  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req && req.action === 'geminiUsageRefresh') {
      sendResponse({ ok: true, accountIndex: currentAccountIndex() });
      return true;
    }
  });

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(notify, 800);
  } else {
    document.addEventListener('DOMContentLoaded', () => setTimeout(notify, 800));
  }
})();
