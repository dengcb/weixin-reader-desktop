import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  resolveRemoteHidAction,
  subscribeRemoteHidButtons,
} from '../remote_hid_source';

describe('resolveRemoteHidAction', () => {
  it('音量键仅阅读页翻页：Vol+ 上一页，Vol- 下一页', () => {
    expect(resolveRemoteHidAction('volume_up', 'press', true)).toBe('page-backward');
    expect(resolveRemoteHidAction('volume_down', 'press', true)).toBe('page-forward');
    expect(resolveRemoteHidAction('volume_up', 'press', false)).toBeNull();
    expect(resolveRemoteHidAction('volume_down', 'press', false)).toBeNull();
  });

  it('返回切宽窄、TV 切书城、电源摸鱼，均在任意页面生效', () => {
    expect(resolveRemoteHidAction('back', 'press', true)).toBe('toggle-wide');
    expect(resolveRemoteHidAction('back', 'press', false)).toBe('toggle-wide');
    expect(resolveRemoteHidAction('tv', 'press', false)).toBe('switch-bookstore');
    expect(resolveRemoteHidAction('tv', 'press', true)).toBe('switch-bookstore');
    expect(resolveRemoteHidAction('power', 'press', false)).toBe('toggle-stealth');
  });

  it('release 与未映射按键返回 null', () => {
    expect(resolveRemoteHidAction('volume_up', 'release', true)).toBeNull();
    expect(resolveRemoteHidAction('back', 'release', false)).toBeNull();
    expect(resolveRemoteHidAction('power', 'release', false)).toBeNull();
    for (const button of ['voice', 'ok', 'left', 'menu', 'usage_0x99']) {
      expect(resolveRemoteHidAction(button, 'press', true)).toBeNull();
    }
  });
});

describe('subscribeRemoteHidButtons', () => {
  const hadTauri = typeof (window as any).__TAURI__ !== 'undefined';
  const tauri = (window as any).__TAURI__;
  let listeners: Map<string, (event: { payload: unknown }) => void>;

  beforeEach(() => {
    listeners = new Map();
    (window as any).__TAURI__ = {
      event: {
        listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
          listeners.set(event, handler);
          return () => {
            listeners.delete(event);
          };
        },
      },
    };
  });

  afterEach(() => {
    if (hadTauri) (window as any).__TAURI__ = tauri;
    else delete (window as any).__TAURI__;
  });

  it('转发 payload，取消后停止接收', async () => {
    const received: unknown[] = [];
    const dispose = subscribeRemoteHidButtons((event) => received.push(event));
    listeners.get('remote-hid-button')?.({
      payload: { button: 'power', phase: 'press', usage: 0x66 },
    });
    expect(received).toEqual([{ button: 'power', phase: 'press', usage: 0x66 }]);
    dispose();
    // unlisten 经 promise 微任务登记，先 flush 再断言
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listeners.has('remote-hid-button')).toBe(false);
  });

  it('注册完成前取消：迟到的 unlisten 被立即执行', async () => {
    let resolveListen!: (dispose: () => void) => void;
    const deferred = new Promise<() => void>((resolve) => {
      resolveListen = resolve;
    });
    (window as any).__TAURI__ = {
      event: { listen: async () => deferred },
    };
    let unlistenCalls = 0;
    const dispose = subscribeRemoteHidButtons(() => {});
    dispose();
    resolveListen(() => {
      unlistenCalls += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unlistenCalls).toBe(1);
  });
});
