import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  computeImmersiveHidden,
  createWindowsTitleBar,
  TITLE_BAR_ID,
} from '../immersive_title_bar';

describe('computeImmersiveHidden', () => {
  it('三者全真才隐藏', () => {
    expect(computeImmersiveHidden(true, true, true)).toBe(true);
  });

  it('全局开关关闭 → 不隐藏（默认态）', () => {
    expect(computeImmersiveHidden(false, true, true)).toBe(false);
    expect(computeImmersiveHidden(undefined, true, true)).toBe(false);
  });

  it('导航栏未隐藏 → 不隐藏', () => {
    expect(computeImmersiveHidden(true, false, true)).toBe(false);
    expect(computeImmersiveHidden(true, undefined, true)).toBe(false);
  });

  it('非阅读页 → 不隐藏（首页/书架保留标题栏）', () => {
    expect(computeImmersiveHidden(true, true, false)).toBe(false);
  });
});

describe('createWindowsTitleBar', () => {
  const hadTauri = typeof (window as any).__TAURI__ !== 'undefined';
  const hadInternals = typeof (window as any).__TAURI_INTERNALS__ !== 'undefined';
  const savedTauri = (window as any).__TAURI__;
  const savedInternals = (window as any).__TAURI_INTERNALS__;
  let windowCalls: Array<{ cmd: string; args: unknown }>;

  beforeEach(() => {
    windowCalls = [];
    document.body.innerHTML = '';
    (window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      invoke: async (cmd: string, args: unknown) => {
        windowCalls.push({ cmd, args });
        return undefined;
      },
      transformCallback: (cb: unknown) => cb,
    };
    (window as any).__TAURI__ = {
      core: {
        invoke: async (cmd: string) => (cmd === 'is_main_fullscreen' ? false : {}),
      },
      event: {
        listen: async () => () => {},
      },
    };
  });

  afterEach(() => {
    document.getElementById(TITLE_BAR_ID)?.remove();
    document.getElementById(`${TITLE_BAR_ID}-style`)?.remove();
    if (hadTauri) (window as any).__TAURI__ = savedTauri;
    else delete (window as any).__TAURI__;
    if (hadInternals) (window as any).__TAURI_INTERNALS__ = savedInternals;
    else delete (window as any).__TAURI_INTERNALS__;
  });

  it('建立控件：拖拽区 + 三个窗口按钮', () => {
    const bar = createWindowsTitleBar(document);
    expect(bar).not.toBeNull();
    const node = document.getElementById(TITLE_BAR_ID)!;
    expect(node.querySelector('[data-tauri-drag-region]')).not.toBeNull();
    expect(node.querySelectorAll('.wxrd-itb-btn').length).toBe(3);
    expect(document.getElementById(`${TITLE_BAR_ID}-style`)).not.toBeNull();
    bar!.destroy();
  });

  it('点击按钮调用对应窗口方法', () => {
    const bar = createWindowsTitleBar(document)!;
    const node = document.getElementById(TITLE_BAR_ID)!;
    (node.querySelector('[data-action="minimize"]') as HTMLElement).click();
    (node.querySelector('[data-action="maximize"]') as HTMLElement).click();
    (node.querySelector('[data-action="close"]') as HTMLElement).click();
    const cmds = windowCalls.map((c) => c.cmd);
    expect(cmds).toContain('plugin:window|minimize');
    expect(cmds).toContain('plugin:window|toggle_maximize');
    expect(cmds).toContain('plugin:window|close');
    bar.destroy();
  });

  it('顶边命中唤出（加 shown 类）', () => {
    const bar = createWindowsTitleBar(document)!;
    const node = document.getElementById(TITLE_BAR_ID)!;
    expect(node.classList.contains('wxrd-itb-shown')).toBe(false);
    window.dispatchEvent(new MouseEvent('mousemove', { clientY: 1 }));
    expect(node.classList.contains('wxrd-itb-shown')).toBe(true);
    bar.destroy();
  });

  it('destroy 移除节点与样式', () => {
    const bar = createWindowsTitleBar(document)!;
    bar.destroy();
    expect(document.getElementById(TITLE_BAR_ID)).toBeNull();
    expect(document.getElementById(`${TITLE_BAR_ID}-style`)).toBeNull();
  });
});
