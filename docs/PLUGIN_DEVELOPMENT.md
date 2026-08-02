# 第三方网页插件开发指南

本文面向希望为艾特阅读适配新网站的社区开发者。官方番茄小说插件是当前完整范例：

- 源码：[`plugins/fanqie/`](../plugins/fanqie/)
- 通用起始模板：[`src/plugins/template/`](../src/plugins/template/)
- 插件运行时与安全边界：[`PLUGIN_ARCHITECTURE.md`](./PLUGIN_ARCHITECTURE.md)

## 1. 先明确责任边界

插件编辑器只检查开发者有没有按规范提交声明和文件，不判断某项功能在目标网站上是否真的可用。

绿色对勾代表：

- Manifest 的必要声明完整。
- 插件入口存在、非空并提供默认导出。
- Manifest 中开启的六项编辑器能力，已在代码或 CSS 中使用统一标记声明实现位置。
- 独立 CSS 文件非空，并声明它对应的能力或基础用途。

绿色对勾不代表：

- 网站 DOM 选择器仍然有效。
- 翻页、隐藏、进度或键盘操作已经通过真实网站验收。
- 登录状态、阅读位置和网站接口一定正确。
- 插件质量获得项目维护者背书。

真正的功能正确性来自开发者测试、用户实际使用、社区反馈和持续维护。编辑器不解析几行代码后替开发者作出功能承诺。

## 2. 快速开始

推荐流程：

1. 复制 `src/plugins/template/`，或参考 `plugins/fanqie/` 新建 `plugins/<plugin-id>/`。
2. 填写 `manifest.json`，只开启已经准备实现的能力。
3. 在代码或 CSS 的实现附近添加 `@capability` 自声明标记。
4. 实现站点判断、样式注入、翻页和清理逻辑。
5. 为 DOM 所有权、能力开关和关键交互添加测试。
6. 构建 `.atrd`，安装到应用后在真实网站验收。
7. 根据社区反馈更新选择器、样式和交互。

外部插件源码的推荐结构：

```text
plugins/example-reader/
├─ manifest.json
├─ index.ts
├─ index.test.ts                 可选，但推荐
├─ styles/
│  ├─ reader.css
│  ├─ wide.css
│  ├─ toolbar.css
│  └─ navbar.css
└─ release/                      构建输出，不在这里手工改代码
```

构建后的 `.atrd` 是 ZIP 容器，运行时核心结构为：

```text
example-reader.atrd
├─ manifest.json
├─ plugin.js                     自包含 ESM，必须有 default export
└─ styles/                       可选
   └─ *.css
```

`index.ts` 可以拆分并导入本插件目录的其他 TypeScript 模块；构建时会合并为一个可读的 `plugin.js`。运行时插件包不要依赖未打包的相对模块。

## 3. Manifest 规范

网页插件至少应提供：

```json
{
  "id": "example-reader",
  "name": "示例书店",
  "version": "1.0.0",
  "description": "示例网站阅读增强插件",
  "author": "开发者名称",
  "homepage": "https://example.com/plugin",
  "sourceType": "web",
  "renderMode": "webview",
  "site": {
    "domain": ["example.com"],
    "homeUrl": "https://example.com/",
    "readerPattern": "/reader/"
  },
  "capabilities": {
    "doubleColumn": false,
    "wideMode": true,
    "hideToolbar": true,
    "hideNavbar": false,
    "chapterNav": false,
    "progressTracker": false
  }
}
```

稳定约束：

- `id` 只使用小写 ASCII 字母、数字、`-`、`_`，最长 64 字节。
- `version` 使用 `x.y.z` 格式。
- `site.domain` 填域名，不包含路径。
- `site.homeUrl` 必须是 HTTP(S) 完整地址。
- `site.readerPattern` 必须非空，并能区分阅读页与首页。
- 已安装 Manifest 是运行时能力开关的权威来源，会覆盖插件代码内用于开发的默认 Manifest。
- 外部插件构建时会写入 `builtin: false`，不要依赖源码中的 `builtin` 值判断运行环境。

Manifest 还支持 `autoFlip`、`hideCursor`、`remoteControl` 等能力。本文重点说明插件编辑器当前展示的六项站点能力。

## 4. 六项能力自声明规范

固定能力键如下，大小写必须一致：

