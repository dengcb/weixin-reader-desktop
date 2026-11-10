/**
 * 本地裸页（默认页 / 本地书架）的书城切换。
 *
 * 这些页面不跑注入运行时（AppRuntime 只装配在远程页与本地阅读页），
 * 此处直接装配纯控制器并补齐两条入口：
 * - ⌘/Ctrl+L 浮层：BookstoreSwitcherController 自带呼出/轮播/取消键处理；
 * - 遥控器 TV 键：短按切下一个书城；长按 0.5s 呼出浮层轮播（每 0.5s 前进
 *   一项），松手提交——与注入页 BookstoreSwitcherManager 同语义。
 */

import {
  BookstoreSwitcherController,
  type BookstoreEntry,
  type BookstoreListModel,
} from './core/bookstore_switcher';
import { subscribeRemoteHidButtons } from './core/remote_hid_source';
import { showSiteSwitchLoading } from './core/site_switch_loading';
import { invoke } from './core/tauri';

interface BookstoreListItemPayload {
  id: string;
  name: string;
  icon: string | null;
  index: number;
  current: boolean;
}

/** 按住这么久才打开浮层（与注入页 TV_HOLD_MS 一致）。 */
const TV_HOLD_MS = 500;
/** 浮层打开后每 0.5 秒前进一项。 */
const TV_ADVANCE_MS = 500;

// 当前站 id：松手停在原地时短路提交——Rust 侧同站无导航，预铺的 sticky
// 过场层会永远挂在页面上（同站判等必须按 id，序号 0 的本地会错位）。
let currentId: string | null = null;

const toEntry = (item: BookstoreListItemPayload): BookstoreEntry => ({
  id: item.id,
  name: item.name,
  icon: item.icon ?? null,
  index: item.index,
});

const fetchList = async (): Promise<BookstoreListItemPayload[]> => {
  const list = await invoke<BookstoreListItemPayload[]>('get_bookstore_list');
  return Array.isArray(list) ? list : [];
};

const commitEntry = (entry: BookstoreEntry): void => {
  if (currentId !== null && entry.id === currentId) return;
  // 松手即铺过场：旧页面带着过场进入跳转（与注入页的 Manager 同语义）
  showSiteSwitchLoading(document, { sticky: true });
  invoke('switch_bookstore_by_index', { index: entry.index }).catch(() => undefined);
};

const controller = new BookstoreSwitcherController(
  {
    loadEntries: async (): Promise<BookstoreListModel> => {
      const items = await fetchList();
      const currentIndex = items.findIndex(item => item.current);
      currentId = currentIndex >= 0 ? (items[currentIndex]?.id ?? null) : null;
      return {
        entries: items.map(toEntry),
        currentIndex,
      };
    },
    commit: commitEntry,
  },
  document,
  navigator.userAgent.includes('Windows'),
);

/** 短按 TV：循环切到下一个书城（与浮层提交同一路径）。 */
const switchToNext = async (): Promise<void> => {
  try {
    const items = await fetchList();
    if (items.length === 0) return;
    const currentIndex = items.findIndex(item => item.current);
    currentId = currentIndex >= 0 ? (items[currentIndex]?.id ?? null) : null;
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    const target = items[nextIndex];
    if (target) commitEntry(toEntry(target));
  } catch {
    // 列表读取失败时保持当前站点，不打断使用。
  }
};

// 遥控器 TV 键长短按：Cmd+Tab 语义（长按呼出轮播、松手提交；短按切下一个）
let tvHoldTimer: ReturnType<typeof setTimeout> | null = null;
let tvAdvanceTimer: ReturnType<typeof setInterval> | null = null;
let tvCycleActive = false;

const clearTvTimers = (): void => {
  if (tvHoldTimer !== null) {
    clearTimeout(tvHoldTimer);
    tvHoldTimer = null;
  }
  if (tvAdvanceTimer !== null) {
    clearInterval(tvAdvanceTimer);
    tvAdvanceTimer = null;
  }
};

subscribeRemoteHidButtons(event => {
  if (event.button !== 'tv') return;
  if (event.phase === 'press') {
    clearTvTimers();
    tvCycleActive = false;
    tvHoldTimer = setTimeout(() => {
      tvHoldTimer = null;
      tvCycleActive = true;
      controller.startRemoteCycle();
      tvAdvanceTimer = setInterval(() => controller.advanceRemote(), TV_ADVANCE_MS);
    }, TV_HOLD_MS);
    return;
  }
  const wasCycle = tvCycleActive;
  clearTvTimers();
  tvCycleActive = false;
  if (!wasCycle) {
    void switchToNext();
    return;
  }
  if (controller.isVisible) {
    controller.commitRemote();
    return;
  }
  if (controller.isPending) {
    controller.cancelRemote();
    void switchToNext();
  }
  // 浮层已被 Esc / 点击面板外取消：尊重取消，不再切换。
});
