/**
 * ProgressBar - 在双栏模式且隐藏导航栏时显示阅读进度条 (Refactored with EventBus)
 */

import { BaseManager, Events } from '../../core/base_manager';
import { SiteContext } from '../../core/site_context';
import { log } from '../../core/logger';

export class ProgressBar extends BaseManager {
  private progressBarElement: HTMLElement | null = null;
  private isVisible = false;
  private latestProgress: number = 0;  // 缓存最新进度值
  private chapterTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(siteContext: SiteContext) {
    super();
    void siteContext;
    this.init();
  }

  private init() {
    // 使用 onWithHistory 监听进度更新事件
    // 移除条件检查，总是更新 latestProgress
    this.onWithHistory(Events.PROGRESS_UPDATED, (data: { progress: number }) => {
      this.latestProgress = data.progress;

      // 如果进度条应该显示，检查 DOM 是否存在
      if (this.isVisible) {
        const existsInDom = document.getElementById('wxrd-progress-bar-container');

        if (!existsInDom) {
          // DOM 不存在，重新创建
          this.progressBarElement = null;
          this.show();
        } else if (this.progressBarElement) {
          // DOM 存在且有引用，直接更新。
          // 倒读时 turningPages 可为负（tracker 有意不夹取），负百分比是非法
          // CSS 值会被 CSSOM 丢弃、条宽停留旧值；渲染层夹取到 0..100。
          const bounded = Math.min(100, Math.max(0, data.progress));
          this.progressBarElement.style.width = `${bounded}%`;
        }
      }
    });

    // 监听章节切换事件，延迟重新创建进度条
    // 因为微信读书会重新渲染 DOM，需要等待渲染完成
    this.on(Events.CHAPTER_CHANGED, () => {
      if (this.isVisible) {
        // 延迟重建，等待微信读书 DOM 渲染完成
        this.chapterTimer = setTimeout(() => {
          this.chapterTimer = null;
          if (this.isDestroyed()) return;
          if (!document.getElementById('wxrd-progress-bar-container')) {
            this.show();
          }
        }, 200);
      }
    });
  }

  /**
   * 显示或隐藏进度条
   */
  public setVisibility(shouldShow: boolean) {
    if (shouldShow && !this.isVisible) {
      this.show();
    } else if (!shouldShow && this.isVisible) {
      this.hide();
    }
  }

  private show() {
    const container = document.querySelector('.renderTargetContainer');
    if (!container) {
      // 章节加载动画期间容器尚未渲染：若就此返回，isVisible 仍是 false，
      // 后续 PROGRESS_UPDATED / CHAPTER_CHANGED 都以 isVisible 为前置，
      // 进度条从此不再创建（直到下一次设置变更）。此处先置位并登记一次
      // 容器等待重试。
      this.isVisible = true;
      this.scheduleContainerRetry();
      return;
    }

    this.buildInto(container);
    this.isVisible = true;

    log.info(`[ProgressBar] Progress bar shown with ${this.latestProgress}% progress`);
  }

  /**
   * 容器晚于 setVisibility(true) 出现时的补救：轮询几次，容器就绪即补建。
   * 仅在已请求显示且 DOM 尚无容器时运行；hide()/destroy() 会取消。
   */
  private scheduleContainerRetry() {
    if (this.chapterTimer) return;
    let attempts = 0;
    const poll = () => {
      if (this.isDestroyed() || !this.isVisible) return;
      if (document.getElementById('wxrd-progress-bar-container')) return;
      const container = document.querySelector('.renderTargetContainer');
      if (container) {
        this.buildInto(container);
        return;
      }
      if (++attempts >= 25) return; // ~5s 后放弃，等章节事件兜底
      this.chapterTimer = setTimeout(() => {
        this.chapterTimer = null;
        poll();
      }, 200);
    };
    poll();
  }

  /** 拆出 show() 的容器填充段，供初次 show 与容器重试共用。 */
  private buildInto(container: Element) {
    const existingContainer = document.getElementById('wxrd-progress-bar-container');
    if (existingContainer) {
      existingContainer.remove();
    }
    this.progressBarElement = null;

    const progressContainer = document.createElement('div');
    progressContainer.id = 'wxrd-progress-bar-container';
    progressContainer.style.cssText = `
      position: absolute;
      bottom: 0;
      left: 0;
      width: 100%;
      height: 16px;
      background-color: rgba(0, 0, 0, 0.05);
      overflow: hidden;
      border-bottom-left-radius: 12px;
      border-bottom-right-radius: 12px;
      z-index: 9999;
    `;

    const progressBar = document.createElement('div');
    progressBar.id = 'wxrd-progress-bar';
    progressBar.style.cssText = `
      height: 100%;
      width: ${Math.min(100, Math.max(0, this.latestProgress))}%;
      background-color: #349f66;
      transition: width 0.3s ease;
    `;

    progressContainer.appendChild(progressBar);
    container.appendChild(progressContainer);

    this.progressBarElement = progressBar;
  }

  private hide() {
    const container = document.querySelector('#wxrd-progress-bar-container');
    if (container) {
      container.remove();
    }

    this.progressBarElement = null;
    this.isVisible = false;

    log.info('[ProgressBar] Progress bar hidden');
  }

  destroy(): void {
    if (this.chapterTimer) clearTimeout(this.chapterTimer);
    this.chapterTimer = null;
    this.hide();
    super.destroy();
  }
}