| 编辑器名称 | 能力键 | 官方范例中的职责 |
|---|---|---|
| 双栏模式 | `doubleColumn` | 启用整页双栏，并可向站点工具栏注入单列/双栏切换按钮 |
| 宽屏模式 | `wideMode` | 根据站点设置注入宽屏样式 |
| 隐藏工具栏 | `hideToolbar` | 根据站点设置隐藏网站工具栏 |
| 隐藏导航栏 | `hideNavbar` | 隐藏网站顶部导航，并回收原占位空间 |
| 章节导航 | `chapterNav` | 双栏激活时允许上/下键切换章节 |
| 进度追踪 | `progressTracker` | 显示底部当前页数；关闭后回收页码占位空间 |

### 4.1 代码标记

在能力实现附近使用保留注释：

```ts
/*!
 * @capability chapterNav
 * 双栏激活时，上键切上一章，下键切下一章。
 */
```

单行写法也可以：

```ts
/*! @capability wideMode 根据 readerWide 状态注入 wide.css。 */
```

代码必须使用 `/*! ... */`。Bun 会在构建后的 `plugin.js` 中保留这种注释，用户才能在应用内代码编辑器中看到声明。

### 4.2 CSS 标记

能力样式：

```css
/*
 * @capability hideNavbar
 * 隐藏顶部导航并回收网站原有的导航栏占位。
 */
```

不对应开关的基础样式：

```css
/*
 * @foundation
 * 站点 viewport 与 rem 基准修正。
 */
```

规则：

- Manifest 中值为 `true` 的六项能力，必须至少在代码或 CSS 中出现一次对应 `@capability`。
- 一个能力可以在多个实现位置重复标记，例如双栏分页代码和双栏布局 CSS。
- 每份独立 CSS 必须非空，并至少包含一个合法的 `@capability` 或 `@foundation`。
- 没有独立 CSS 的插件是合法的，编辑器会显示“无独立样式”；样式可以由代码内联。
- 标记只是开发者自声明，不是行为检测。不要为了亮绿勾添加与实际工作无关的虚假标记。

## 5. 编辑器验证状态

插件加载、表单切换、代码修改和样式修改后，编辑器都会重新验证三项状态。

### Manifest 配置

检查 ID、名称、版本、域名、首页 URL 等必要声明。安装时 Rust 后端还会执行包路径、大小、域名和阅读页模式等安全校验。

### 插件代码

检查：

- 存在 `index.ts`、`index.js`、`plugin.ts`、`plugin.js` 中的一种入口。
- 入口非空。
- 入口提供 `export default`，或构建后等价的 `export { value as default }`。
- Manifest 中开启的六项能力，都能在代码或 CSS 中找到同名自声明。

### 样式文件

检查：

- CSS 文件可读取且非空。
- 每份 CSS 含合法的 `@capability` 或 `@foundation`。
- 没有独立 CSS 时按合法处理。

状态含义：

- 绿色 `✓`：声明完整。
- 红色 `✗`：声明或文件结构缺失；悬停图标可查看原因。
- 黄色 `?`：尚未加载或正在等待验证，不代表失败。

保存和安装只在三项均为绿色时开放。编辑器不会分析选择器、模拟翻页或访问目标网站来证明功能真假。

## 6. 插件代码基本结构

```ts
import type {
  PluginAPI,
  PluginManifest,
  PluginStyles,
  ReaderPlugin,
} from '../../src/scripts/core/plugin_types';
import manifestJson from './manifest.json';

// 开发期读取源码 Manifest；安装后仍以安装包中保存的 Manifest 为准。
const manifest = manifestJson as PluginManifest;

class ExamplePlugin implements ReaderPlugin {
  readonly manifest = manifest;
  private api: PluginAPI | null = null;
  private cleanupFunctions: Array<() => void> = [];

  onLoad(api: PluginAPI): void {
    this.api = api;
    const unsubscribe = api.settings.subscribe(settings => {
      this.applySettings(settings);
    });
    this.cleanupFunctions.push(unsubscribe);
    this.applySettings(api.settings.getAll());
  }

  onUnload(): void {
    this.cleanupFunctions.forEach(cleanup => cleanup());
    this.cleanupFunctions = [];
    this.api = null;
  }

  isReaderPage(): boolean {
    return location.pathname.includes('/reader/');
  }

  isHomePage(): boolean {
    return location.pathname === '/';
  }

  matchesDomain(): boolean {
    return location.hostname === 'example.com';
  }

  nextPage(): void {}
  prevPage(): void {}

  getStyles(): PluginStyles {
    return {};
  }

  private applySettings(_settings: Record<string, unknown>): void {}
}

export default ExamplePlugin;
```

具体接口以 [`src/scripts/core/plugin_types.ts`](../src/scripts/core/plugin_types.ts) 为准。

