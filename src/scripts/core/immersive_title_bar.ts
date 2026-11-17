/**
 * 沉浸标题栏（全局开关 immersiveTitleBar，跟随当前站点 hideNavbar）。
 *
 * 有效态纯判定：immersiveTitleBar && hideNavbar && 阅读页——与 hideNavbar
 * 的 CSS 仅在阅读页生效（StyleManager.applyStyles 的 isReader 门禁）精确
 * 对齐，首页/书架不隐藏标题栏。
 *
 * 平台分工：
 * - macOS：Rust set_title_bar_style(Overlay) 原生承接，内容顶到窗口上沿、
 *   红绿灯悬浮（fullSizeContentView），本模块不建 DOM。
 * - Windows：Rust set_decorations(false) 去掉原生标题栏连同窗口按钮，由本
 *   模块补一条碰顶悬浮控件（拖拽区 + 最小化/最大化/关闭）。交互语言与
 *   fullscreen_exit_button 一致：顶边命中带唤出、驻留后自动收起、深浅双适配。
 *   全屏时让位给「退出全屏」按钮（全屏本就是 borderless，沉浸设置无意义）。
 */
import { getCurrentWindow } from '@tauri-apps/api/window';
import { attachEventToSameOriginIframes } from './iframe_keyboard';
import { isEdgeHit } from './fullscreen_exit_button';
import { invoke, listen } from './tauri';
import { log } from './logger';

/** 纯判定：沉浸标题栏当前是否应隐藏（独立可测单元）。 */
export const computeImmersiveHidden = (
  immersiveTitleBar: boolean | undefined,
  hideNavbar: boolean | undefined,
  isReader: boolean,
): boolean => immersiveTitleBar === true && hideNavbar === true && isReader;

export const TITLE_BAR_ID = 'wxrd-immersive-titlebar';
/** 碰顶后控件驻留时长，与退出全屏按钮同语义。 */
const LINGER_MS = 1200;

export interface WindowsTitleBar {
  destroy(): void;
}

const ICONS: Record<string, string> = {
  minimize: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6h8" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>',
  maximize: '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>',
  close: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>',
};

/**
 * 创建 Windows 沉浸标题栏控件（幂等由调用方保证：隐藏态建、恢复态毁）。
 * 返回控制器；非主文档或 body 未就绪返回 null。
 */
