# 参与贡献 · Contributing

欢迎来玩。这个文件写清「改哪里、怎么验、怎么提」，照着走就行。

Welcome! This guide tells you where to change things, how to verify, and how to submit.

---

## 一、先搞懂「两半」架构

这个插件是**两半**组成的，改之前先确认你要改的是哪一半 —— 改错了地方，改了也没反应。

| 半边 | 文件 | 跑在哪 | 干什么 |
| --- | --- | --- | --- |
| **宿主半边** | `index.js` | Node（DSH 主进程） | 注册 `/dsh-bg-panel/*` 路由、读写 `~/.dsh/bg-panel/` 数据目录、清洗配置、信任栅栏（跨站/Host/Origin 校验）、Range 取文件 |
| **客户端半边** | `client.js` | 浏览器（DSH Web 界面） | 侧栏入口 + 面板 UI，**手写 hyperscript**（`h(...)`），**不是 React 组件**；只有 `react` 一个外部依赖 |

> The host half (`index.js`) is Node-side; the client half (`client.js`) is browser-side and written in plain hyperscript — **not** React components.

两半之间的唯一通道是 HTTP 路由（`/dsh-bg-panel/*`）。客户端不直接碰文件系统。

---

## 二、改完必须重启 DSH，否则不生效

**这是最容易白干半天的地方。**

- 宿主 `index.js` **只在 DSH 启动时加载一次** —— 改完不重启，路由还是旧的（新加的路由 404，改过的逻辑不生效）。
- 客户端 `client.js` 的 bundle 带**指纹**（hash），DSH 按指纹缓存 —— 改完不重启（或不清缓存），浏览器拿到的还是旧 bundle。

所以：**改完 → 重启 DSH → 再刷新页面**。别对着没生效的旧代码调半天。

> Restart DSH after every change to `index.js` or `client.js`. The host is loaded once at startup, and the client bundle is fingerprinted.

---

## 三、三套测试怎么跑

零依赖，不需要 `npm install`。**在仓库根目录**执行：

```bash
node tests/test-host.mjs            # 宿主路由，期望：通过 29 项，失败 0 项
node tests/test-client-contract.mjs # 客户端产物契约，期望：通过 6 项，失败 0 项
node tests/test-render.mjs          # 渲染台，期望：通过 50 项，失败 0 项
```

三套都靠自己打印的 `结果：通过 N 项，失败 M 项` 收尾，失败时退出码为 1，所以能直接接进 CI（见 `.github/workflows/test.yml`）。

| 测试 | 测什么 | 什么时候必须跑 |
| --- | --- | --- |
| `test-host.mjs` | 把 `apply()` 注册的 5 条路由挂到真 http 服务器上跑：上传、列清单、取文件（含 Range）、保存配置（字段白名单 + 数值夹取）、删除、信任栅栏、路径穿越 | 动了 `index.js` 就必跑 |
| `test-client-contract.mjs` | vm 加载 `client.js`，抓 `window.__ModuleLoader__.load` 的 factory，验接口形状（id / react 依赖 / inject slots / apply） | 动了 `client.js` 就必跑 |
| `test-render.mjs`（渲染台） | vm 加载 + **迷你 React 真渲染** `BgMain` / `SidebarEntry`，递归把所有 `on*` 回调真调一遍，覆盖多种配置 / 主题 / 历史状态 | 动了 `client.js` 的 UI 就**必须**跑 |

渲染台能抓到 `node --check` 和契约测试**都抓不到**的崩溃：跨作用域 `ReferenceError`、渲染期同步异常、事件回调里的崩溃、`applyLayer()` 崩溃。真实事故：几行 `const vDis = ...` 被误放进模块级 `applyLayer()`，而 JSX 在组件里 `...vDis` —— 一渲染就 `ReferenceError: vDis is not defined`，面板整个点不开，而「语法检查 + 契约测试」全绿。

> Run all three before opening a PR. `test-render.mjs` is the one that catches cross-scope ReferenceErrors and render-time crashes that `node --check` cannot see.

---

## 四、提 PR 的自查清单

