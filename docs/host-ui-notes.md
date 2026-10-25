# 宿主 UI 勘察（Step 0-2）

> 结论文档：`dsh-happycode` 的客户端注入点、可复用 UI 原语、样式 token 与实装方式。
> 勘察对象：DSH Desktop `0.2.1-rc.2` 的 `app.asar`（已解包到 `_recon/asar`）与已安装的
> `dshmarket@1.66.47` 源码（`~/.dsh/profiles/desktop/node_modules/dshmarket`）。

---

## 1. 一个插件包长什么样

参照 dshmarket（同为第三方 cordis 插件），服务端 + 客户端两半在同一个包内：

```jsonc
// package.json
{ "name": "dsh-happycode", "type": "module", "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./client/client.js",
               "./cordis.patch.yml": "./cordis.patch.yml", "./package.json": "./package.json" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },          // 服务端 Loader 行来源
    "client": { "platform": "web",
                "inject": ["@deepseek-ai/dsh-client-ui-theme"] } // 客户端依赖行（保证服务先就绪）
  },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.1" } }
```

```yaml
# cordis.patch.yml —— 插进 profile 的 layer 栈
- insert:
    - id: dsh-happycode
      name: 'dsh-happycode'
```

装载链路（`dsh-client-modules`）：

1. 宿主扫描 **已启用** Loader 行里带 `dsh.client` 的包，把 `<包名>/client` 编成一条浏览器 module 行；
2. bundle 由 Web 端 `GET /plugins/<包名>/client.js` 送出；
3. bundle 只需 `window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => {…} })`，
   工厂内 `require('react')` / `require('@deepseek-ai/dsh-client-ui-primitives')` 从**共享 module table** 解析；
4. 工厂返回 `{ name, inject, apply(ctx) }` —— cordis 客户端插件契约，`apply` 里拿到 `ctx.slots / ctx.theme / ctx.locale`。

**结论**：客户端 bundle 可以手写（无构建步骤），只要遵守上面的 `__ModuleLoader__` CJS 包装。
本插件因此**零构建、零依赖**：`client/client.js` 是手写产物，`lib/*.js` 是普通 ESM。

共享 module table 的可用 externals（`window.__DSH_BOOT__` 的 `PLATFORM_MODULES`）：

```
react, react/jsx-runtime, react-dom, react-dom/client,
@deepseek-ai/cordis, zod, @tanstack/react-virtual,
@deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-slots,
@deepseek-ai/dsh-client-ui-primitives, @deepseek-ai/dsh-client-ui-dockkit
```

> 只要 `react` + `@deepseek-ai/dsh-client-ui-primitives` 两项就能做完整 UI。

---

## 2. 账号菜单：实现与注入点（**关键结论：没有 slot，必须 DOM 注入**）

### 2.1 宿主实现

账号菜单在 `@deepseek-ai/dsh-client-ui-settings-account` 的 `AccountMenu` 组件里，
菜单项是**硬编码数组**（`lib/client.js` L1871–1893）：

```js
items: [
  { id: 'settings', label: t('settings'),  icon: <IconSettingsOutlineMedium size={16}/>, shortcut },
  { id: 'contact',  label: t('contactUs'), icon: <IconPaperPlaneOutlineMedium size={16}/> },
  ...signedIn ? [{ id: 'signout', … }] : [{ id: 'signin', … }],
]
```

整棵树由一个 `settings.launcher` slot 贡献渲染（`ctx.slots.register({name:'settings.launcher'}, …)`），
**slot 的粒度是整个启动器，不是菜单行**——第三方拿不到「往 items 里塞一行」的入口。

全量 slot 目录（54 个，从 302 个客户端包里扫出）里与账号/菜单相关的只有：

```
settings.launcher      # 整个左下角启动器（含头像 + 弹出菜单）
settings.section       # 设置弹窗里的分区
settings.header/action/close
settings.plugins.tab   # 插件分区的标签页
plugins.bundle.config  # 组合包自己的配置页（按包名键控）
sidebar.* , shell.overlay , main , …
```

→ **确认没有 account-menu item 级别的 slot**。规格书 §10 已给出兜底方案，按此实施。

### 2.2 注入方案：克隆宿主行 + MutationObserver

`Menu` 原语（`@deepseek-ai/dsh-client-ui-primitives`）渲染出的 DOM（portaled 到 `<body>`）：

