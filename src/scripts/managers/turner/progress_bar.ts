/**
 * ProgressBar - 在双栏模式且隐藏导航栏时显示阅读进度条 (Refactored with EventBus)
 */

import { BaseManager, Events } from '../../core/base_manager';
import { SiteContext } from '../../core/site_context';
import { log } from '../../core/logger';

export class ProgressBar extends BaseManager {
  private siteContext: SiteContext;
  private progressBarElement: HTMLElement | null = null;
  private isVisible = false;
  private latestProgress: number = 0;  // 缓存最新进度值

  constructor(siteContext: SiteContext) {
    super();
    this.siteContext = siteContext;
    this.init();
  }

  private init() {
    console.log('[ProgressBar] Initializing, subscribing to PROGRESS_UPDATED with onWithHistory');

    // 使用 onWithHistory 监听进度更新事件
    // 移除条件检查，总是更新 latestProgress
    this.onWithHistory(Events.PROGRESS_UPDATED, (data: { progress: number }) => {
      console.log(`[ProgressBar] 收到进度更新事件: ${data.progress}%`);
      this.latestProgress = data.progress;

      // 如果进度条应该显示，检查 DOM 是否存在
      if (this.isVisible) {
        const existsInDom = document.getElementById('wxrd-progress-bar-container');

        if (!existsInDom) {
          // DOM 不存在，重新创建
          console.log('[ProgressBar] 进度条元素丢失（可能被微信读书清理），重新创建');
          this.progressBarElement = null;
          this.show();
        } else if (this.progressBarElement) {
          // DOM 存在且有引用，直接更新
          this.progressBarElement.style.width = `${data.progress}%`;
          console.log(`[ProgressBar] 进度条更新: ${data.progress}%`);
        }
      }
    });

    // 监听章节切换事件，延迟重新创建进度条
    // 因为微信读书会重新渲染 DOM，需要等待渲染完成
    this.on(Events.CHAPTER_CHANGED, () => {
      console.log('[ProgressBar] 章节切换，延迟重建进度条');
      if (this.isVisible) {
        // 延迟重建，等待微信读书 DOM 渲染完成
        setTimeout(() => {
          if (!document.getElementById('wxrd-progress-bar-container')) {
            console.log('[ProgressBar] 章节切换后进度条丢失，重新创建');
            this.show();
          }
        }, 200);
      }
    });

    console.log('[ProgressBar] Subscription complete, latestProgress:', this.latestProgress);
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
      console.warn('[ProgressBar] .renderTargetContainer not found');
      return;
    }

    console.log('[ProgressBar] .renderTargetContainer found:', container);

    // 检查是否已经存在进度条容器
    const existingContainer = document.getElementById('wxrd-progress-bar-container');
    if (existingContainer) {
      existingContainer.remove();
      console.log('[ProgressBar] 移除已存在的进度条容器');
    }

    // 清理旧引用
    this.progressBarElement = null;

    // 创建进度条容器
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

    // 创建进度条，使用缓存的最新进度值
    const progressBar = document.createElement('div');
    progressBar.id = 'wxrd-progress-bar';
    progressBar.style.cssText = `
      height: 100%;
      width: ${this.latestProgress}%;
      background-color: #349f66;
      transition: width 0.3s ease;
    `;

    progressContainer.appendChild(progressBar);
    container.appendChild(progressContainer);

    this.progressBarElement = progressBar;
    this.isVisible = true;

    console.log('[ProgressBar] 进度条已添加到 DOM，容器:', progressContainer);
    console.log('[ProgressBar] 进度条元素:', progressBar);

    // 立即验证是否还在 DOM 中
    setTimeout(() => {
      const stillExists = document.getElementById('wxrd-progress-bar-container');
      if (!stillExists) {
        console.error('[ProgressBar] 进度条在创建后立即被删除了！');
      } else {
        console.log('[ProgressBar] 进度条仍然存在于 DOM 中');
      }
    }, 100);

    log.info(`[ProgressBar] Progress bar shown with ${this.latestProgress}% progress`);
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
    this.hide();
    super.destroy();
  }
}
