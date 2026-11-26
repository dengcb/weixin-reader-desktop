import WeReadPlugin from '../../../../plugins/weread';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventBus, Events } from '../event_bus';

const getBookProgress = mock(async (): Promise<{ progress?: number } | null> => ({ progress: 42 }));
const fakeSiteContext = {
  isReaderPage: true,
  siteId: 'weread',
  currentRuntime: { getBookProgress, getProgressPanel: WeReadPlugin.prototype.getProgressPanel, getProgressInset: WeReadPlugin.prototype.getProgressInset },
};
let showReadingPercent = true;
const subscribers: Array<() => void> = [];
const fakeSettingsStore = {
  getGlobal: () => ({ showReadingPercent }),
  getSite: () => ({ readerWide: true }),
  subscribe: (cb: () => void) => {
    subscribers.push(cb);
    return () => {};
  },
};

mock.module('../site_context', () => ({
  createSiteContext: () => fakeSiteContext,
  SiteContext: class {},
}));
mock.module('../settings_store', () => ({ settingsStore: fakeSettingsStore }));

const { ReadingPercentManager } = await import('../../managers/reading_percent_manager');

const flush = () => Bun.sleep(20);
const toggle = (value: boolean) => {
  showReadingPercent = value;
  subscribers.forEach(cb => cb());
};

describe('ReadingPercentManager 徽章生命周期', () => {
  let manager: InstanceType<typeof ReadingPercentManager> | null = null;

  beforeEach(() => {
    EventBus.clearHistory();
    subscribers.length = 0;
    showReadingPercent = true;
    fakeSiteContext.isReaderPage = true;
    fakeSiteContext.siteId = 'weread';
    getBookProgress.mockImplementation(async () => ({ progress: 42 }));
    document.body.innerHTML = '<div class="renderTargetContainer"></div>';
    const panel = document.querySelector('.renderTargetContainer') as HTMLElement;
    panel.getBoundingClientRect = () => ({ left: 30, top: 73, width: 1452, height: 784, right: 1482, bottom: 857, x: 30, y: 73, toJSON: () => ({}) }) as DOMRect;
  });

  afterEach(() => {
    manager?.destroy();
    manager = null;
    EventBus.clearHistory();
    document.body.innerHTML = '';
  });

  it('开关开且在阅读页：正文面板右上渲染百分比徽章', async () => {
    manager = new ReadingPercentManager();
    await flush();
    const badge = document.getElementById('wxrd-reading-percent');
    expect(badge?.textContent).toBe('42%');
    expect(badge?.parentElement?.className).toBe('renderTargetContainer');
  });

  it('关闭开关移除徽章', async () => {
    manager = new ReadingPercentManager();
    await flush();
    expect(document.getElementById('wxrd-reading-percent')).not.toBeNull();
    toggle(false);
    expect(document.getElementById('wxrd-reading-percent')).toBeNull();
  });

  it('离开阅读页移除徽章', async () => {
    manager = new ReadingPercentManager();
    await flush();
    EventBus.emit(Events.ROUTE_CHANGED, { isReader: false, url: '/', pathname: '/' });
    expect(document.getElementById('wxrd-reading-percent')).toBeNull();
  });

  it('进度事件刷新徽章数值', async () => {
    manager = new ReadingPercentManager();
    await flush();
    getBookProgress.mockImplementation(async () => ({ progress: 73 }));
    EventBus.emit(Events.PROGRESS_UPDATED, { progress: 73 });
    await Bun.sleep(350);
    expect(document.getElementById('wxrd-reading-percent')?.textContent).toBe('73%');
  });

  it('getBookProgress 无比例时不渲染', async () => {
    getBookProgress.mockImplementation(async () => null);
    manager = new ReadingPercentManager();
    await flush();
    expect(document.getElementById('wxrd-reading-percent')).toBeNull();
  });

  it('本地站点挂顶栏右端', async () => {
    fakeSiteContext.siteId = 'local';
    document.body.innerHTML = '<header class="local-navbar"></header>';
    manager = new ReadingPercentManager();
    await flush();
    const badge = document.getElementById('wxrd-reading-percent');
    expect(badge?.parentElement?.className).toBe('local-navbar');
  });

  it('destroy 移除徽章', async () => {
    manager = new ReadingPercentManager();
    await flush();
    manager.destroy();
    manager = null;
    expect(document.getElementById('wxrd-reading-percent')).toBeNull();
  });
});