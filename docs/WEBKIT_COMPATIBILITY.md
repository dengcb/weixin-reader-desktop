# WebKit 兼容红线与 2026-09 EPUB 打开事故

> 现行规则：改 inject.js / local_reader.js 相关前端源码前必读。
> 历史事故记录在下方，规则部分长期有效。

## 现行规则

1. **兼容基线**：注入产物（`inject.js`、`local_reader.js`、bootstrap）面向 **Safari 15.x**（macOS 12 初始 WebKit）及以上的 WKWebView。低于该基线的语法/API 一律不用。
2. **禁用清单**（按 Safari 支持版本）：
   - 正则 lookbehind（`(?<=` / `(?<!`）：Safari **16.4+** 才支持。旧引擎把 `(?<=` 误读为命名捕获组开头，报极具误导性的 `SyntaxError: invalid group specifier name`，且正则字面量在脚本解析阶段即求值——**整个脚本阵亡，整页白屏/永远 loading**。禁止。
   - 非 ASCII 命名捕获组（如 `(?<中文>`）：同为 Safari 16.4+。ASCII 命名组（Safari 10.1+）可用。
   - `.at()` / `findLast` / `structuredClone` / `Object.hasOwn` / `crypto.randomUUID`：Safari 15.4+，使用前自查。
   - `Promise.withResolvers`：Safari 17.4+，禁止。
   - `toSorted` / `toReversed` / `Array.prototype.with`：Safari 16+，避免。
3. **构建守卫**：`scripts/build-local-reader.ts` 与 `scripts/build-inject.ts` 构建后扫描产物中 `(?<` 后非 ASCII 字母的形态（覆盖 lookbehind 与非 ASCII 组名），发现即构建失败。字符串字面量误报时改写为 `'\\(\\?<'` 拼接规避（注意必须是双反斜杠：JS 字符串里单反斜杠会被吞，求值后仍是 `(?<`，照样被拦），**不要移除守卫**。守卫非完备，已知限制：动态拼接（如 `'(?' + '<='`）扫不到；`(?<_x>` / `(?<$x>` 这类 `_`/`$` 开头的合法 ASCII 组名会被保守误拦（fail-safe 取向），届时改组名或拼接规避。
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
