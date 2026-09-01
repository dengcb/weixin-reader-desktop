# WebKit 兼容红线与 2026-09 EPUB 打开事故

> 现行规则：改 inject.js / local_reader.js 相关前端源码前必读。
> 历史事故记录在下方，规则部分长期有效。

## 现行规则

1. **兼容基线**：注入产物（`inject.js`、`local_reader.js`、bootstrap）面向 **Safari 15.x**（macOS 12 初始 WebKit）及以上的 WKWebView。低于该基线的语法/API 一律不用。
2. **禁用清单**（按 Safari 支持版本）：
   - 正则 lookbehind（`(?<=` / `(?<!`）：Safari **16.4+** 才支持。旧引擎把 `(?<=` 误读为命名捕获组开头，报极具误导性的 `SyntaxError: invalid group specifier name`，且正则字面量在脚本解析阶段即求值——**整个脚本阵亡，整页白屏/永远 loading**。禁止。
   - 非 ASCII 命名捕获组（如 `(?<中文>`）：同为 Safari 16.4+。ASCII 命名组（Safari 10.1+）可用。
   - `.at()` / `findLast` / `structuredClone` / `Object.hasOwn` / `crypto.randomUUID`：Safari 15.4+，使用前自查。
   - `Promise.withResolvers`：Safari 17.4+，禁止（已纳入构建守卫）。
   - `Object.groupBy` / `Map.groupBy`：Safari **17.4+**，禁止（已纳入构建守卫）。foliate-js 曾在 EPUB 元数据解析中使用，见事故二。
   - `AbortSignal.any` / `Promise.try` / `RegExp.escape` / `Array.fromAsync`：Safari 17.4+/18+，禁止（已纳入构建守卫）。
   - `toSorted` / `toReversed` / `Array.prototype.with`：Safari 16+，禁止（已纳入构建守卫）。
   - Set methods（`intersection` / `union` / `symmetricDifference` 等）：Safari 17+，避免（守卫未收录：`.union(` 误报率高，靠自查）。
3. **构建守卫**：`scripts/build-local-reader.ts` 与 `scripts/build-inject.ts` 构建后双重扫描产物：① `(?<` 后非 ASCII 字母形态（lookbehind 与非 ASCII 组名，parse 期崩溃）；② API 黑名单（`Object.groupBy` / `Map.groupBy` / `withResolvers` 等，运行期崩溃），发现即构建失败。字符串字面量误报时改写为 `'\\(\\?<'` 拼接规避（注意必须是双反斜杠：JS 字符串里单反斜杠会被吞，求值后仍是 `(?<`，照样被拦），**不要移除守卫**。守卫非完备，已知限制：动态拼接（如 `'(?' + '<='`）扫不到；`(?<_x>` / `(?<$x>` 这类 `_`/`$` 开头的合法 ASCII 组名会被保守误拦（fail-safe 取向），届时改组名或拼接规避；黑名单仅覆盖确定性高、误报低的 API。
4. **别指望 target 兜底**：`bun build --target=browser` 只区分运行环境、不做语法降级（esnext 直出）；esbuild 的 target 检查也**不覆盖 lookbehind**（本事故即因此漏网）。兼容性靠上述红线 + 构建守卫保障。
5. **升级 foliate-js 时**：上游面向现代浏览器，可能引入新的 WebKit 门槛。升级后跑 `bun run build` 让守卫把关，并抽验 `.replace`/正则类改动。

## 事故记录（2026-09-01）

**现象**：macOS 12.7.4（Intel，WebKit 15.6.1）上所有 EPUB 打开后永远停在「正在打开本地图书」；macOS 15（arm）同版本（1.6.0）、同文件（md5 一致）完全正常。

**根因**：vendored foliate-js 的 `paginator.js` 在 EPUB 内嵌 CSS 剔除 `-epub-` 前缀时使用了 lookbehind：

```js
.replace(/(?<=[{\s;])-epub-/gi, '')   // 上游写法，Safari < 16.4 解析即抛错
```

