<!-- 感谢贡献！照着填完这几项，评审会快很多。 -->

## 改的是哪半边

这个插件是「两半」架构，先勾清楚改动范围（可多选）：

- [ ] **宿主半边** `index.js` —— Node 侧：路由 / 配置清洗 / 文件读写
- [ ] **客户端半边** `client.js` —— 浏览器侧：面板 UI（hyperscript，非 React）
- [ ] 两者都改了
- [ ] 其他（文档 / CI / 模板等，不涉及运行时）

> 宿主 `index.js` 只在 DSH 启动时加载一次；客户端 bundle 带指纹。**改完必须重启 DSH 才生效**。

---

## 三套测试跑过了吗

在仓库根目录执行（零依赖，不需要 `npm install`）：

```bash
node tests/test-host.mjs
node tests/test-client-contract.mjs
node tests/test-render.mjs
```

- [ ] `test-host.mjs`（宿主路由）—— 期望 `通过 29 项，失败 0 项`
- [ ] `test-client-contract.mjs`（产物契约）—— 期望 `通过 6 项，失败 0 项`
- [ ] `test-render.mjs`（渲染台）—— 期望 `通过 50 项，失败 0 项`

**结果**（把各自结尾那行 `结果：通过 N 项，失败 M 项` 原样贴进来）：

```
test-host.mjs            →
test-client-contract.mjs →
test-render.mjs          →
```

> 改了 `client.js` 的 UI 就**必须**跑渲染台 —— 它是唯一能抓到跨作用域 `ReferenceError`、
> 渲染期同步异常和事件回调崩溃的一套（`node --check` 与契约测试都抓不到）。

---

## 重启验证

- [ ] 已重启 DSH，并在界面上**人工确认改动生效**（不是「看起来没问题」）
- [ ] 改动涉及配置字段 → 已在宿主 `cleanConfig()` 里登记（**漏了会被静默丢弃**）
- [ ] 没有把临时脚本 / 备份目录（`tmp-*` / `backup-*`）/ 调试用 `console.log` 带进来

---

## 截图 / 录屏（视觉改动请务必附上）

改了面板外观、背景层、主题色、层级或布局的，**前后对比截图**放这里；只改逻辑的写「无视觉改动」即可。

<!-- 拖拽图片到此处，或粘贴 Markdown 图片链接 -->

---

## 提交信息

- [ ] 用了 [Conventional Commits](https://www.conventionalcommits.org/)：`feat:` / `fix:` / `docs:` / `chore:`

## 补充说明（可选）

<!-- 关联的 Issue、设计取舍、已知局限、后续计划等 -->