```html
<div role="menu" class="…_list_4ub78_7 …">
  <div class="…_viewport_4ub78_19" role="presentation">
    <div class="…_itemWrap_4ub78_90">
      <button type="button" role="menuitem" class="…_item_4ub78_90">
        <span class="…_itemIcon_4ub78_148"> <svg…/> </span>
        <span class="…_itemLabel_4ub78_190">Settings</span>
        <span aria-hidden="true" class="…_shortcut_…"> <kbd…/> </span>
      </button>
    </div>
    … 其余菜单行 …
  </div>
</div>
```

注入步骤：

1. `MutationObserver(document.body, {childList:true, subtree:true})`；
2. 出现 `[role="menu"]` 且其内至少有 2 个 `button[role="menuitem"]` 时，判定为账号菜单
   （宿主另有右键菜单/下拉菜单，用「第一项文本 = 本地化的 Settings」不可靠 —— 改用
   「`[role=menu] button[role=menuitem]` 的顺序结构 + 已被观察到的启动器锚点」两层判定，
   实现里再叠加一个稳定特征：菜单项里的 `.itemIcon > svg` 与第三项存在。稳妥起见，
   本插件只认「宿主 `Menu` 的 list 类名含 `_list_` 且含 `data-menu-material` 的父级」，
   并在插入前二次校验第一项是 settings 行）。
3. 取第一个 `button[role="menuitem"]` 的父节点 `div`（即 `itemWrap`）作为模板 `cloneNode(true)`；
4. 清掉克隆里的 shortcut/icon 子节点，写入 `HappyCode` 文本 + 自绘 16px 线性图标，打标记
   `data-happycode-entry`，`insertBefore(clone, firstItemWrap.nextSibling)` → **正好落在 Settings 与
   Feedback 之间**；
5. 点击：给克隆的 `<button>` 挂 `click` 监听（capture 阶段），`stopPropagation` 后打开自己的弹窗；
   宿主的 list 上也挂了 click 关闭逻辑，因此**必须阻止冒泡**，否则菜单关闭与弹窗打开会撞车；
6. 菜单卸载（`[role=menu]` 从 DOM 消失）→ 断开观察、清状态；
7. 每次 React 重渲染若把注入节点冲掉，观察器下一拍补回（幂等：先查 `data-happycode-entry`）。

**为什么这样够用**：宿主 `Menu` 的键盘导航是**查 DOM** 实现的 ——
`list.querySelectorAll('button:not(:disabled)')` 后按 `ArrowUp/Down/Home/End` 移动焦点，
所以注入的 `<button>` 自动参与上下键；`Tab` 也走 `querySelector('button:not(:disabled)')`。
样式因为整行是宿主节点的克隆，**类名、字体、行高、hover 态天然完全一致**（FR-1）。
焦点环、`user-select`、禁用态同理。

风险与兜底：
- 宿主改版把菜单改成 slot 化 → 注入器找不到模板时**静默降级**（不插行、不抛错），
  并在 console 打一条 `[dsh-happycode] account menu not recognised; entry hidden`。
- 将来若出现官方 account-menu slot，切换成 slot 注册即可（见 §8 的 `MENU_INJECTOR` 抽象）。

### 2.3 账号头像与用户名：有没有现成接口（v5 Step 2 勘察）

翻了 `@deepseek-ai/dsh-client-ui-settings-account` 的 `lib/client.js`（3.4 MB，4800 行）与
`dsh-client-ui-settings-account`/`ui-settings` 的 README，结论是**拿不到服务**：

| 途径 | 结论 |
|---|---|
| 客户端服务（`ctx.provide` / `ctx.get`） | ❌ 该包只做 `ctx.slots.inject(...)`，没有任何 `provide`；账号快照是插件内部的 `operations.hooks.account` store |
| slot props | ❌ 只有 `settings.launcher` / `settings.section` 的**注册者**能拿到 `inject: () => operations`，我们是往菜单里塞 DOM，不在这些 slot 里 |
| 模块表（`PLATFORM_MODULES`） | ❌ 只有 react / cordis / 几个 kernel 包，没有账号包 |
| 宿主 HTTP API | ⚠️ `/api/*` 需要宿主自己的登录态与私有命名空间，跨插件调用等于自造协议；不采用 |
| **已渲染的 DOM** | ✅ 可行，见下 |

### 2.4 DOM 取法与三条硬约束

