import { describe, expect, test, beforeEach } from 'bun:test';
import {
  EXIT_BUTTON_ID,
  EXIT_BUTTON_EDGE_PX,
  EXIT_BUTTON_LINGER_MS,
  ensureExitButton,
  isEdgeHit,
  showExitButton,
} from '../fullscreen_exit_button';

describe('fullscreen_exit_button（dev.9 退出全屏叉号）', () => {
  beforeEach(() => {
    document.getElementById(EXIT_BUTTON_ID)?.remove();
    document.getElementById(`${EXIT_BUTTON_ID}-style`)?.remove();
    document.body.innerHTML = '';
  });

  test('isEdgeHit：命中带边界语义', () => {
    expect(isEdgeHit(0)).toBe(true);
    expect(isEdgeHit(EXIT_BUTTON_EDGE_PX)).toBe(true);
    expect(isEdgeHit(-1)).toBe(false);
    expect(isEdgeHit(EXIT_BUTTON_EDGE_PX + 0.1)).toBe(false);
    expect(isEdgeHit(500)).toBe(false);
  });

  test('ensureExitButton：幂等 + 双主题 CSS 注入 + 语义属性', () => {
    const first = ensureExitButton(document);
    expect(first).not.toBeNull();
    expect(first!.id).toBe(EXIT_BUTTON_ID);
    expect(first!.getAttribute('aria-label')).toBe('退出全屏');
    const again = ensureExitButton(document);
    expect(again).toBe(first);
    // 深浅双适配样式必须存在关键选择器
    const css = document.getElementById(`${EXIT_BUTTON_ID}-style`)?.textContent ?? '';
    expect(css).toContain('body.wr_whiteTheme #wxrd-exit-fullscreen');
    expect(css).toContain('prefers-color-scheme: light');
    expect(css).toContain('wxrd-edge-shown');
    // 点击处理由调用方（inject.ts）绑定 simulate_menu_click，此处校验默认无内建 onclick
    expect(first!.onclick).toBeNull();
  });

  test('showExitButton：加显示类并安排收回计时', async () => {
    const button = ensureExitButton(document)!;
    const hideTimer: { current: ReturnType<typeof setTimeout> | null } = { current: null };
    const scheduledAt = showExitButton(button, hideTimer);
    expect(scheduledAt).not.toBeNull();
    expect(button.classList.contains('wxrd-edge-shown')).toBe(true);
    expect(hideTimer.current).not.toBeNull();
    await Bun.sleep(EXIT_BUTTON_LINGER_MS + 120);
    expect(button.classList.contains('wxrd-edge-shown')).toBe(false);
    expect(hideTimer.current).toBeNull();
  }, 8000);

  test('showExitButton：重复触发重置收回调（防抖）', () => {
    const button = ensureExitButton(document)!;
    const hideTimer: { current: ReturnType<typeof setTimeout> | null } = { current: null };
    showExitButton(button, hideTimer);
    const firstTimer = hideTimer.current;
    showExitButton(button, hideTimer);
    expect(hideTimer.current).not.toBe(firstTimer);
    clearTimeout(hideTimer.current!);
  });
});

// 常量契约：与 hover 命中带语义对齐（EDGE_THROTTLE 语义已退役，这些值独立演化）
describe('fullscreen_exit_button 常量契约', () => {
  test('驻留时长在 0.8s~2s 区间（用户反馈 2.5s 偏长）', () => {
    expect(EXIT_BUTTON_LINGER_MS).toBeGreaterThanOrEqual(800);
    expect(EXIT_BUTTON_LINGER_MS).toBeLessThanOrEqual(2000);
  });
  test('命中带 ≤ 3px（DPI 换算后仍可命中）', () => {
    expect(EXIT_BUTTON_EDGE_PX).toBeLessThanOrEqual(3);
  });
});

// dev.19：尺寸/位置/整矩命中区契约
describe('退出全屏按钮几何与命中区（dev.19 用户反馈）', () => {
  test('尺寸 88px、top 5%、命中区=整矩形（::before 视觉圆 + svg 不拦截）', () => {
    ensureExitButton(document);
    document.body.className = '';
    const css = document.getElementById(`${EXIT_BUTTON_ID}-style`)?.textContent ?? '';
    expect(css).toContain('width: 88px');
    expect(css).toContain('height: 88px');
    expect(css).toContain('top: 5%;');
    // 命中区优先：视觉圆是 ::before（inset 8px → 命中矩形 88 含 8px 透明边）
    expect(css).toContain('inset: 8px');
    // svg 永不拦截点击（点击穿透到按钮矩形）
    expect(css).toContain('pointer-events: none');
    // 色值自包含（主元素透明容器，不依赖 inherit）
    expect(css).toContain('background: rgba(20, 21, 23, 0.42);'); // 夜::before 基色
  });
});
