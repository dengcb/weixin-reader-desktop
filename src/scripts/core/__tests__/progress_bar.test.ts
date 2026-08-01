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

  it('waits for a missing render target instead of marking itself visible', () => {
    document.body.innerHTML = '';
    progressBar = new ProgressBar(siteContext);
    progressBar.setVisibility(true);
    expect(document.getElementById('wxrd-progress-bar-container')).toBeNull();

    document.body.innerHTML = '<div class="renderTargetContainer"></div>';
    progressBar.setVisibility(true);
    expect(document.getElementById('wxrd-progress-bar-container')).not.toBeNull();
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
