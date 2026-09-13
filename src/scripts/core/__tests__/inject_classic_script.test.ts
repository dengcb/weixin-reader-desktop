import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * [dev.6 事故回归线] 初始化脚本必须是经典脚本：
 * WebView2 的 AddScriptToExecuteOnDocumentCreated 以非模块上下文执行，
 * 顶层 import/export 是语法错误 → 整个注入（快捷键/样式面板/AppRuntime）
 * 静默死亡。dev.6 因 inject.ts re-export 常量导致产物尾部 export{...}，
 * 用户真机 F11/Ctrl+H/样式面板全部失效。
 *
 * 本测试与 build-inject.ts 的守卫（第 45 行正则）双保险：
 * 构建期拦截 + 测试期回归。
 */
const MODULE_SYNTAX = /(?:^|[;\n])\s*(?:export\s*[{*]|import\s*[({'"*])/;

describe('inject.js 产物必须是经典脚本（无模块语法）', () => {
  const dist = readFileSync(join(import.meta.dir, '..', '..', 'inject.js'), 'utf-8');

  it('不含顶层 export 语句', () => {
    expect(MODULE_SYNTAX.test(dist)).toBe(false);
  });

  it('守卫正则有效性自检：含 export 的样例必须命中（防正则被误改失效）', () => {
    expect(MODULE_SYNTAX.test('const a=1;\nexport{a};')).toBe(true);
    expect(MODULE_SYNTAX.test('main();export{shouldRevealMenuBar};')).toBe(true);
    expect(MODULE_SYNTAX.test(`import { x } from 'y';`)).toBe(true);
    // 正常经典脚本文本不应误报（函数体内的 "export " 字符串、注释等）
    expect(MODULE_SYNTAX.test('const s = "re-export value"; window.x = s;')).toBe(false);
    expect(MODULE_SYNTAX.test('function f(){ return "export?"; } main();')).toBe(false);
  });

  it('关键注入锚点存在（快捷键 handler 与全屏叉号链路确在产物中）', () => {
    expect(dist).toContain('toggle_menu_bar');
    expect(dist).toContain('simulate_menu_click');
    // dev.9：碰顶交互改为退出全屏叉号（旧 reveal_menu_bar_transient 白条已退役）
    expect(dist).toContain('wxrd-exit-fullscreen');
    expect(dist).toContain('toggle_fullscreen');
    expect(dist).toContain('attachEventToSameOriginIframes');
    expect(dist).toContain('wxrd_injected');
  });
});
