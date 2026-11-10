/**
 * 书城切换浮层的 Manager 薄壳：把 IPC 命令注入纯控制器
 * （get_bookstore_list 取有序列表，switch_bookstore_by_index 落地切换）。
 * 远程站点页与本地阅读页共用 AppRuntime，注册一次双端生效。
 *
 * 遥控器 TV 键：短按切下一个书城；按住 0.5 秒打开浮层并高亮下一个，
 * 之后每 0.5 秒前进一项，松开提交当前高亮（Cmd+Tab 语义）。
 */

import { BaseManager } from '../core/base_manager';
import {
  BookstoreSwitcherController,
  type BookstoreEntry,
  type BookstoreListModel,
} from '../core/bookstore_switcher';
import { subscribeRemoteHidButtons, type RemoteHidButtonEvent } from '../core/remote_hid_source';
import { showSiteSwitchLoading, startupWindowFromGlobal } from '../core/site_switch_loading';
import { invoke } from '../core/tauri';

interface BookstoreListItemPayload {
  id: string;
  name: string;
  icon: string | null;
  index: number;
  current: boolean;
}

/** 按住这么久才打开浮层。 */
const TV_HOLD_MS = 500;
/** 浮层打开后每 0.5 秒前进一项。 */
const TV_ADVANCE_MS = 500;

export class BookstoreSwitcherManager extends BaseManager {
  private controller: BookstoreSwitcherController;
  private readonly commitEntry: (entry: BookstoreEntry) => void;
  private remoteUnlisten: (() => void) | null = null;
  private tvHoldTimer: number | null = null;
  private tvAdvanceTimer: number | null = null;
  /** 本次 TV 按住是否已进入浮层轮播（用于区分短按/已取消）。 */
  private tvCycleActive = false;
  /** 最近一次列表里「当前站」的下标（0-based，-1 = 无当前站）。 */
  private lastCurrentIndex = -1;
  /** 最近一次列表里「当前站」的 id：同站提交（松手停在原地）必须短路，
   * 否则会给 Rust 侧发一次无效切换，预铺的 sticky 过场层无人接管。
   * 不能用序号算术（entry.index - 1）判同站：本地书城序号为 0 会错位。 */
  private lastCurrentId: string | null = null;

  constructor() {
    super();
    // 切换前预铺过场层前必须用它短路同站提交：switch_to_site 对同站直接
    // return，不发生导航——预铺的 sticky 过场没有新文档来接管，只能不铺。
    // 同站判等按 id：序号算术（entry.index - 1）在本地书城（序号 0）加入后
    // 会错位，把「本地→微信读书」误判为同站而吞掉切换。
    this.commitEntry = (entry) => {
      if (this.lastCurrentId !== null && entry.id === this.lastCurrentId) return;
      // 启动窗口期内不预铺过场（与 documentStart 侧判定一致，避免
      // 预铺了过场而新文档不铺的半截状态）
      if (startupWindowFromGlobal()) {
        invoke('switch_bookstore_by_index', { index: entry.index }).catch(() => undefined);
        return;
      }
      // 松手即铺过场：赶在导航延迟之前，旧页面带着过场进入跳转
      showSiteSwitchLoading(document, { sticky: true });
      invoke('switch_bookstore_by_index', { index: entry.index }).catch(() => undefined);
    };
    this.controller = new BookstoreSwitcherController(
      {
        loadEntries: async (): Promise<BookstoreListModel> => {
          const list = await this.fetchList();
          this.lastCurrentIndex = list.findIndex((item) => item.current);
          this.lastCurrentId = this.lastCurrentIndex >= 0
            ? (list[this.lastCurrentIndex]?.id ?? null)
            : null;
          return {
            entries: list.map((item) => this.toEntry(item)),
            currentIndex: this.lastCurrentIndex,
          };
        },
        commit: (entry) => this.commitEntry(entry),
      },
      document,
      navigator.userAgent.includes('Windows'),
    );
    this.remoteUnlisten = subscribeRemoteHidButtons((event) => this.onRemoteHidButton(event));
  }

  destroy(): void {
    this.clearTvTimers();
    this.remoteUnlisten?.();
    this.remoteUnlisten = null;
    this.controller.destroy();
    super.destroy();
  }

  private async fetchList(): Promise<BookstoreListItemPayload[]> {
    const items = await invoke<BookstoreListItemPayload[]>('get_bookstore_list');
    return Array.isArray(items) ? items : [];
  }

  private toEntry(item: BookstoreListItemPayload): BookstoreEntry {
    return { id: item.id, name: item.name, icon: item.icon ?? null, index: item.index };
  }

  private onRemoteHidButton(event: RemoteHidButtonEvent): void {
    if (event.button !== 'tv') return;
    if (event.phase === 'press') {
      this.clearTvTimers();
      this.tvCycleActive = false;
      this.tvHoldTimer = window.setTimeout(() => {
        this.tvHoldTimer = null;
        this.tvCycleActive = true;
        this.controller.startRemoteCycle();
        this.tvAdvanceTimer = window.setInterval(
          () => this.controller.advanceRemote(),
          TV_ADVANCE_MS,
        );
      }, TV_HOLD_MS);
      return;
    }
    const wasCycle = this.tvCycleActive;
    this.clearTvTimers();
    this.tvCycleActive = false;
    if (!wasCycle) {
      // 短按：保持原来的「切下一个书城」。
      void this.switchToNext();
      return;
    }
    if (this.controller.isVisible) {
      this.controller.commitRemote();
      return;
    }
    if (this.controller.isPending) {
      // 已按住超过阈值但列表还没就绪就松手：退化为短按切下一个。
      this.controller.cancelRemote();
      void this.switchToNext();
    }
    // 浮层已被 Esc / 点击面板外取消：尊重取消，不再切换。
  }

  /** 短按 TV：循环切到下一个书城（与浮层提交同一路径）。 */
  private async switchToNext(): Promise<void> {
    try {
      const list = await this.fetchList();
      if (list.length === 0) return;
      this.lastCurrentIndex = list.findIndex((item) => item.current);
      this.lastCurrentId = this.lastCurrentIndex >= 0
        ? (list[this.lastCurrentIndex]?.id ?? null)
        : null;
      const nextIndex = this.lastCurrentIndex < 0 ? 0 : (this.lastCurrentIndex + 1) % list.length;
      const target = list[nextIndex];
      if (target) this.commitEntry(this.toEntry(target));
    } catch {
      // 列表读取失败时保持当前站点，不打断阅读。
    }
  }

  private clearTvTimers(): void {
    if (this.tvHoldTimer !== null) {
      window.clearTimeout(this.tvHoldTimer);
      this.tvHoldTimer = null;
    }
    if (this.tvAdvanceTimer !== null) {
      window.clearInterval(this.tvAdvanceTimer);
      this.tvAdvanceTimer = null;
    }
  }
}