## 7. 样式文件与注入

插件包内的 CSS 不会因为存在就自动生效。插件应通过 API 读取并明确决定何时注入：

```ts
const wideCss = api.style.getFile('wide.css') ?? '';

if (settings.readerWide === true && wideCss) {
  api.style.inject('wide', wideCss);
} else {
  api.style.remove('wide');
}
```

注意：

- `style.getFile()` 的文件名必须与 `styles/` 下文件完全一致。
- Style ID 会自动增加插件命名空间，不要自行拼接其他插件 ID。
- 多份同级样式存在覆盖关系时，按明确顺序注入。番茄先注入 80% 的双栏基线，再注入 90% 的宽屏覆盖。
- 插件编辑器保存 CSS 后会触发热重载；不要维护一份编辑器可见但运行时不读取的“影子样式”。
- CSS 选择器尽量挂在插件自己的 body 类或唯一前缀下，避免污染首页和其他站点页面。
- 插件创建的类名、DOM ID、storage key 使用稳定前缀，例如 `atreader-fanqie-`。

## 8. 生命周期、设置和本地状态

### 生命周期

`onLoad()` 可能发生在网站 `<body>` 或阅读器 DOM 创建之前。不要假设正文和工具栏已存在。

`onUnload()` 必须清理：

- `window`、`document` 和 DOM 节点事件监听器。
- `MutationObserver`、`ResizeObserver`。
- `setTimeout`、`setInterval`、`requestAnimationFrame`。
- 插件自行创建的 DOM 节点和 class。
- 未经 Plugin API 管理的其他资源。

通过 Plugin API 注入的样式和事件有宿主兜底清理，但插件仍应主动释放自己拥有的资源。

### 设置

`api.settings.getAll()` 返回当前站点显示设置与插件自定义配置的合并视图。常用显示字段：

- `readerWide`
- `hideToolbar`
- `hideNavbar`

使用 `api.settings.subscribe()` 响应菜单或遥控器引发的设置变化，不要直接读取应用设置文件。

### 插件状态

`api.storage` 提供按插件 ID 隔离的本地存储，适合保存：

- 单列/双栏临时偏好。
- 当前章节内的分页比例。
- 仅属于插件的轻量状态。

窗口宽高变化后，优先按比例恢复位置，不要只保存绝对像素或页码；横屏与竖屏的总页数可能不同。

## 9. 番茄插件实践经验

下面这些问题在真实网站适配中已经出现过，值得直接复用。

### 9.1 首屏 DOM 可能晚于插件加载

只在加载时查询一次工具栏，会导致按钮必须等用户翻页后才出现。番茄方案：

- 从 `document.documentElement` 开始观察。
- 首屏挂载期间使用短周期补偿。
- 找到并稳定插入按钮后立即停止补偿定时器。
- React/Vue 替换整个节点时重新绑定，而不是保留失效引用。

### 9.2 尽量保留网站原正文 DOM

双栏实现不复制正文，也不读取或导出正文文本。分页器只把原正文节点放进自己的 viewport，再由 CSS Columns 排版；卸载时把同一个节点放回原位置。这能减少：

- 网站事件和状态丢失。
- 重复正文与辅助功能问题。
- 与版权、字体混淆和内容抓取相关的风险。

### 9.3 响应式宽度优先使用百分比

固定页宽无法同时适应横屏、竖屏和多显示器。番茄采用：

- 普通双栏书页宽度 `80%`。
- 宽屏模式 `90%`。
- 内部边距单独使用 `32px`，窄窗口降为 `16px`。
- 工具栏位置跟随书页百分比计算，避免与正文重叠。

百分比控制外壳，固定值只用于小范围留白和最小安全尺寸。

### 9.4 隐藏元素必须同步回收占位

只写 `display: none` 可能留下空白：

- 隐藏导航栏时，还要收回网站为导航预留的顶部 padding。
- 隐藏底部页码时，还要把分页 viewport 向下延伸，收回页码预留高度。

能力名称应对应用户能观察到的完整结果，而不是只改变某个节点的可见性。

### 9.5 阅读翻页应减少视觉晃动

番茄双栏采用瞬时整页位移，不使用平移动画。重新布局和恢复位置时，也临时禁用 transition。阅读器交互应优先保证稳定、连续和不晃眼。

### 9.6 键盘只在明确边界内接管

- 左/右键只在双栏分页激活时负责翻页。
- 上/下键还必须要求 `chapterNav === true`。
- 输入框、文本域、下拉框和可编辑元素不拦截。
- 修饰键按下或事件已处理时不接管。
- 插件自己合成的章节事件要打标，避免再次被自身捕获。

