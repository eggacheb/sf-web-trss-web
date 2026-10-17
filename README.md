# SFChat 前端

配合 [sf-web-adapter](https://github.com/eggacheb/sf-web-trss) 使用的浏览器聊天界面。

纯静态 HTML / CSS / JavaScript，**没有构建步骤**，丢到任意静态托管就能跑。

> 服务端插件不在这个仓库。插件的安装、配置和协议实现见 [sf-web-trss](https://github.com/eggacheb/sf-web-trss)。

## 它做什么

浏览器通过 WebSocket 连到机器人身上的 adapter 插件，消息被注入 Yunzai 的私聊事件流，功能插件照常处理，回复再推回页面。体验和微信私聊一致，只是把微信 App 换成了网页。

```text
这个仓库（静态页面）
        │  ws://host:8082
        ▼
sf-web-adapter 插件（跑在 Yunzai 里）
        │  Bot.em("message.private", e)
        ▼
TRSS-Yunzai 内核 → 各功能插件
```

## 部署

### Netlify

- publish directory：仓库根目录 `.`
- 构建命令：无
- 缓存头已写在 `netlify.toml` 里

### Vercel

- 构建命令：无
- `vercel.json` 已配置静态托管与缓存头

### 自建静态服务器

根目录指向本仓库即可。注意必须在 `http://` 或 `https://` 下访问 —— `file://` 打不开，因为 Service Worker 需要安全上下文（`localhost` 算安全上下文，本地调试没问题）。

```bash
# 本地快速预览
python -m http.server 8080
# 或
npx serve .
```

## 连接机器人

打开页面 → 右上角设置，填四项：

| 字段 | 说明 |
|---|---|
| IP 地址或域名 | 机器人所在主机的地址 |
| 端口 | 对应 adapter 的 `ws_port`，默认 `8082` |
| 访问密码 | 对应 adapter 的 `access_password`，留空则免密 |
| QQ 号 | 只用于头像和本地缓存分区，不影响服务端身份 |
| 机器人 QQ | 同上，只影响头像 |

### HTTPS 页面连 ws:// 的问题

页面以 `https://` 打开时，浏览器会拦截 `ws://` 明文连接（混合内容）。两种解法：

**方案一：浏览器放行**（最快）

- 桌面 Chrome / Edge：地址栏左侧图标 → 网站设置 → 不安全内容 → 允许
- Android Chrome / Edge：打开 `chrome://flags`，搜索 insecure，把 `ws://你的IP:端口` 填进 *Insecure origins treated as secure*（多个用英文逗号分隔）并启用

**方案二：给 adapter 配 WSS**

用 Nginx / Caddy 反向代理加证书，然后把完整地址写进 `js/app.js` 顶部的 `WS_DIRECT_URL`：

```js
const WS_DIRECT_URL = 'wss://ws.your-domain.com';
```

留空则表示使用设置面板里填的地址直连。

## 功能

- 私聊对话，支持 Markdown、代码高亮、LaTeX 公式、图片点击看大图
- 图片与语音收发
- 历史记录：文本存服务端 Redis，媒体走本地 IndexedDB + 服务端按需拉取
- 清空对话：同时清掉服务端历史、服务端媒体文件和本地缓存
- PWA：可添加到主屏幕，断网时仍能打开界面

## 媒体缓存机制

这是本仓库最需要理解的一块，分两层：

```text
实时收到的图片/语音
        │
        ├─→ IndexedDB（sf_chat_media_cache）   ← 热缓存，刷新不丢、离线可看
        └─→ 服务端 data/media/<userQQ>/        ← 冷备份，由 adapter 负责

重新打开页面加载历史
        │
        ├─ 1. 先查 IndexedDB：命中直接渲染（快）
        └─ 2. 未命中 → 按 medias[].id 发 getMedia 向 adapter 拉（慢但兜底）
```

**第 2 步就是"关掉网页期间机器人主动推的图也能补回来"的关键。** 改造前历史里只有 `[图片]` 占位符，媒体永远找不回。

几个实现细节：

- 缓存分区 = `连接地址:端口:QQ号`，换账号或换服务器不会串数据
- 打开历史时只预取**最近 60 条**的媒体，并发 4，单条 8 秒超时，避免一次拉几百 MB
- 媒体缺失时保留 `[图片]` / `[语音]` 占位符，不阻塞历史回放
- 每条媒体的 `pos` 字段标明它是这条消息里的第几个占位符，个别媒体缺失时不会让后面的图整体错位

服务端默认保留 14 天或 500 MB（`media_retention_days` / `media_max_size_mb` 可配），清空对话会立刻删除。

## 与 adapter 的协议

**浏览器 → 插件**

| type | 字段 | 说明 |
|---|---|---|
| `auth` | `password` | 密码认证 |
| `loadHistory` | `userQQ`, `timestamp` | 加载历史 |
| `message` | `content`, `images[]`, `userQQ` | 发送消息，`images` 为 base64 或 data URL |
| `clearHistory` | `userQQ` | 清空历史与媒体 |
| `getMedia` | `userQQ`, `id` | 按需拉取历史媒体 |

**插件 → 浏览器**

| type | 字段 | 说明 |
|---|---|---|
| `auth` | `success` | 认证结果 |
| `history` | `messages[]` | 历史列表，每条可能带 `medias` 引用 |
| `historyCleared` | — | 清空完成 |
| `typing` | `active` | 正在输入状态 |
| `media` | `id`, `mime`, `dataUrl` | 媒体内容（base64） |
| `mediaMissing` | `id` | 媒体已过期或被清理 |
| `error` | `content` | 错误信息 |
| _(无 type)_ | `content` | 普通回复消息 |

同一时刻只有最后一个认证成功的连接可以收发消息，旧连接继续发会收到"当前连接已被新的 Web 会话接管"。

## 目录结构

```text
sf-web-trss-web/
├── index.html            页面骨架 + SW 更新后自动刷新脚本
├── js/
│   ├── app.js            主应用：状态 / 媒体缓存 / 渲染 / WebSocket / 设置
│   ├── marked.min.js     Markdown 渲染
│   ├── highlight.min.js  代码高亮
│   └── mathjax/          数学公式
├── css/
│   ├── main.css
│   └── github.min.css
├── fonts/                内嵌字体
├── images/               头像与图标
├── manifest.json         PWA 清单
├── sw.js                 Service Worker（network-first + 离线兜底）
├── netlify.toml          Netlify 缓存头
├── vercel.json           Vercel 配置
└── README.md
```

`app.js` 内部按模块组织：连接配置 → 全局状态 → 工具函数 → 媒体缓存 → Markdown 渲染 → 消息管理 → WebSocket 管理 → 设置管理 → 图片管理 → 事件绑定 → 初始化。

## 移动端键盘适配

只有一条规则：**`--app-height` 永远等于 `visualViewport.height`**。

```js
// js/app.js · initMobileSupport()
root.style.setProperty('--app-height', Math.round(window.visualViewport.height) + 'px');
```

`visualViewport.height` 是浏览器给出的「用户当前真正能看到的区域」——键盘弹起时它自己会变小，收起时自己会变大。`body { height: var(--app-height) }` 跟着走，输入框就在 flex 流的末尾，天然贴着键盘上沿。

这套方案成立的前提是让浏览器自己收缩视口（`resizes-content`：布局视口和可视视口一起缩，页面不会被滚来滚去）：

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, interactive-widget=resizes-content">
```

浏览器不支持这个提示时会退回默认的 `resizes-visual`（只缩可视视口），`visualViewport.height` 依然会变，JS 照样能读到正确值。iOS Safari 忽略这个提示，但它本来就会缩可视视口，也走同一条路径。

### 三条不要做的事

1. **不要改成 `interactive-widget=overlays-content`。** 它会让键盘浮在内容上方、`visualViewport` 完全不变化，你就只能靠 VirtualKeyboard API 自己算高度，算错一次就是半屏空白或输入框被盖住。
2. **不要估算键盘高度。** 任何 `height * 0.42` 之类的猜测都假设「键盘一定开着」，但用户按下返回键收起键盘时输入框通常**不会失焦**，这个假设直接失效——界面会按「键盘还开着」渲染，留下半屏背景色。
3. **不要用 `focus` / `blur` 推断键盘状态。** Android 返回键收键盘不触发 `blur`，iOS 点键盘上的「完成」也不一定触发。只认 `visualViewport` 的 `resize` 事件。

### 这段历史值得记住

2026-06-13 那天，16:10 到 21:58 之间连续产生了 21 个 `fix(mobile)` 提交，反复在 `position: fixed`、flex 布局、`scrollTo(0,0)`、`100dvh`、VirtualKeyboard API 之间来回换。当时用的浏览器是狐猴浏览器，它装 PWA 时对 viewport 的支持不完整，所以无论怎么改都不对——问题根本不在代码。

换到 Edge 之后原生行为就是正常的。最后留下来的是 `a9a97eb` 那版「overlays-content + 按比例估算」的兜底，它反而把 Edge 上正常的收起动作算成了「键盘仍占 42% 屏高」，于是有了收起键盘后下半屏空白的现象。现在的实现把这个兜底整个删掉了，只保留浏览器原生信号。

## 发版注意

改了 `js/app.js` 或 `css/main.css` 之后，**必须同步做三件事**，否则用户浏览器会一直跑旧代码：

1. `index.html` 里的版本号：

   ```html
   <link rel="stylesheet" href="css/main.css?v=YYYYMMDD">
   <script src="js/app.js?v=YYYYMMDD"></script>
   ```

2. `sw.js` 的缓存名递增：`sfchat-v12` → `sfchat-v13`

3. `sw.js` 的 `urlsToCache` 里同步同样的版本号

缓存策略是 `network-first`（联网时优先拿新内容，断网才用缓存），配合 `skipWaiting` + `clients.claim`。Service Worker 更新后，`index.html` 里的内联脚本会在 `controllerchange` 时自动刷新一次页面，不需要用户手动清缓存。

> 第一次升级到带自动刷新的版本时，老用户可能仍需手动刷新一次 —— 因为那一次页面上跑的还是没有这段逻辑的旧代码。

## 浏览器要求

现代浏览器：Chrome / Edge 88+、Safari 15+、Firefox 90+。

IndexedDB 不可用时（如隐私模式）自动降级：不缓存媒体，历史里只显示占位符，其余功能不受影响。