export const createWindowsTitleBar = (doc: Document): WindowsTitleBar | null => {
  if (doc.defaultView !== window) return null;
  if (!doc.body) return null;

  const bar = doc.createElement('div');
  bar.id = TITLE_BAR_ID;
  bar.innerHTML = `
    <div class="wxrd-itb-drag" data-tauri-drag-region></div>
    <button type="button" class="wxrd-itb-btn" data-action="minimize" title="最小化" aria-label="最小化">${ICONS.minimize}</button>
    <button type="button" class="wxrd-itb-btn" data-action="maximize" title="最大化 / 还原" aria-label="最大化或还原">${ICONS.maximize}</button>
    <button type="button" class="wxrd-itb-btn wxrd-itb-close" data-action="close" title="关闭" aria-label="关闭">${ICONS.close}</button>`;

  const style = doc.createElement('style');
  style.id = `${TITLE_BAR_ID}-style`;
  style.textContent = `
    #${TITLE_BAR_ID} {
      position: fixed;
      top: 0; left: 0; right: 0;
      height: 36px;
      display: flex;
      align-items: stretch;
      z-index: 2147483647;
      opacity: 0;
      pointer-events: none;
      transition: opacity .16s ease;
      /* 顶部渐隐 scrim：保证控件在任意正文底色上可读，不永久遮挡正文 */
      background: linear-gradient(to bottom, rgba(20,21,23,.55), rgba(20,21,23,0));
      color: #f2f3f5;
    }
    #${TITLE_BAR_ID}.wxrd-itb-shown { opacity: 1; pointer-events: auto; }
    #${TITLE_BAR_ID} .wxrd-itb-drag { flex: 1 1 auto; height: 100%; }
    #${TITLE_BAR_ID} .wxrd-itb-btn {
      flex: 0 0 auto;
      width: 46px; height: 100%;
      display: flex; align-items: center; justify-content: center;
      padding: 0; border: none; background: transparent;
      color: inherit; cursor: pointer;
      transition: background .12s ease;
    }
    #${TITLE_BAR_ID} .wxrd-itb-btn svg { width: 12px; height: 12px; pointer-events: none; }
    #${TITLE_BAR_ID} .wxrd-itb-btn:hover { background: rgba(255,255,255,.14); }
    #${TITLE_BAR_ID} .wxrd-itb-close:hover { background: #c42b1c; color: #fff; }
    /* 浅色页（微信读书 wr_whiteTheme 优先，系统偏好兜底）：深色图标 + 浅 scrim */
    body.wr_whiteTheme #${TITLE_BAR_ID} {
      color: #1f2329;
      background: linear-gradient(to bottom, rgba(244,245,247,.7), rgba(244,245,247,0));
    }
    body.wr_whiteTheme #${TITLE_BAR_ID} .wxrd-itb-btn:hover { background: rgba(0,0,0,.08); }
    body.wr_whiteTheme #${TITLE_BAR_ID} .wxrd-itb-close:hover { background: #c42b1c; color: #fff; }
    @media (prefers-color-scheme: light) {
      body:not(.wr_whiteTheme) #${TITLE_BAR_ID} {
        color: #1f2329;
        background: linear-gradient(to bottom, rgba(244,245,247,.7), rgba(244,245,247,0));
      }
      body:not(.wr_whiteTheme) #${TITLE_BAR_ID} .wxrd-itb-btn:hover { background: rgba(0,0,0,.08); }
    }`;
  doc.head?.appendChild(style);
  doc.body.appendChild(bar);

  const win = getCurrentWindow();
  const onAction = (event: Event): void => {
    const target = (event.target as HTMLElement).closest('.wxrd-itb-btn') as HTMLElement | null;
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    const action = target.dataset.action;
    if (action === 'minimize') void win.minimize().catch(() => undefined);
    else if (action === 'maximize') void win.toggleMaximize().catch(() => undefined);
    else if (action === 'close') void win.close().catch(() => undefined);
  };
  bar.addEventListener('click', onAction);

  // 全屏让位：全屏时收起并不再唤出（退出全屏按钮接管顶边交互）。
  let fullscreen = false;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  const hide = (): void => {
    bar.classList.remove('wxrd-itb-shown');
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  };
  const show = (): void => {
    if (fullscreen) return;
    bar.classList.add('wxrd-itb-shown');
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { hideTimer = null; bar.classList.remove('wxrd-itb-shown'); }, LINGER_MS);
  };

  const edgeHandler = (event: MouseEvent): void => {
    const topY = (event as { __atreaderTopClientY?: number }).__atreaderTopClientY;
    const y = typeof topY === 'number' ? topY : event.clientY;
    if (!isEdgeHit(y)) return;
    show();
  };
  window.addEventListener('mousemove', edgeHandler, true);
  // 正文 iframe 内指针不冒泡出 frame——与退出全屏按钮同构转发。
  let detachIframe: (() => void) | null = null;
  try {
    detachIframe = attachEventToSameOriginIframes('mousemove', edgeHandler as (event: never) => void);
  } catch (error) {
    log.error('[ImmersiveTitleBar] iframe mousemove 转发挂载失败（控件仍作用于主文档）', error);
  }

  void invoke<boolean>('is_main_fullscreen').then((fs) => { fullscreen = fs === true; }).catch(() => undefined);
  let unlistenFs: (() => void) | null = null;
  void listen<boolean>('fullscreen-changed', (event) => {
    fullscreen = event.payload === true;
    if (fullscreen) hide();
  }).then((unlisten) => { unlistenFs = unlisten; }).catch(() => undefined);

  return {
    destroy(): void {
      hide();
      window.removeEventListener('mousemove', edgeHandler, true);
      detachIframe?.();
      detachIframe = null;
      unlistenFs?.();
      unlistenFs = null;
      bar.removeEventListener('click', onAction);
      bar.remove();
      style.remove();
    },
  };
};
