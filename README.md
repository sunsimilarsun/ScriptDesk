# ScriptDesk — 浏览器小组件起始页

一个 Chrome / Edge 扩展，把「新标签页」变成可自定义的 Bento 风格小组件仪表盘。纯原生 JS + CSS，零依赖，Manifest V3 + ES Modules。

## 功能

- **双模式画布**：查看模式秒开读缓存；编辑模式支持拖拽排序、增删卡片、切换尺寸、配置参数。
- **多实例**：同一组件可添加多张卡片，各自独立配置与缓存。
- **内置组件（10 个）**：

| 组件 | 说明 |
|---|---|
| 📶 订阅余量 | 解析 `subscription-userinfo`，显示剩余流量与到期 |
| 📱 话费三环 | 联通话费 / 流量 / 语音（含余量查询页接口） |
| 🤖 AI 余额 | DeepSeek / 硅基流动 / OpenRouter / New API / OpenAI / Anthropic 余额与日耗 |
| 🔥 热榜 | V2EX / Hacker News |
| 🔢 任意 API | 通用 JSON 取值 |
| ⏳ 倒数日 | 倒数日与快捷入口 |
| 📰 RSS 订阅 | 多源 RSS / Atom 聚合，纯正则解析，点击打开原文 |
| 🟩 GitHub 热力图 | 提交热力图、总提交 / 今日 / 连续天数 |
| 💱 汇率行情 | Frankfurter 汇率 + Coinbase 加密行情 + Yahoo 指数 |
| 🌐 网络状态 | 双路探测判定直连 / 分流代理 / 全局代理 / 离线 |

## 安装

1. 下载本仓库代码（Clone 或下载 ZIP 解压）。
2. 打开 Chrome / Edge 的扩展管理页：`chrome://extensions`（Edge 为 `edge://extensions`）。
3. 打开右上角「开发者模式」。
4. 点「加载已解压的扩展程序」，选择本仓库根目录。
5. 新开一个标签页，即可看到起始页。点右上角「编辑」添加/配置组件。

## 目录结构

```
SubInfo-Extension/
├── manifest.json          # MV3 清单
├── background.js          # Service Worker 调度中心（按实例取数 + 缓存）
├── newtab.html/css/js     # 起始页（双模式画布）
├── popup.html/js          # 工具栏弹窗（订阅余量）
├── core/
│   ├── registry.js        # 组件注册表
│   ├── storage.js         # 多实例数据层
│   ├── dnr-fetch.js       # 受限请求头（UA/Cookie/Referer）经 DNR 注入
│   ├── cookie-sync.js     # 浏览器 Cookie 同步
│   └── rss-parser.js      # 纯正则 RSS/Atom 解析
└── widgets/               # 各组件实现（协议见下）
```

## 组件协议

每个组件是 `widgets/*.js` 里的默认导出对象，注册到 `core/registry.js` 的 `WIDGETS` 数组即可自动生效：

```js
export default {
  id: 'my-widget',
  name: '组件名',
  defaultSize: 'small',      // small / medium / large
  refreshMinutes: 60,        // 后台刷新周期
  settingsSchema: [...],     // 配置字段定义
  defaultLinkUrl(config) {}, // 可选：默认跳转链接
  async fetchData(config, ctx) {}, // 取数（ctx 含 netFetch / instanceId）
  render(data, config, inst, rec) {},      // medium/large 渲染
  renderSmall(data, config, inst, rec) {}  // small 渲染（可选）
};
```

## 隐私与安全

- 所有配置（含 API Key、Cookie）仅保存在本机 `chrome.storage.local`，不会上传。
- 网络请求直接由扩展发起，不经第三方中转。
- API Key、Cookie 等敏感信息建议仅在本地填写，不要在公开场合粘贴。

## License

MIT
