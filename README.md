# dsh-bg-panel


## 在 DSH 社区找到它

| 渠道 | 关键词 / 地址 |
| --- | --- |
| GitHub | [theroi/dsh-bg-panel](https://github.com/theroi/dsh-bg-panel) |
| 插件名 | `dsh-bg-panel` |
| 社区检索关键词 | `dsh-plugin` · `dsh-community` · `个性化` · `背景` · `主题` |

> 侧栏入口名：**个性化**（面板标题：自定义背景）。

---

DSH（DeepSeek Harness）个性化插件：**自定义背景 + 半透明玻璃 + 主题色**。

## 安装

从本地目录安装（开发/自用）：

```bash
dsh plugin --profile desktop add link:/path/to/dsh-bg-panel
```

从 GitHub 安装：

```bash
dsh plugin --profile desktop add github:theroi/dsh-bg-panel
```

安装后**重启 DSH**，侧栏出现「个性化」入口。

---
# dsh-bg-panel · 背景自定义面板

给 DSH Web 界面换背景的插件。**入口在侧边栏列表里的「背景」一项**，点开就是完整面板。

## 面板里能做什么

| 区域 | 能力 |
|---|---|
| 当前背景 | **分层预览**（0.4.0）：底层整图按 contain 完整显示 → 亮框标出「屏幕上实际能看到的部分」→ 框外压暗提示会被裁掉；**框内直接拖动**改位置，节流写回配置，真实背景同步跟手。框按屏幕比例、宽度收窄居中（≤340px） |
| 导入 | 点击或拖拽，图片 / GIF / 视频都收；导入后**先出待应用预览**（同样是分层视图，所以裁剪后的窄条也看得全），确认无误再点「应用为背景」 |
| 裁剪 | 图片可点「裁剪 / 拖动位置」进裁剪器：选比例（16:9 / 21:9 / 4:3 / 3:2 / 1:1 / 原图比例）、**拖动图片选位**、滚轮或滑杆缩放 1–4×；确认后裁出的新图**存进历史**并成为待应用项 |
| 历史背景 | 网格图库，缩略图按原比例完整显示 + 视频角标；点一下选中预览，右上角 × 删除 |
| 参数 | 铺满方式（cover / contain / repeat）、**缩放 1–4×**、暗化 0–80%、模糊 0–20px、面板半透明（实验性） |
| 其他 | 「清除背景」还原皮肤原背景；「刷新」重新拉列表 |

**所见即所得怎么保证的**：预览框与背景层调用同一个 `visibleRect(iw, ih, vw, vh, cfg)` ——
先按 cover 求出缩放 `s = max(vw/iw, vh/ih) × zoom`，得到可见源矩形 `sw = vw/s, sh = vh/s`，
位置 `sx = posX·(iw−sw), sy = posY·(ih−sh)`；背景层把图按 `s` 缩放后按 `−sx·s, −sy·s` 绝对定位，
预览框则把同一矩形画在 contain 底图上。同一套数，预览不会骗人。视口尺寸变化会重排背景层。

裁剪是**客户端 canvas** 完成的：源矩形 = 框内可见区域换算回图像坐标，导出 PNG 再走 `/upload` 存进历史，
所以在原图上裁、不损失别的区域；裁剪 GIF 只保留当前一帧（面板里有提示）。

**GIF 与视频**：图片和 GIF 走 `background-image`（GIF 会动），视频走 `<video autoplay muted loop playsinline>`，
都放在 `#root` 之下、最底层；视频拖动进度依赖宿主路由的 Range 支持（已实现并测过）。

## 数据放在哪

默认 `~/.dsh/bg-panel/`：

```
~/.dsh/bg-panel/
├─ config.json          当前背景与参数（跟着宿主走，换端口/换浏览器都不丢）
└─ history/             导入过的图片与视频，文件名前缀是时间戳，避免重名
```

目录可用 profile patch 里的 `config.dir` 改。单个文件上限 **64MB**。

## 宿主路由（都是 exact 路由，命名空间 `/dsh-bg-panel`）

| 路由 | 方法 | 作用 |
|---|---|---|
| `/dsh-bg-panel/list` | GET | 返回 `{ base, config, items }`（**不回显绝对路径 `dir`**，那条路由不受 GUI 鉴权保护） |
| `/dsh-bg-panel/file?name=` | GET | 取文件，**支持 Range**（206）与 `Accept-Ranges`；按回环 / `dsh-app://` Origin 回显放行 CORS |
| `/dsh-bg-panel/upload?name=` | POST | 原始字节写进 history/，扩展名走白名单 |
| `/dsh-bg-panel/delete?name=` | POST | 删除；删的正是当前背景时顺带清空 `active` |
| `/dsh-bg-panel/config` | POST | 保存配置，字段逐个清洗 |

**安全栅栏**：只认回环 Host；写操作还要求 `sec-fetch-site` 为同源、**Origin 与请求 Host 同端口**
（回环名 127.0.0.1 / localhost / ::1 之间可等价，端口必须一致）；
文件名走白名单正则 + 扩展名白名单，路径穿越会被拍平或拒绝。

## 实现要点

- 形态：`dsh.bundle.patch` 插一行宿主插件；`dsh.client` 声明浏览器半边。
- 面板槽位：`main`（面板主体）+ `sidebar.panellist`（列表入口），两者用同一个 key `bg-panel`——
  与 `dsh-context` 的面板做法一致。
- 背景层：往 `<body>` 头部插 `#dsh-bg-panel-layer`（`position:fixed; z-index:-2`），
  图片/GIF 一层 + 遮罩一层；再把 `#root` 抬到 `z-index:1`。
- 资源归属：层元素、样式节点、`body` 属性都在 `apply(ctx)` 的 `ctx.effect()` 里成对注册与撤销。
- 样式只用 `--dsw-alias-*` 主题 token，跟随明暗主题。

## 已知限制

- 面板文案写死中文，没走 Client 的 locale 服务（v1 取舍）。
- 「面板半透明」只改了几个 `--dsw-alias-bg-*` token，不是完整皮肤，个别区域仍可能不透明。
- 皮肤型插件必须操作组件之外的 DOM（背景本就在组件之外）；做法与现有皮肤一致，且全部可撤销。
- **视觉验证只能由人来做**：本机无浏览器控制权，命令行侧只验证语法、清单、宿主路由与安装结果。
- **GIF 帧率上限滑块暂未生效**：值能存进 `config.json`（`gifFps`），但当前用 CSS 背景图渲染，
  插件拿不到 GIF 的帧，限速要换成拆帧 + canvas 逐帧画才行；滑块已标注「暂未生效」。
- **路由目前没走宿主鉴权栅栏**：对照 `GET /dsh-whale/size.json` 返回 401，本插件 `GET /dsh-bg-panel/list` 返回 200。
  现有防线是「只认回环 Host + 写操作必须同源 + 文件名白名单」，能挡住 DNS 重绑定与跨站写，
  但本机进程可直接读写——风险与直接读该目录同级。要对齐平台做法，可在处理器里委托
  `ctx.get('connection').requestRejection(req)`（挂件就是这么做的），代价是需要人肉验一次浏览器路径。

## 验证记录（2026-10-15）

| 检查 | 方法 | 结果 |
|---|---|---|
| 语法 | `node --check`（index.js 按 ESM、client.js 按脚本） | 通过 |
| 清单与入口 | JSON 解析 + 以 profile 为 base 的 `createRequire` 解析三个入口 | 通过 |
| patch 结构 | DSH 自带 js-yaml 真解析 `cordis.patch.yml` | 通过 |
| 加载器组合 | 临时 profile（base + web-app + 本插件）`dsh --dump-config` | 组合树出现本插件行，exit 0 无报错 |
| 可回滚 | 同临时 profile 上 `dsh plugin ... remove` | 依赖与 bundles 条目一并清除 |
| **宿主路由** | `plugins/_check/test-host.mjs`：把注册的路由挂到真 http 服务器上跑 | **24/24 通过**（上传/清单/取文件/Range/配置清洗/删除/栅栏/穿越） |
| 浏览器产物契约 | `plugins/_check/test-client-contract.mjs`：vm 里抓 `__ModuleLoader__.load` 再调 factory | **6/6 通过**（id / factory / inject / apply / 不越权 require） |
| 界面视觉 | — | **未验证**，需人眼确认 |

## 修复记录

**0.5.0 —— 取景框固定 + 草稿模型 + 图标灰度态**
- **拖动方向反了**：以前是图不动、亮框在图上滑，读起来像"拖的是框"。现在反过来 ——
  **取景框（=屏幕）钉死在预览中间，图在框下平移**，鼠标往哪拖图就往哪走；框外压暗（可勾选完全隐藏）。
- **拖动会卡 + 直接改背景**：以前每动一下都 POST 配置并重建背景层。现在拖动只写**草稿**（组件内 state），
  不碰配置、不重建背景层，所以跟手；面板上重新出现 **「保存为背景」/「裁剪」/「还原」/「取消选择」**，
  满意了再点保存，支持二次三次调整。有未保存改动时按钮会写「（有改动）」。
- **图标两态**：选中＝彩色图标；未选中＝同一图标的**灰度版**（`filter:grayscale(1); opacity:.72`），
  悬停也去灰度。三种状态都不铺任何底色；宿主行底色仍由 `button[aria-label="背景"]` 强制透明
  （宿主 `.panelRow:hover` / `.panelActive` 的底色是它自己铺的）。
- 缩放滑杆并入草稿，不再一拖就写配置。

**0.4.0 —— 分层预览 + 位置/缩放 + 列表行不再铺底**
- 预览与背景层共用 `visibleRect()` 几何，预览里画「亮框 = 屏幕可见区」，框外压暗；框内拖动即改 `posX/posY`。
- 配置新增 `posX/posY/zoom`（宿主 `cleanConfig` 夹取：0–1 / 0–1 / 1–4，非数字回落默认）。
- 裁剪后的窄条以前在固定高度 `cover` 预览里被二次裁切，现在底层用 contain，整张都看得见。
- 侧边栏那一行的**底色是宿主铺的**（`panelRow:hover` 与 `panelActive` 都用 `--dsw-alias-interactive-bg-hover`）。
  宿主只给我们的组件传 `{ size, active }` 并自己渲染文字标签，所以行本身改不动；
  改用 `button[aria-label="背景"]` 这个由我们自己 `label()` 决定的稳定选择器覆盖掉底色，
  状态只由图标变色表达。**没有去碰宿主的哈希类名**（那些随构建变）。

**0.3.1 —— 「滑块拖不动、图片拖不动」的真凶是 URL 抖动**
`fileUrl()` 早先每次调用都拼 `&v=Date.now()`，于是每次渲染 `<img src>` 都是新地址 →
浏览器重新加载图片 → 触发 `onLoad` → `setNat(新对象)` → 依赖 `nat` 的「重新居中」effect 被触发 →
**缩放与位移被复位**。表现就是一动滑块或一拖图就弹回原位。修法三层：
① URL 按文件名缓存，只在文件真变了（上传/删除）时 `bustUrls()`；
② 居中 effect 的依赖改成数值（`nat.w`/`nat.h`），不再被对象同一性牵着走；
③ 拖动改为按下后在 `window` 捕获阶段监听 `pointermove`，宿主容器抢事件也不受影响。
顺带修掉同类隐患：预览与缩略图不再每次渲染都重新请求图片。

**0.3.1 —— 列表入口图标**
去掉图标里的文字，去掉悬停/选中底色（`background:transparent !important`），只让图标自身变色，字号 16 → 18。

## 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 导入报 **HTTP 405**（没有 JSON 说明） | 宿主进程还是旧代码，`/dsh-bg-panel/*` 路由没注册；DSH 的 SPA 兜底对未知 POST 路径回 405 | **重启 DSH**（宿主半边只有进程重启才换新代码） |
| 面板打开就报 404 | 同上，路由完全不存在 | 同上 |
| 面板列出了文件但预览空白 | 文件名被安全栅栏改名过，或文件已被手工删除 | 点「刷新」重新拉列表 |
| 视频不动 / 拖进度失败 | 浏览器策略要求静音才能自动播放（已 muted） | 检查文件是否 `.mp4/.webm`；Range 已在宿主实现 |

诊断方法（无鉴权的外部请求也能区分）：已注册的路由返回 **401**（要鉴权），
未注册的 GET 返回 **404**、未注册的 POST 返回 **405**。对照组：`GET /dsh-whale/size.json` → 401。

## 实战踩坑记录（2026-10-15，背景不显示的四层原因）

按发现顺序，每一层单独看都像别的原因，实际是叠加的：

| # | 现象 | 真因 | 修法 |
|---|---|---|---|
| 1 | 面板/背景整个失效，控制台满屏 404（`dsh-app://app/api/chr/<hash>?seq=…`） | **改了 `client.js` 没重启宿主**：浏览器按新指纹取客户端 bundle，宿主手里只有旧指纹 | 改客户端代码后**必须重启 DSH**（宿主只在启动时采集 bundle） |
| 2 | 图加载不出来，`net::ERR_FAILED` | 页面跑在 `dsh-app://` 自定义协议下，**不能直接引用 `http://` 子资源**（`background-image` / `<img src>`） | 媒体一律 **fetch → blob → objectURL**（视频同样适用，blob 支持 seek） |
| 3 | 换绝对地址后仍失败 | **跨源 fetch 缺 CORS 头** | 宿主 `/file` 按 Origin 回显放行（只认回环与 `dsh-app://`，含 Range 的 206）；**不要用 `*`** |
| 4 | 图能加载、DOM 也对，就是看不见 | 应用外壳 `DIV.*_frame` 铺 `rgb(27,27,27)` 实底，盖住 `z-index:-2` 的背景层 | 作用域内定向清底：`[class*="_frame"]` / `[class*="_shell"]` + `#root` 及其直接子层 |

**定位手法**（比反复改代码快得多）：控制台里 `document.elementFromPoint(x, y)` 取样，
再沿 `parentElement` 逐级打印 `getComputedStyle(e).backgroundColor`，
第一个非 `rgba(0, 0, 0, 0)` 的祖先就是压着背景的元素——拿到 class 再定向清底。

**教训**：用脚本改源码时，每一步之后都要 `node --check`。曾经因为多打一个 `)` 把产物改坏，
当场被发现才没进到宿主里。


## 贡献者

- [@theroi](https://github.com/theroi) — 作者
- [@LANXI716](https://github.com/LANXI716)（蓝鲸）— 视频控制（循环 / 静音 / 播放速度）、GIF 帧率上限项、面板底色与深色模式文字

欢迎 PR 与想法：有想改的地方直接开 Issue 或 Discussion 就行。

---

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-bg-panel
```

卸载后数据目录 `~/.dsh/bg-panel/` 会留着（含已导入的文件），要清就手动删。