JavaScriptCore 直到 16.4 才支持 lookbehind，但命名捕获组早已支持——旧引擎把 `(?<=` 当命名组解析，`=` 不是合法组名，抛 `invalid group specifier name`。正则字面量在 parse 阶段求值，整个 `local_reader.js` 无法实例化，前端零日志零渲染。

**定位路径**（复用价值）：
1. 本地阅读页 bootstrap（`src/local-reader/bootstrap.ts`）把每个加载阶段与 JS 错误原文经 `atreader://local-reader-diagnostic` 协议写入 `~/Library/Logs/com.dengcb.reader/艾特阅读.log`，无需 Web Inspector。
2. 日志时序 `stage=runtime_error detail=SyntaxError:…` 出现在 `stage=main_script_loaded` **之前** → parse 期失败，脚本从未执行。
3. 错误文案含 `invalid group specifier name` 且系统 WebKit < 16.4 → 高概率 lookbehind / 非 ASCII 组名。

**修复**：等价改写为捕获组回填（`third-party/foliate-js/paginator.js` 内有 `[atreader patch]` 注释标注与上游差异）：

```js
.replace(/([{\s;])-epub-/gi, '$1')
```

语义等价：前置字符消耗后回填；`-epub-` 为固定字面量，匹配不重叠；字符串开头的 `-epub-`（无前置字符）两版本同样不匹配。

## 事故二（2026-09-01 同日，发布后复发）

**现象**：lookbehind 修复版发布后，同一台 macOS 12.7.4 机器升级新包，EPUB 报 `undefined is not a function (near '...Object.groupBy...')`。

**根因**：foliate-js 的 `epub.js` 在 OPF 元数据解析（`getMetadata`）中使用了 `Object.groupBy`（4 处）与 `Map.groupBy`（1 处）——Safari **17.4+** 才提供，旧 WebKit 上为 `undefined`。这是**运行期**错误（脚本 parse 已通过），只扫语法形态的守卫拦不住；且首轮 API 扫描清单漏了 groupBy 族，本机 Safari 17+ 也测不出来。

**修复**：`epub.js` 顶部加 `[atreader patch]` 本地实现并替换全部 5 处调用：`groupToObject`（返回 null 原型对象——分组键来自 OPF 元素 localName，恶意书可构造 `toString` 等键名，null 原型避免原型链污染；空字符串键按规范保留）与 `groupToMap`（返回真 Map——`refines` 缺失时键为 `null`，须任意类型键）。语义经边界单测（原型键、空键、null 键、插入顺序、index 传参、与原生输出对照）验证等价。

**守卫加固**：构建守卫从单一语法扫描升级为「语法 + API 黑名单」双重扫描（`Object.groupBy` / `Map.groupBy` / `withResolvers` / `AbortSignal.any` / `Promise.try` / `RegExp.escape` / `Array.fromAsync` / `.toSorted(` / `.toReversed(` / `.toSpliced(`）。

**教训**：禁用清单靠人工记忆不可靠（首轮就漏了 groupBy）——能固化的清单必须进构建守卫；发布前必须用旧系统真机（或日志回传）验证，本机新系统测不出旧系统问题。

**快速判读表**（本地图书打不开时看日志断点）：

| 日志停在哪 | 结论 |
|---|---|
| 无 `inspect_start` | 入口/菜单事件未到 Rust 层 |
| `epub_parse_failed error=…` | Rust 侧解析失败（zip/XML） |
| `navigation_succeeded` 后无 `protocol_request path=/local-reader` | WebKit 未发起页面加载 |
| 有 bootstrap.js 请求但无 `stage=bootstrap_started` | bootstrap 脚本未执行 |
| `stage=main_script_error` / `runtime_error detail=…` | JS 错误原文在日志里，直接定位 |
| `bootstrap_started` 后无 `main_script_loaded` 也无报错 | `local_reader.js` 被网络层拦截 |
| `[LocalReader] initialize_start` 后停在 `tauri_wait_start` | `__TAURI__` 未注入，IPC 初始化问题 |
| 走到 `book_loaded` 之后才异常 | foliate 渲染层，WebView 特性差异 |
