/**
 * 书城切换浮层（macOS Cmd+Tab 语义）单测。
 *
 * 覆盖：状态机（idle/pending/visible）、循环高亮、repeat 忽略、松手提交、
 * 各类取消路径（Esc/blur/面板外点击/pending 中松手）、空列表、DOM 结构
 * （序号角标/图标兜底块/双主题 CSS/防回归断言）、destroy 全清理。
 */

import { describe, it, expect, afterEach } from 'bun:test';
import {
  BookstoreSwitcherController,
  BOOKSTORE_SWITCHER_ID,
  BOOKSTORE_SWITCHER_STYLE_ID,
  type BookstoreEntry,
  type BookstoreListModel,
  type BookstoreSwitcherHost,
} from '../bookstore_switcher';

const entry = (id: string, name: string, overrides: Partial<BookstoreEntry> = {}): BookstoreEntry => ({
  id,
  name,
  icon: null,
  index: 0,
  ...overrides,
});

const makeHost = (model: BookstoreListModel): BookstoreSwitcherHost & {
  state: { loadCalls: number; committed: BookstoreEntry[] };
} => {
  const state = { loadCalls: 0, committed: [] as BookstoreEntry[] };
  return {
    state,
    loadEntries: async () => {
      state.loadCalls += 1;
      return model;
    },
    commit: (committed: BookstoreEntry) => {
      state.committed.push(committed);
    },
  };
};

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

const pressKey = (type: 'keydown' | 'keyup', init: KeyboardEventInit): boolean =>
  window.dispatchEvent(new KeyboardEvent(type, init));

const cmdLDown = (init: Partial<KeyboardEventInit> = {}): boolean =>
  pressKey('keydown', { key: 'l', code: 'KeyL', metaKey: true, cancelable: true, ...init });

const modifierUp = (init: Partial<KeyboardEventInit> = {}): boolean =>
  pressKey('keyup', { key: 'Meta', metaKey: false, cancelable: true, ...init });

const root = (): HTMLElement | null => document.getElementById(BOOKSTORE_SWITCHER_ID);
const items = (): HTMLElement[] =>
  Array.from(document.querySelectorAll(`#${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-item`));
const activeIndex = (): number =>
  items().findIndex(item => item.classList.contains('wxrd-switcher-active'));

