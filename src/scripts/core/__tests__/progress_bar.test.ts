import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { EventBus, Events } from '../event_bus';
import type { SiteContext } from '../site_context';
import { ProgressBar } from '../../managers/turner/progress_bar';

const siteContext = {} as SiteContext;

describe('ProgressBar lifecycle', () => {
  let progressBar: ProgressBar | null = null;

  beforeEach(() => {
    EventBus.clearHistory();
    document.body.innerHTML = '<div class="renderTargetContainer"></div>';
  });

  afterEach(() => {
    progressBar?.destroy();
    progressBar = null;
    EventBus.clearHistory();
    document.body.innerHTML = '';
  });

  it('uses the latest historical progress on first render', () => {
    EventBus.emit(Events.PROGRESS_UPDATED, { progress: 37 });
    progressBar = new ProgressBar(siteContext);
    progressBar.setVisibility(true);

    expect(document.getElementById('wxrd-progress-bar')?.style.width).toBe('37%');
  });

  it('updates, hides, and shows without duplicating the container', () => {
    progressBar = new ProgressBar(siteContext);
    progressBar.setVisibility(true);
    EventBus.emit(Events.PROGRESS_UPDATED, { progress: 62.5 });

    expect(document.getElementById('wxrd-progress-bar')?.style.width).toBe('62.5%');
    expect(document.querySelectorAll('#wxrd-progress-bar-container')).toHaveLength(1);

    progressBar.setVisibility(false);
    expect(document.getElementById('wxrd-progress-bar-container')).toBeNull();
    progressBar.setVisibility(true);
    expect(document.querySelectorAll('#wxrd-progress-bar-container')).toHaveLength(1);
  });

  it('recreates DOM removed by the host page with the newest value', () => {
    progressBar = new ProgressBar(siteContext);
    progressBar.setVisibility(true);
    EventBus.emit(Events.PROGRESS_UPDATED, { progress: 10 });
    document.getElementById('wxrd-progress-bar-container')?.remove();

    EventBus.emit(Events.PROGRESS_UPDATED, { progress: 81 });
    expect(document.getElementById('wxrd-progress-bar')?.style.width).toBe('81%');
  });

  it('容器晚到时自愈：置位等待并在容器出现后补建（不再卡死 isVisible=false）', async () => {
    document.body.innerHTML = '';
    progressBar = new ProgressBar(siteContext);
    progressBar.setVisibility(true);
    // 旧实现的缺陷：容器缺失时提前返回，isVisible 恒 false，之后任何
    // PROGRESS_UPDATED / CHAPTER_CHANGED / setVisibility(true) 都无法再触发创建。
    expect(document.getElementById('wxrd-progress-bar-container')).toBeNull();

    // 容器在 250ms 后才由宿主渲染出来：重试轮询应自动补建
    await Bun.sleep(120);
    document.body.innerHTML = '<div class="renderTargetContainer"></div>';
    await Bun.sleep(320);
    expect(document.getElementById('wxrd-progress-bar-container')).not.toBeNull();
  });

  it('渲染层夹取：负百分比与超界百分比写入合法 CSS 宽度', () => {
    progressBar = new ProgressBar(siteContext);
    progressBar.setVisibility(true);
    EventBus.emit(Events.PROGRESS_UPDATED, { progress: 10 });
    EventBus.emit(Events.PROGRESS_UPDATED, { progress: -25 });
    expect(document.getElementById('wxrd-progress-bar')?.style.width).toBe('0%');
    EventBus.emit(Events.PROGRESS_UPDATED, { progress: 130 });
    expect(document.getElementById('wxrd-progress-bar')?.style.width).toBe('100%');
  });

  it('recreates the bar after chapter DOM replacement and cancels that work on destroy', async () => {
    progressBar = new ProgressBar(siteContext);
    progressBar.setVisibility(true);
    document.getElementById('wxrd-progress-bar-container')?.remove();
    EventBus.emit(Events.CHAPTER_CHANGED, {});
    await Bun.sleep(230);
    expect(document.getElementById('wxrd-progress-bar-container')).not.toBeNull();

    document.getElementById('wxrd-progress-bar-container')?.remove();
    EventBus.emit(Events.CHAPTER_CHANGED, {});
    progressBar.destroy();
    progressBar = null;
    await Bun.sleep(230);
    expect(document.getElementById('wxrd-progress-bar-container')).toBeNull();
  });
});
