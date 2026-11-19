document.addEventListener('DOMContentLoaded', async () => {
  const remainEl = document.getElementById('remain-gb');
  const usedEl = document.getElementById('used-gb');
  const totalEl = document.getElementById('total-gb');
  const daysEl = document.getElementById('days');
  const progressEl = document.getElementById('progress-fill');
  const timeEl = document.getElementById('update-time');
  const inputEl = document.getElementById('sub-input');

  // 读取本地缓存并渲染
  function render(data, lastUpdate) {
    if (!data) return;
    remainEl.innerHTML = `${data.remainGB} <span>GB 剩余</span>`;
    usedEl.textContent = `${data.usedGB}`;
    totalEl.textContent = `${data.totalGB}`;
    daysEl.textContent = `${data.days}`;
    progressEl.style.width = `${data.percent}%`;
    if (lastUpdate) timeEl.textContent = lastUpdate;
  }

  const { subUrl, subData, lastUpdate } = await chrome.storage.local.get(['subUrl', 'subData', 'lastUpdate']);
  if (subUrl) inputEl.value = subUrl;
  if (subData) render(subData, lastUpdate);

  // 保存订阅地址（同时写新组件配置，保证起始页与 popup 同步）
  document.getElementById('btn-save').addEventListener('click', async () => {
    const url = inputEl.value.trim();
    if (!url) return;
    await chrome.storage.local.set({ subUrl: url, 'config:subinfo': { subUrl: url } });
    chrome.runtime.sendMessage({ action: 'refresh' }, () => {
      setTimeout(async () => {
        const res = await chrome.storage.local.get(['subData', 'lastUpdate']);
        render(res.subData, res.lastUpdate);
      }, 800);
    });
  });

  // 打开起始页
  document.getElementById('btn-newtab').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('newtab.html') });
  });

  // 手动点击刷新
  document.getElementById('btn-refresh').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'refresh' }, () => {
      setTimeout(async () => {
        const res = await chrome.storage.local.get(['subData', 'lastUpdate']);
        render(res.subData, res.lastUpdate);
      }, 800);
    });
  });
});