describe('BookstoreSwitcherController', () => {
  let controller: BookstoreSwitcherController | null = null;

  afterEach(() => {
    controller?.destroy();
    controller = null;
    document.getElementById(BOOKSTORE_SWITCHER_ID)?.remove();
    document.getElementById(BOOKSTORE_SWITCHER_STYLE_ID)?.remove();
  });

  const boot = (model: BookstoreListModel): ReturnType<typeof makeHost> => {
    const host = makeHost(model);
    controller = new BookstoreSwitcherController(host);
    return host;
  };

  it('首次按住 Cmd+L 显示面板并高亮「当前站点的下一个」', async () => {
    const host = boot({
      entries: [
        entry('weread', '微信读书', { index: 1 }),
        entry('fanqie', '番茄小说', { index: 2 }),
        entry('qidian', '起点读书', { index: 3 }),
      ],
      currentIndex: 0,
    });
    // preventDefault 生效时 dispatchEvent 返回 false
    expect(cmdLDown()).toBe(false);
    await flush();
    expect(host.state.loadCalls).toBe(1);
    expect(root()).not.toBeNull();
    expect(root()?.classList.contains('wxrd-switcher-shown')).toBe(true);
    expect(activeIndex()).toBe(1);
  });

  it('无当前站（currentIndex=-1）时首按高亮第一项', async () => {
    boot({
      entries: [entry('weread', '微信读书', { index: 1 }), entry('fanqie', '番茄', { index: 2 })],
      currentIndex: -1,
    });
    cmdLDown();
    await flush();
    expect(activeIndex()).toBe(0);
  });

  it('按住期间反复按 L 循环前进并环绕', async () => {
    boot({
      entries: [
        entry('a', '甲', { index: 1 }),
        entry('b', '乙', { index: 2 }),
        entry('c', '丙', { index: 3 }),
      ],
      currentIndex: -1,
    });
    cmdLDown();
    await flush();
    cmdLDown();
    cmdLDown();
    expect(activeIndex()).toBe(2);
    cmdLDown();
    expect(activeIndex()).toBe(0);
  });

  it('OS 自动重复（e.repeat）不推进高亮', async () => {
    boot({
      entries: [
        entry('a', '甲', { index: 1 }),
        entry('b', '乙', { index: 2 }),
        entry('c', '丙', { index: 3 }),
      ],
      currentIndex: -1,
    });
    cmdLDown();
    await flush();
    // 初次按下高亮 0；重复事件若被误处理会推进到 2
    cmdLDown({ repeat: true });
    cmdLDown({ repeat: true });
    expect(activeIndex()).toBe(0);
  });

  it('pending 期间再按 L：就绪后一次性前进对应次数', async () => {
    boot({
      entries: [
        entry('a', '甲', { index: 1 }),
        entry('b', '乙', { index: 2 }),
        entry('c', '丙', { index: 3 }),
      ],
      currentIndex: 0,
    });
    cmdLDown();
    cmdLDown();
    await flush();
    expect(activeIndex()).toBe(2);
  });

  it('松开修饰键提交高亮书城并隐藏面板', async () => {
    const host = boot({
      entries: [
        entry('weread', '微信读书', { index: 1 }),
        entry('fanqie', '番茄小说', { index: 2 }),
      ],
      currentIndex: 0,
    });
    cmdLDown();
    await flush();
    modifierUp();
    expect(host.state.committed).toEqual([entry('fanqie', '番茄小说', { index: 2 })]);
    expect(root()?.classList.contains('wxrd-switcher-shown')).toBe(false);
  });

  it('按住期间 L 的 keyup 不提交（修饰键未松）', async () => {
    const host = boot({
      entries: [entry('a', '甲', { index: 1 })],
      currentIndex: -1,
    });
    cmdLDown();
    await flush();
    pressKey('keyup', { key: 'l', code: 'KeyL', metaKey: true, cancelable: true });
    expect(host.state.committed).toHaveLength(0);
    expect(root()?.classList.contains('wxrd-switcher-shown')).toBe(true);
  });

  it('Escape 取消不提交', async () => {
    const host = boot({
      entries: [entry('a', '甲', { index: 1 }), entry('b', '乙', { index: 2 })],
      currentIndex: -1,
    });
    cmdLDown();
    await flush();
    pressKey('keydown', { key: 'Escape', cancelable: true });
    expect(host.state.committed).toHaveLength(0);
    expect(root()?.classList.contains('wxrd-switcher-shown')).toBe(false);
  });

  it('window blur 取消不提交（防 keyup 丢失滞留）', async () => {
    const host = boot({
      entries: [entry('a', '甲', { index: 1 })],
      currentIndex: -1,
    });
    cmdLDown();
    await flush();
    window.dispatchEvent(new Event('blur'));
    expect(host.state.committed).toHaveLength(0);
    expect(root()?.classList.contains('wxrd-switcher-shown')).toBe(false);
  });

  it('pending 中松手：不闪面板，迟到的列表被丢弃', async () => {
    const host = boot({
      entries: [entry('a', '甲', { index: 1 })],
      currentIndex: -1,
    });
    cmdLDown();
    modifierUp();
    await flush();
    expect(host.state.committed).toHaveLength(0);
    expect(root()).toBeNull();
  });

  it('空列表不显示面板', async () => {
    const host = boot({ entries: [], currentIndex: -1 });
    cmdLDown();
    await flush();
    expect(host.state.loadCalls).toBe(1);
    expect(root()).toBeNull();
  });

  it('点击面板外取消；点击条目立即提交', async () => {
    const host = boot({
      entries: [
        entry('a', '甲', { index: 1 }),
        entry('b', '乙', { index: 2 }),
        entry('c', '丙', { index: 3 }),
      ],
      currentIndex: -1,
    });
    cmdLDown();
    await flush();

    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(root()?.classList.contains('wxrd-switcher-shown')).toBe(false);
    expect(host.state.committed).toHaveLength(0);

    cmdLDown();
    await flush();
    const target = items()[2];
    target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(root()?.classList.contains('wxrd-switcher-shown')).toBe(true);
    target.click();
    expect(host.state.committed.map(entry => entry.id)).toEqual(['c']);
  });

  it('序号角标只渲染前 7 项', async () => {
    const entries = ['一', '二', '三', '四', '五', '六', '七', '八', '九'].map((name, i) =>
      entry(`site-${i}`, name, { index: i + 1 }),
    );
    boot({ entries, currentIndex: -1 });
    cmdLDown();
    await flush();
    const badges = Array.from(document.querySelectorAll(`#${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-badge`));
    expect(badges).toHaveLength(7);
    expect(badges[6].textContent).toBe('7');
  });

  it('图标存在渲染 img，缺失渲染首字母兜底块；当前站有描边标记', async () => {
    boot({
      entries: [
        entry('weread', '微信读书', { index: 1, icon: null }),
        entry('fanqie', '番茄小说', { index: 2, icon: 'data:image/png;base64,abc' }),
      ],
      currentIndex: 0,
    });
    cmdLDown();
    await flush();
    const fallback = document.querySelector(
      `#${BOOKSTORE_SWITCHER_ID} .wxrd-switcher-icon-fallback`,
    );
    expect(fallback?.textContent).toBe('微');
    const img = document.querySelector<HTMLImageElement>(
      `#${BOOKSTORE_SWITCHER_ID} img.wxrd-switcher-icon`,
    );
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,abc');
    const firstItem = items()[0];
    expect(firstItem.classList.contains('wxrd-switcher-current')).toBe(true);
    expect(firstItem.querySelector('.wxrd-switcher-badge')?.textContent).toBe('1');
  });

  it('样式双主题齐备：明暗两套变量 + 毛玻璃 -webkit- 前缀防回归', async () => {
    boot({ entries: [entry('a', '甲', { index: 1 })], currentIndex: -1 });
    cmdLDown();
    await flush();
    const css = document.getElementById(BOOKSTORE_SWITCHER_STYLE_ID)?.textContent ?? '';
    expect((css.match(/--panel-bg:/g) ?? []).length).toBe(2);
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain('-webkit-backdrop-filter');
    expect(css).toContain('z-index: 2147483647');
  });

  it('destroy 后按键不再响应，DOM 与样式全部移除', async () => {
    const host = boot({ entries: [entry('a', '甲', { index: 1 })], currentIndex: -1 });
    cmdLDown();
    await flush();
    expect(root()).not.toBeNull();
    controller?.destroy();
    controller = null;
    expect(root()).toBeNull();
    expect(document.getElementById(BOOKSTORE_SWITCHER_STYLE_ID)).toBeNull();
    cmdLDown();
    await flush();
    expect(host.state.loadCalls).toBe(1);
    expect(root()).toBeNull();
  });

  it('遥控器长按：打开浮层高亮下一个，轮播前进，松手提交当前高亮', async () => {
    const host = boot({
      entries: [
        entry('a', '甲', { index: 1 }),
        entry('b', '乙', { index: 2 }),
        entry('c', '丙', { index: 3 }),
      ],
      currentIndex: 0,
    });
    controller?.startRemoteCycle();
    await flush();
    expect(host.state.loadCalls).toBe(1);
    expect(controller?.isVisible).toBe(true);
    expect(activeIndex()).toBe(1);
    controller?.advanceRemote();
    expect(activeIndex()).toBe(2);
    controller?.commitRemote();
    expect(host.state.committed.map((item) => item.id)).toEqual(['c']);
    expect(root()?.classList.contains('wxrd-switcher-shown')).toBe(false);
  });

  it('遥控器在列表就绪前松手：取消 pending，不提交', async () => {
    const host = boot({ entries: [entry('a', '甲', { index: 1 })], currentIndex: -1 });
    controller?.startRemoteCycle();
    controller?.commitRemote();
    await flush();
    expect(controller?.isPending).toBe(false);
    expect(controller?.isVisible).toBe(false);
    expect(host.state.committed).toEqual([]);
    expect(root()).toBeNull();
  });
});