账号启动器（左下角）的 DOM：

```html
<button data-signed-out="false" aria-haspopup="menu" aria-expanded="true" aria-label="Account menu">
  <span class="…_avatar" data-avatar-status="ready">
    <img class="…_image" src="<头像 URL>" alt="" referrerpolicy="no-referrer">   <!-- 无头像时是 IconUserOutlineMedium -->
  </span>
  <span class="…_label">七喜</span>        <!-- 侧栏收窄（wide=false）时整段不渲染 -->
</button>
```

取数规则（`readAccountIdentity()`）：

1. **只认启动器按钮**：`button[data-signed-out]` 是宿主自己打的标记，恰好唯一。
2. **登出即无身份**：`data-signed-out="true"` 时直接返回 `null`（此时按钮里是省略号图标和不相关的文案）。
3. **用户名 = 按钮里最后一个有文字的 `<span>`**（不含 `<img>` 的那个）。
   宿主自己的回退是 `profile.name ?? profile.contact`，而 `contact` 是**脱敏邮箱/手机号**——
   所以读到的文本只要含 `@` 就当作「没有名字」，**绝不把邮箱放进界面**（D13/D16）。
4. **头像只镜像「宿主已经加载好」的那张图**：`img.complete && img.naturalWidth > 0` 才复用它的
   `currentSrc`。这样不会替用户发起任何新请求——图不在浏览器缓存里就退回首字母占位，
   天然满足「零网络请求」。
5. **缓存最近一次成功结果**：侧栏收窄时 label 不渲染，但用户此前展开过、菜单刚打开过，
   缓存能让资料行不闪没。登出会显式清空（返回 `null`，不落缓存）。

判定矩阵（对应 FR-14）：

| 头像 | 用户名 | 结果 |
|---|---|---|
| ✅ | ✅ | 圆形头像 + 名字 + Coding since |
| ❌ | ✅ | 首字母圆形（主题色底白字）+ 名字 + Coding since |
| ✅ | ❌ | 头像 + 仅 Coding since |
| ❌ | ❌ | **整行隐藏**（不留空壳） |

> 侧栏收窄 + 从未展开过 → 用户名读不到、头像通常也没有 → 整行隐藏，符合 FR-14 的回退规则。

---

## 3. 设置弹窗：结构、CSS 与关闭行为（照抄目标）

宿主「设置」弹窗**不是** `Modal` 原语，而是 `@deepseek-ai/dsh-client-ui-settings-general`
里的 `SettingsPanel`（`lib/client.js` L275–342）：

```jsx
createPortal(
  <div className={overlay}>                       // position:fixed; inset:0; z-index:1000; flex center
    <div className={mask} onClick={onClose} />     // 绝对定位铺满 + backdrop-filter + bg-mask-1
    <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <nav className={nav}> … </nav>               // 左侧分区导航 188px
      <div className={content}>
        <div className={header}>
          <div className={actions}>{renderSlot('settings.action')}</div>
          <button className={close} onClick={onClose}><IconCloseOutlineRegular size={14}/></button>
        </div>
        <div className={options}>{renderSlot('settings.section')}</div>
      </div>
    </div>
  </div>, document.body)
```

`useModalLayer(panel, open, onClose)` 来自 primitives：**Esc 关闭 + 焦点陷阱 + 关闭后焦点归还**。

逐条抄下来的 CSS（`SettingsRoot.module.css`，类是 CSS Module 哈希，这里用可读名）：

```css
.overlay { position:fixed; inset:0; z-index:1000; display:flex; align-items:center; justify-content:center; }
.mask    { position:absolute; inset:var(--dsh-frame-chrome-top,0px) 0 0;
           background:var(--dsw-alias-bg-mask-1); backdrop-filter:var(--dsw-mask-blur); }
.panel   { position:relative; z-index:1; width:800px; height:min(800px, calc(100vh - 2*max(24px, var(--dsh-frame-overlay-top,24px))));
           max-width:calc(100vw - 48px); border-radius:var(--dsw-radius-panel);
           background:var(--dsw-alias-bg-layer-2); box-shadow:var(--dsw-elevation-prominent);
           display:flex; overflow:hidden; }
.header  { height:54px; padding:20px 14px 8px 10px; display:flex; justify-content:space-between; align-items:flex-start; }
.close   { width:28px; height:28px; border:0; border-radius:var(--dsw-radius-sm); background:transparent; color:var(--dsw-alias-label-primary); }
.close:hover { background:var(--dsw-alias-interactive-bg-hover); }
.options { flex:1; min-height:0; padding:0 24px 24px; overflow-y:auto; }
```

