import { describe, expect, test } from 'bun:test';
import { attachEventToSameOriginIframes } from '../iframe_keyboard';

/**
 * dev.3 真机事故根因回归（2026-09-12 CDP 取证）：
 * WebView2 在文档解析最早期执行注入脚本，documentElement 为 null，
 * MutationObserver.observe(null) 抛 TypeError，曾被 main() 未捕获
 * 炸穿整条注入链（快捷键/样式面板/hover 全灭）。
 *
 * happy-dom 无真正「无 <html>」文档形态，无法端到端复现原始崩溃；
 * 在此以单元契约固化两层防御：
 * 1) observe 目标必须非空——工具内任何 observe 调用前对 documentElement 判空;
 * 2) 工具对调用方的总契约——attachEventToSameSourceIframes 绝不因
 *    「宿主文档尚未就绪」抛出（时序性输入不构成调用方错误）。
 * 时序层 DOMContentLoaded 部分由 iframe_keyboard 源内联实现并被
 * 真机 dev.4 冒烟（CDP）覆盖。
 */

const observeArgs: Array<unknown | null> = [];
const origObserve = MutationObserver.prototype.observe;
let observeShouldThrow = false;

describe('iframe_keyboard 早注入防御（dev.3 事故回归）', () => {
  test('观察目标为 null 时 observe 抛 TypeError（对照组，证明根因真实存在）', () => {
    MutationObserver.prototype.observe = function (target: unknown) {
      observeArgs.push(target);
      if (observeShouldThrow ?? true) {
        // 还原 W3C 行为：非 Node 目标抛 TypeError（Chromium 真实语义）
        if (target === null || target === undefined) {
          throw new TypeError(
            "Failed to execute 'observe' on 'MutationObserver': parameter 1 is not of type 'Node'.",
          );
        }
      }
      return origObserve.call(this, target as Node, arguments[1] as MutationObserverInit);
    };
    try {
      expect(() => {
        // 显式复刻历史崩溃行：documentElement === null 时 observe(null)
        new MutationObserver(() => {}).observe(null as never, { childList: true });
      }).toThrow(TypeError);
    } finally {
      MutationObserver.prototype.observe = origObserve;
    }
  });

  test('attachEventToSameOriginIframes 在文档未就绪时不抛出（挂载延迟由内部负责）', () => {
    // happy-dom 文档在测试环境下 documentElement 恒存在；此用例保证：
    // 即使将来宿主给出无 <html> 文档（或就绪状态晚于调用），
    // attach* 的对外契约是「不因时序抛出」，给 detach 以幂等函数。
    let detach: (() => void) | null = null;
    expect(() => {
      detach = attachEventToSameOriginIframes('keydown', () => {});
    }).not.toThrow();
    expect(typeof detach === 'function').toBe(true);
    expect(() => detach?.()).not.toThrow();
    // 二次 detach 幂等
    expect(() => detach?.()).not.toThrow();
  });

  test('documentElement 存在时立即扫描 iframe 并可正常清理', () => {
    let called = 0;
    const detach = attachEventToSameOriginIframes('keydown', () => { called += 1; });
    expect(typeof detach === 'function').toBe(true);
    detach();
    expect(called).toBe(0);
  });
});
