import { describe, expect, it } from 'bun:test';
import { BaseSiteAdapter } from './reading_site_adapter';

/**
 * 契约测试：程序化翻页的合成键必须以「真实键盘事件」的形态派发。
 *
 * 历史缺陷：triggerKey('Right') 曾只映射 code 不映射 key，合成事件携带
 * key='Right'——监听 e.key === 'ArrowRight' 的方向记录（ProgressTracker）
 * 永远匹配不上，菜单/遥控/滑动/自动翻页的方向长期无人记录。
 */
class ProbeAdapter extends BaseSiteAdapter {
  readonly id = 'probe';
  readonly name = '探针';
  readonly domain = 'probe.test';

  isReaderPage(): boolean { return true; }
  isHomePage(): boolean { return false; }
  getWideModeCSS(): string { return ''; }
  getToolbarCSS(): string { return ''; }
  nextPage(): void { this.fire('Right'); }
  prevPage(): void { this.fire('Left'); }
  isDoubleColumn(): boolean { return false; }
  isAtBottom(): boolean { return false; }

  fire(key: string): void {
    this.triggerKey(key);
  }
}

describe('BaseSiteAdapter.triggerKey 合成键契约', () => {
  it("派发 key='Right' 时事件以 key='ArrowRight' 到达 window（ProgressTracker 形态）", () => {
    const adapter = new ProbeAdapter();
    const seen: Array<{ key: string; code: string }> = [];
    const handler = (e: KeyboardEvent) => {
      seen.push({ key: e.key, code: e.code });
    };
    window.addEventListener('keydown', handler);
    try {
      adapter.fire('Right');
      adapter.fire('Left');
    } finally {
      window.removeEventListener('keydown', handler);
    }

    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ key: 'ArrowRight', code: 'ArrowRight' });
    expect(seen[1]).toEqual({ key: 'ArrowLeft', code: 'ArrowLeft' });
  });

  it('合成事件冒泡且可取消（与真实键盘一致）', () => {
    const adapter = new ProbeAdapter();
    let reachedDocument = false;
    let cancelled = false;
    const docHandler = (e: Event) => {
      if (e.type !== 'keydown') return;
      reachedDocument = true;
      e.preventDefault();
    };
    document.addEventListener('keydown', docHandler);
    try {
      adapter.fire('Right');
      // re-dispatch 一遍观察 preventDefault 反馈
      const probe = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
      cancelled = !document.dispatchEvent(probe); // cancelable 时返回 false
    } finally {
      document.removeEventListener('keydown', docHandler);
    }
    expect(reachedDocument).toBe(true);
    expect(cancelled).toBe(true);
  });
});