**本插件弹窗**（v6 §9.1：设计宽 1500、上限 94vw / 88vh、**高度随内容**、内部滚动、始终居中）：

- 复用同一套 `.overlay / .mask / .panel` 材质与 token；
- `.panel` 覆盖为
  `width:min(1500px,94vw); min-width:min(1500px,94vw); max-height:88vh`——**没有 `min-height`**。
  `min-width` 用 `min()` 而不是写死 1500：窗口窄于 1500 时弹窗自动退到 94vw，
  由格子缩小来吸收，而不是让弹窗溢出屏幕；
- 居中：`overlay` 的 `display:flex` + 面板 `margin:auto`，**窗口缩放天然重新居中**，不需要监听 `resize`；
- **标题带**（v6 R13）：`.hc-header` 高 90px、`justify-content:center`，品牌名
  `clamp(24px,2vw,30px)` / 600 / `text-align:center` / `white-space:nowrap`；
  关闭按钮改成 `position:absolute; right:16px; top:50%`，**脱离文档流**，
  这样标题的居中不会被它挤偏（flex 三列那种做法在标题变宽时会偏）；
  右侧 `padding-right:56px` 只是给窄窗口留出避让空间；
- 关闭：右上按钮、Esc（`useModalLayer`）、点遮罩（mask 的 onClick）——与宿主设置弹窗同三条路径。

**高度自适应**（v5 R9）：`.hc-body` 是 `display:flex; flex-direction:column; overflow:auto`，
里面只有 `.hc-content`（`width:100%`）。面板高度 = 标题带 + 内容块 + 内边距（底 24px），
内容多少就多高；只有超过 `max-height:88vh` 时才在 `.hc-body` 里滚动。

**垂直节奏**（v6 R15）：`.hc-content` **不用 `gap`**，由各块自己的 `margin-top` 决定间距——
资料行 40px、总数标题 36px、卡片行 20px、底部内边距 24px。用 margin 而不是 gap，
是因为资料行可能整个不渲染（账号信息不可得），那时 `gap` 会留下两个空档，margin 不会。

**个人资料行**（v6 R14）：`.hc-profile` = 120px 圆角（24px）头像 + 24px 间距 + 文字列，
`align-items:flex-end` 让文字列的**底部与头像底部**对齐；文字列内是名字 24px/600 与
`Coding since …` 16px 次级色。头像与名字怎么来，见 §2.3–2.4；两者都拿不到时组件返回 `null`，
整行不渲染（margin 也随之消失，不会留下 40px 空洞）。

**图区自适应**（v4 R7）：卡片用 `ResizeObserver`（无则退回 `window.resize`）测宽，格子边长按

```
cell = (卡片宽度 − 40px 星期标签列 − 10px 图间距) / 53 − 间隙
```

在 21px 封顶、14px 兜底之间取「能放下的最大值」（先试 gap 3，再试 gap 2）。
卡片宽度已经排除了右侧年份选择器，所以这个式子等价于规格里的
`(内容宽度 − 标签列 − 年份列) / 53 − 间隙`，只是把年份列交给布局去量而不是写死。
1500px 设计宽度落在 21px（53×21 + 52×3 = 1269 ≤ 1290）；1100px 的卡片落在 17px；
再窄就一路降到 14px，低于 14px 时卡片横向滚动。
实测宽高通过 CSS 变量 `--hc-cell` / `--hc-gap` 下发，图例与格子共用同一组变量。

**标签字号**（v4 R8）：`.hc-weekday` 与 `.hc-month` 都是 18px（星期列因此加宽到 40px、
月份行加高到 22px、星期列 `padding-top:24px` 与格子顶对齐）；`.hc-legend` 仍是 12px、
`.hc-summary` 仍是 19px —— 这两处按规格保持不变。

> 为什么不用 primitives 的 `Modal`：`Modal` 是通用小弹窗（默认 380px、`padding:0 0 24px`、
> header 自带 `h2`），而宿主「设置」用的是上面这套面板。目标是与设置同款，故选后者，
> 并在 `useModalLayer` 缺失时降级为自实现的 Esc 监听（见 §5）。

