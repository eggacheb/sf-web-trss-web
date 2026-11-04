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
| QQ 号 | 用于头像，以及区分服务端的对话历史分区 |
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
- 历史记录：完整消息（markdown 原文 + 媒体引用）只存服务端，浏览器不保存任何聊天记录
- 两个清空操作：「清空页面」只清当前显示，重新连接即可恢复；「清空对话记录」删服务端历史和媒体文件
- PWA：可添加到主屏幕，断网时仍能打开界面

## 后端唯一数据源

这是本仓库最需要理解的一块：**浏览器不保存任何聊天记录**。

```text
发消息 / 收回复
        │
        ├─→ 页面即时渲染（data URL 用完即弃）
        └─→ 后端：Redis 存原文 + media:<id> 引用，data/media/ 存媒体文件

重新连接 / 换浏览器 / 清浏览器站点数据
        │
        ├─ 1. loadHistory 一次拿回全部历史，文本立刻渲染
        └─ 2. 按 content 里的 media:<id> 发 getMedia 补图片语音（异步，不阻塞）
```

几个实现细节：

- Redis 里不存 base64，媒体位置写成 `![图片](media:<id>)` 或 `<audio controls src="media:<id>">`，前端按 `id` 精确替换，不再按内容猜哪张图属于哪条消息
- 前端只在当前页面会话的**内存**里暂存已拉取的 dataUrl，刷新就重新向后端取；没有 IndexedDB、没有内容指纹匹配
- 收到 `history` 时先同步渲染完所有消息，媒体回来后只刷新引用到该 `id` 的那几条；某张图取不到也不会让整页空白
- 媒体缺失时保留 `[图片]` / `[语音]` 占位符，其余消息照常显示
- 服务端默认保留 14 天或 500 MB（`media_retention_days` / `media_max_size_mb` 可配），「清空对话记录」会立刻删除

## 与 adapter 的协议

**浏览器 → 插件**

| type | 字段 | 说明 |
|---|---|---|
| `auth` | `password` | 密码认证 |
| `loadHistory` | `userQQ`, `before?`, `limit?` | 加载历史，可选增量游标 |
| `message` | `content`, `images[]`, `userQQ` | 发送消息，`images` 为 base64 或 data URL |
| `clearHistory` | `userQQ` | 只由「清空对话记录」按钮发送，删服务端历史与媒体 |
| `getMedia` | `userQQ`, `id` | 按需拉取历史媒体 |

**插件 → 浏览器**

| type | 字段 | 说明 |
|---|---|---|
| `auth` | `success` | 认证结果 |
| `history` | `messages[]`, `hasMore` | 历史列表；每条含 `id`、`content`（媒体为 `media:<id>` 引用）和 `medias` |
| `historyCleared` | — | 服务端历史已清空（按钮或 `#web清空记录` 触发后广播） |
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
│   ├── app.js            主应用：状态 / 服务端媒体 / 渲染 / WebSocket / 设置
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

`app.js` 内部按模块组织：连接配置 → 全局状态 → 工具函数 → 服务端媒体（仅会话内存） → Markdown 渲染 → 消息管理 → WebSocket 管理 → 设置管理 → 图片管理 → 事件绑定 → 初始化。

## 移动端键盘

布局高度只跟随浏览器给出的可见区域，不估算键盘高度：

- `js/app.js` 的 `initMobileSupport()` 把 `visualViewport.height` 写进 `--app-height`；iOS 上视觉视口下移时，用 `offsetTop` 补到 `body` 的 `padding-top`
- `index.html` 必须保留 `interactive-widget=resizes-content`。不要改成 `overlays-content`——它会让视口永不变化，只剩 `focus` / `blur` 可猜，而 Android 返回键收键盘通常不失焦
- 判断条件用 `(pointer: coarse)`，横屏和平板同样生效；捏合缩放（`scale !== 1`）时跳过更新

## 发版注意

改了 `js/app.js` 或 `css/main.css` 之后，**必须同步做三件事**，否则用户浏览器会一直跑旧代码：

1. `index.html` 里的版本号：

   ```html
   <link rel="stylesheet" href="css/main.css?v=YYYYMMDD">
   <script src="js/app.js?v=YYYYMMDD"></script>
   ```

2. `sw.js` 的缓存名递增：`sfchat-v17` → `sfchat-v18`

3. `sw.js` 的 `urlsToCache` 里同步同样的版本号

缓存策略是 `network-first`（联网时优先拿新内容，断网才用缓存），配合 `skipWaiting` + `clients.claim`。Service Worker 更新后，`index.html` 里的内联脚本会在 `controllerchange` 时自动刷新一次页面，不需要用户手动清缓存。

> 第一次升级到带自动刷新的版本时，老用户可能仍需手动刷新一次 —— 因为那一次页面上跑的还是没有这段逻辑的旧代码。

## 浏览器要求

现代浏览器：Chrome / Edge 88+、Safari 15+、Firefox 90+。

聊天历史完全由服务端提供，隐私模式或禁用存储不会影响消息记录；唯一受影响的是设置面板的连接参数不再跨会话保留。