### 9.7 壳能力不要做成单站点补丁

蓝牙遥控器菜单键的捕获属于应用壳。壳负责阻止特殊事件泄露给网站并更新当前站点的 `hideToolbar`；插件只需订阅设置并实现本站工具栏显示/隐藏。跨网站输入能力不应复制进每个插件。

### 9.8 能力关闭时不要留下半套行为

- `doubleColumn` 关闭：不启用分页，也不注入切换按钮。
- `chapterNav` 关闭：不拦截上/下键。
- `progressTracker` 关闭：不创建页码、不注入页码 CSS，并回收空间。

Manifest 是能力权威来源。代码每次应用设置时都应读取当前有效 Manifest，而不是只相信源码默认值。

## 10. 测试建议

至少覆盖：

- 域名、首页和阅读页判断。
- 能力开启与关闭的两条路径。
- 插件早于 `<body>` 加载。
- 网站替换正文或工具栏 DOM。
- `onUnload()` 后 DOM、事件、观察器和定时器全部恢复。
- 横竖屏或窗口 resize 后重新布局。
- 键盘在输入控件中不被误拦截。
- 样式文件确实被读取和注入，不是只存在于包内。
- 自声明标记在编译后的 `plugin.js` 中仍然存在。

番茄相关测试：

```bash
bun test plugins/fanqie/index.test.ts plugins/fanqie/pagination.test.ts
bun test test/plugin_editor_validation.test.ts
```

完整质量门禁：

```bash
bun run typecheck
bun test
bun run check:frozen
bun run build
git diff --check
```

静态测试只能证明本地回归。真实网站验收仍应覆盖：

- 首次进入阅读页。
- 章节切换和页面刷新。
- 横屏、竖屏与不同窗口尺寸。
- 网站日间、夜间主题。
- 菜单、键盘、触摸板和遥控器。
- 登录前后 DOM 差异。

## 11. 构建、安装与更新

构建单个插件：

```bash
bun run build:plugin example-reader
```

输出位置：

```text
plugins/example-reader/release/example-reader.atrd
```

检查压缩包：

```bash
unzip -t plugins/example-reader/release/example-reader.atrd
unzip -l plugins/example-reader/release/example-reader.atrd
```

应用内安装路径：

```text
设置 → 插件管理 → 安装插件
```

外部插件的已安装副本不会因为仓库源码变化而自动更新。测试新版本前，需要重新构建并重新安装新的 `.atrd`。建议更新 Manifest 版本号，让用户能够辨认正在测试的版本。

安装器的主要限制：

- 包文件和解压后总大小均不超过 20 MiB。
- 最多 128 个条目。
- 单文件不超过 4 MiB，Manifest 不超过 256 KiB。
- 路径最多四层。
- 禁止绝对路径、`..`、目录逃逸和 ZIP 符号链接。
- 暂存版本校验失败时不会覆盖旧插件。

## 12. 社区反馈建议

反馈插件问题时，建议提供：

- 应用版本、插件 ID 和插件版本。
- 操作系统与窗口方向/尺寸。
- 目标网站 URL 类型：首页、目录页或阅读页。
- 出问题的能力名称。
- 是否登录、网站主题和字体设置。
- 可重复的操作步骤。
- 截图、录屏或不含正文隐私的 DOM 结构线索。

维护者应先判断问题属于：

- Manifest 或自声明缺失。
- 网站 DOM/样式变化。
- 插件生命周期或清理错误。
- 应用壳的跨站点能力。
- 只能在真实设备或特定平台复现的问题。

不要因为某个网站的特殊行为，未经评估就修改整个壳或其他插件。

## 13. 发布前检查清单

- [ ] Manifest ID、版本、域名和阅读页模式正确。
- [ ] 只开启实际准备交付的能力。
- [ ] 每个已开启能力都有准确的 `@capability` 自声明。
- [ ] 每份 CSS 都有 `@capability` 或 `@foundation`。
- [ ] 入口提供默认导出。
- [ ] 插件不复制、抓取或导出网站正文。
- [ ] 首屏 DOM 延迟、路由变化和节点替换已处理。
- [ ] `onUnload()` 释放全部自有资源。
- [ ] 能力关闭路径不会留下按钮、事件或空白占位。
- [ ] 编辑器三项验证均为绿色。
- [ ] 单元测试、类型检查、构建和 ZIP 检查通过。
- [ ] 使用新构建的 `.atrd` 完成真实网站验收。