---

## 4. `@deepseek-ai/dsh-client-ui-primitives` 可用面板

从 dshmarket 的实际使用反推（bundle 里出现的导出）：

| 导出 | 用途 |
|---|---|
| `Button` | `variant: 'outline' \| 'primary' …`, `size: 'sm' …` |
| `Input` | 文本/数字输入 |
| `Modal` | 通用模态：`{open,onClose,title,closeLabel,description,children,footer,className,headless}` |
| `Menu` | 菜单（`items` + `children` 追加在 items 之后） |
| `Toast`, `Tooltip`, `Pill`, `StateDot`, `DisclosureRow` | 反馈/状态/折叠 |
| `useModalLayer(panelRef, open, onClose)` | Esc + 焦点陷阱（宿主设置弹窗用它） |
| `IconSettingsOutlineMedium`, `IconPaperPlaneOutlineMedium`, `IconUserOutlineMedium`, `IconCloseOutlineRegular`, `IconEllipsisOutlineMedium`, `IconDataOutlineMedium`, `IconArchiveOutlineMedium`, `IconPersonalizationOutlineMedium` | 16px/14px 图标 |

图标命名在 0.1.7 从「尺寸后缀」改成「字重后缀」，两套都在 `ICON_ALIASES` 里兼容；
本插件只硬用 `IconCloseOutlineRegular`（宿主设置弹窗自己用的那个），并对缺失做降级（画一个 ✕ 的 SVG）。

**不依赖**：`ctx.locale`（界面纯英文，不走宿主字典）、`settingsScope`、`configForms`。

---

## 5. 服务与订阅

| 服务 / API | 用法 | 缺失时 |
|---|---|---|
| `ctx.slots.inject(name, cb)` / `ctx.slots.register(meta, render)` | 注册插件配置页（`plugins.bundle.config`） | 不注册，其余功能不受影响 |
| `ctx.theme.getTheme()` → `{preference, themes:[{id, colorScheme, tokens}]}` | 判断深/浅色 | 回退读 `document.body` 背景亮度 → `matchMedia('(prefers-color-scheme: dark)')` |
| `ctx.on('theme/change', cb)` → 取消订阅函数 | 主题切换即时重绘 | 回退轮询 `matchMedia` 的 `change` 事件 |
| `useModalLayer` | Esc + 焦点陷阱 | 自实现 `document.addEventListener('keydown')` |
| `ctx.effect(fn, label)` | 注册可回收副作用（客户端也支持） | — |

`export const inject = ['slots', 'theme']`，与 dshmarket 的 `['slots','locale','theme']` 同构，
少一个 `locale` 因为本插件不读宿主字典。

---

## 6. 设计 token（从 `index-BxpfOGf3.css` 提取，可直接用）

```
--dsw-alias-bg-base / -layer-1 / -layer-2 / -layer-3 / -layer-4
--dsw-alias-bg-mask-1            --dsw-mask-blur
--dsw-alias-label-primary / -secondary / -tertiary / -dimmed / -caption
--dsw-alias-border-l1 … -l4
--dsw-alias-interactive-bg-hover / -active
--dsw-alias-brand-primary        --dsw-alias-link
--dsw-alias-tooltip-bg           --dsw-alias-toast-bg
--dsw-alias-menu-icon
--dsw-radius-sm / -md / -panel
--dsw-elevation-panel / -prominent / -soft
--ds-font-family-code            --dsh-scrollbar-thumb / -hover
```

贡献热力图色阶（GitHub 官方，硬编码，不依赖主题变量；浅/深两套按当前主题选）：

```
light: #ebedf0 #9be9a8 #40c463 #30a14e #216e39
dark : #161b22 #0e4429 #006d32 #26a641 #39d353
```

文字：月份/星期/图例用 `var(--dsw-alias-label-secondary)`；总数标题 `var(--dsw-alias-label-primary)`；
tooltip 恒深色底白字（`#24292f` / `#ffffff`，GitHub 同款），不随主题翻转。

---

## 7. 插件设置区（权重输入）落点

宿主在 0.2.1 把「设置」搬进账号菜单，**插件自己的配置渲染在 Plugins 页的组合包详情里**。
宿主页面声明的三个 slot（`ui-plugin-manager` README L73/L133）：