- [ ] 三套测试**全绿**（把三行 `结果：通过 N 项，失败 M 项` 贴进 PR 描述）
- [ ] 改了 `client.js` → 渲染台 `test-render.mjs` 跑过（不是「看起来没问题」，是真跑过）
- [ ] 重启 DSH 后**人工验证**过改动生效（视觉改动请附截图）
- [ ] 提交信息用 [Conventional Commits](https://www.conventionalcommits.org/)：`feat:` 新功能 / `fix:` 修 bug / `docs:` 文档 / `chore:` 杂务（构建、CI、依赖）
- [ ] 没有把临时脚本、备份目录（`tmp-*` / `backup-*`）、调试用的 `console.log` 带进来
- [ ] 新增配置字段已在宿主 `cleanConfig` 里登记（见下节 —— 这是踩过的坑）

---

## 五、数据目录与配置字段白名单

- **数据目录**：默认 `~/.dsh/bg-panel/`（可用配置项 `dir` 覆盖）。
  - `history/` —— 导入的图片 / GIF / 视频原件
  - `config.json` —— 当前配置
- **配置字段白名单在宿主的 `cleanConfig()` 函数里**（`index.js`）。

> **新增配置字段必须同时在 `cleanConfig()` 里登记，否则会被静默丢弃。**

宿主保存配置时**不是**直接落盘，而是先过一遍 `cleanConfig()`：它从 `DEFAULT_CONFIG` 起手，逐个字段做类型检查与范围夹取，**没登记过的字段一律丢掉**。所以「客户端明明传了 `xxx`，读回来却没有」的经典坑，八成就是忘了在 `cleanConfig` 里加分支。历史上 `transparentPanels` 就这样死过一次 —— `DEFAULT_CONFIG` 里一直有它，但从来没有清洗分支，于是这个字段永远写不出 `true`。

配套改法：字段要**三处对齐** ——
1. 宿主 `DEFAULT_CONFIG`（默认值）
2. 宿主 `cleanConfig()`（类型 + 范围清洗）← 漏了这步字段就是死的
3. 客户端读写处（UI 与请求体）

---

## 六、三条踩坑提醒（都是真摔过的）

### ① 跨作用域引用变量前，先确认定义位置

JSX 里用了某个 `const`，就要确认它在**同一个作用域**里定义 —— `node --check` 只查语法，**查不出 `ReferenceError`**；`test-client-contract.mjs` 也不渲染，同样查不出。**只有渲染台 `test-render.mjs` 会当场炸给你看**。

真实事故：`const vDis = ...` 被误放进模块级的 `applyLayer()`，而 JSX 在 `BgMain` 组件里 `...vDis` → 一打开面板就 `ReferenceError: vDis is not defined`，面板白屏，而假阴性套餐全绿。

习惯：挪动代码块之后，搜一遍这些变量名在哪些作用域里被用到。

### ② 删 JSX 片段时，先补结构字符（逗号 / 括号）

删掉 JSX 里的一个属性、一个数组项或一个 `h(...)` 子节点后，**前后留下的逗号、括号、圆括号往往就不配对了**。这类错误语法检查能抓到，但如果在压缩过的长行里删，肉眼很难看出来。

习惯：删完立刻 `node --check client.js`（或跑渲染台）；删数组项时特别留意上一项结尾的逗号与整段的闭合括号。

### ③ 不要按应用内部的哈希类名做适配

DSH 升级后**类名哈希会变，按类名写的选择器/适配立刻失效**。别写 `div.css-1x2y3z` 这种。

优先找**语义属性**：`data-*`（例如 `data-dsh-bg-panel`）、`id`、`role`、`aria-*`、稳定的结构层级。**这是长期可维护性的关键**：上游换样式，我们不掉。

> Never target hashed class names (e.g. `css-1x2y3z`) — they change on every DSH upgrade. Prefer semantic `data-*` attributes.

---

## 七、提交与 PR

1. Fork / 建分支：`git checkout -b fix/some-bug`
2. 改完跑齐三套测试
3. 提交：`git commit -m "fix: 修正 xxx"`
4. 推送并开 PR，按 `.github/pull_request_template.md` 填表

提 Issue 请用 `.github/ISSUE_TEMPLATE/bug_report.yml`，**控制台报错请贴原文**（别只写「报错了」），并注明是否已重启 DSH。

---

MIT 许可，见 [LICENSE](LICENSE)。