| slot | 键 | 位置 |
|---|---|---|
| `plugins.item` | 官方插件 id | 官方插件列表 |
| **`plugins.bundle.config`** | **npm 包名** | **组合包详情页：描述与行之间** |
| `plugins.row.config` | `<包名>#<行 id>` | 单行详情 |

注册方式（与 dshmarket 完全一致）：

```js
ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
  name: 'plugins.bundle.config', key: 'dsh-happycode', locale: 'dsh-happycode',
  inject: () => ({ t }),
}, (owner) => owner.view === 'summary' ? null : h(SettingsCard)))
```

`schemaVersion` / 权重 / 编辑工具名单的**持久化自己管**：写在
`<profile>/.dsh-happycode/settings.json`，由本插件的 HTTP 路由读写，
不依赖宿主的 settings 服务（宿主 0.1.7+ 已不再为插件提供自注册的 settings 命名空间）。
页面上三个数字输入 + `Recalculate` 按钮 → `POST /dsh-happycode/api/settings` → 服务端重建缓存 →
客户端下次取图即新值（并广播一次刷新事件给已打开的弹窗）。

---

## 8. 服务端（宿主侧）约定

| 事项 | 做法 | 出处 |
|---|---|---|
| 插件入口 | `export const name` + `export function apply(ctx, config)` | dshmarket `lib/index.js` |
| HTTP 路由 | `ctx.inject(['webServer'], …)` 后 `webServer.register({kind:'exact', path, handler})`，返回 disposer | dshmarket `routes.ts` L99–105 |
| 生命周期 | `ctx.effect(() => {…; return dispose }, 'label')` | dshmarket `src/index.ts` |
| 同源校验 | 变更类路由校验 `Origin`/`Host`（本插件只有本机读取 + 自己的设置写入，仍加同源校验） | dshmarket `http.ts` |
| home 解析 | `DSH_HOME` 或 `~/.dsh`；profile 目录优先取 `profileContext.dir`，否则 `<home>/profiles/<profile>` | dshmarket `home-paths.ts` / `profile.ts` |

路由（本插件，全部 `exact`、同源、仅本机）：

```
GET  /dsh-happycode/api/graph?year=YYYY        → { mode:'year', year, total, days[], thresholds, availableYears, firstActivity, meta }
GET  /dsh-happycode/api/graph?range=last365    → { mode:'last365', … }   # 保留给 v0.2 路线图，v3 起前端不再调用
POST /dsh-happycode/api/refresh                 → { ok, scanned, parsed, reused, failed, durationMs, status }
                                                  # 默认增量；body {force:true} 才全量重解码
GET  /dsh-happycode/api/settings                → { weights, editTools, updatedAt }
POST /dsh-happycode/api/settings                → 写入并重算
GET  /dsh-happycode/api/status                  → { indexing, sessions, days, builtAt, timeZone, errors[], settings, zstd }
```

`availableYears`（v3 R5）= `{当前年份} ∪ {有活动数据的年份}`，降序取前 3 ——
所以新年第一天打开时当前年仍在列（空图），而 2029 年时会是 `[2029, 2028, 2027]`。

`firstActivity`（v5 R11）= `{ date: 'YYYY-MM-DD', source: 'activity' | 'session' } | null`：
优先取日聚合里最早的非空日期，用户还没有贡献时退回最早会话的 `createdAt`，
两者都没有则为 `null`（此时资料行只显示头像与名字，不显示 "Coding since"）。

---

## 9. 尚不确定 / 已知风险

| 项 | 状态 | 应对 |
|---|---|---|
| 账号菜单行能否拿到 React 层面注入 | **已确认不行**（硬编码 items） | DOM 克隆注入，见 §2.2 |
| 注入行的键盘可达性 | 已确认宿主键盘导航查 DOM，注入节点自动参与 | 已在 `Menu` 源码核对 |
| `useModalLayer` 的导出名是否稳定 | 宿主自己在用；做存在性检测 | 缺失则自实现 Esc |
| `plugins.bundle.config` 在无插件页的宿主上 | slot 不存在 → `inject` 永不触发 | 静默不注册；弹窗功能不依赖它 |
| 主题色在自定义主题下的取值 | `themes[].tokens` 可能覆盖 token | 色阶用官网固定值，只文字/边框走 token |
| 宿主重启才能加载服务端半侧 | 是（Loader 行来自 `cordis.patch.yml`） | 本地实装脚本 + 重启提示；客户端半侧刷新页面即可 |
