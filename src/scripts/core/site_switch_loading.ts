/**
 * 书城切换过场层（复刻启动动画，index.html 同款视觉）。
 *
 * 切换书城的所有路径（菜单/⌘1~7/书城浮层）最终都由 Rust `switch_to_site`
 * 执行 `win.navigate()`，旧页 JS 上下文销毁、前端拿不到导航事件；而初始化
 * 脚本会在新文档 documentStart 重新执行——过场层因此在注入层实现：
 * documentStart 判定「本次为跨站导航」（referral host 与当前 host 不同或
 * 为空；程序化 navigate 的 referrer 为空，恰好覆盖全部切换路径）后同步
 * 铺上深色过场，`window load` + 320ms（与启动揭示节奏一致）后淡出，
 * 8s 兜底防止慢资源把用户困在过场。
 *
 * 判定不成立（站内跳转、SPA 路由、刷新）则完全不出现。
 */

const OVERLAY_ID = 'atreader-site-switch-loading';
const STYLE_ID = `${OVERLAY_ID}-style`;
/** 动画周期（毫秒）：相位以墙上时钟为锚（Date.now() % 周期 → 负 delay），
 * 预铺过场与新文档过场共享同一相位轴，交接只剩导航冻结帧的微小相位差 */
const BREATHE_MS = 2200;
const TRAVEL_MS = 1500;
/** load 事件兜底：长尾资源挂住时不再死等 load（见 mount 内 settle 触发） */
const LOAD_FALLBACK_MS = 4000;
/** 探针注册宽限：过场在 documentStart 铺设，插件的就绪探针要等
 * get_runtime_plugin IPC + 动态 import 之后才注册（2026-10-25 实测快站的
 * load+320ms 时刻 probe=none，直接判定会在裸页状态撤场）。开局未满宽限期
 * 且探针未注册时先等注册，再按探针判定撤场。 */
const PROBE_GRACE_MS = 1500;
/**
 * 根滚动条是浏览器画在一切内容之上的，z-index 盖不住；给滚动条涂透明的
 * CSS 方案又会被站点自己的滚动条样式反杀（样式表顺序打不赢）。因此过场
 * 期间直接让根滚动条不存在（html overflow:hidden）——没画就没有"浮在上层"。
 * 隐藏前先量出滚动条宽度并给 body 加等宽 padding-right 补偿，恢复时两个
 * 一起撤，净布局变化为零，站点内容不跳。恢复时机 = 过场节点移除瞬间。
 */
export const SCROLLBAR_STYLE_ID = `${OVERLAY_ID}-scrollbar-style`;

/** 量出引擎/站点样式的滚动条宽度（探针元素自带滚动，与页面当前状态无关） */
const measureScrollbarWidth = (doc: Document): number => {
  const host = doc.body ?? doc.documentElement;
  if (!host) return 0;
  const probe = doc.createElement('div');
  probe.style.cssText = 'position:absolute;top:-999px;width:100px;height:100px;overflow:scroll;';
  host.appendChild(probe);
  const width = 100 - probe.clientWidth;
  probe.remove();
  return width > 0 ? width : 0;
};

const scrollbarLockCss = (scrollbarWidth: number): string => `
html {
  overflow: hidden !important;
  /* 滚动条槽位补偿：恢复时与 padding 一起撤，净布局变化为零 */
  padding-right: ${scrollbarWidth}px !important;
}
`;
const LOGO_DATA_URI = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0Ij4KCTxwYXRoIGQ9Ik0xNS4zLDEyLjhjMi43LS4xLDEsLjMsMS44LDEuOS4zLjYsMS4xLjYsMS41LjIuMi0uMy40LS44LjgtLjUuNy41LDIuNy4yLDIuNSwxLjItMS45LDQtOC4yLDMuMi04LjEtMS42LS41LTEuNS4zLTEuMywxLjUtMS4zaDBaIi8+Cgk8cGF0aCBkPSJNMTIuMi4zYzEuOC4zLDYuNy0uOSw0LjYsMi4zLS4yLjQtLjMsMS0uOS45LTEuOS0uNC0zLjgtLjUtNS43LDAtLjMsMC0uNS0uMS0uNS0uNC0uNC0zLjItMS43LTIuNSwyLjQtMi43WiIvPgoJPHBhdGggZD0iTTkuNSwzYy4yLDEuMi0yLjIuMi0zLjUsMi44LS4yLjQtLjEsMS40LS45LDEuMS0uNi0uNS0yLjYtLjQtMi40LTEuNCwxLjEtMi40LDYuNi03LjcsNi44LTIuNVoiLz4KCTxwYXRoIGQ9Ik0xNS4zLDUuN2MuNS4xLDEuOS0uNCwxLjcuNS0uNC44LS4xLDIuMi0uMiwzLjIsMCwzLjEuOCwzLjQtMi43LDMuMS0xLjEtLjMuMy00LjktLjUtNi4yLS4zLS45LDEuMy0uNSwxLjgtLjZoMFoiLz4KCTxwYXRoIGQ9Ik00LjgsMTQuNWMuMyw0LjgsMy4yLDMuNC43LDUuNi0uNC4zLS44LDEuMy0xLjMuNy0xLjMtMS40LTIuMi0zLjItMi4zLTUuMi0uMS0xLjQtMS0xLjcsMS0xLjguNywwLDIuMi0uNiwxLjkuN1oiLz4KCTxwYXRoIGQ9Ik0yLjIsMTMuNmMtMS4yLjItLjQtMS0uNS0xLjcuNS0yLjgtMS4xLTcuMSwzLjMtNC42LjIsMCwuMy4zLjIuNS0uNywxLjUtLjQsMy4yLS41LDQuOC4zLDEuNC0xLjcuOC0yLjUsMSwwLDAsMCwwLDAsMFoiLz4KCTxwYXRoIGQ9Ik0xMi40LDIzLjZjLTEuOC0uMS05LjUtMS4xLTYuNC0zLjYuMy0uMy44LTEuMSwxLjMtLjYsMS44LDIuNCw2LDEuMSw1LjksMiwwLDEsLjcsMi42LS45LDIuMloiLz4KCTxwYXRoIGQ9Ik0xOS4xLDcuMWMuMS0zLjQtMy40LTIuNC0xLjktNC42LDEtNC4yLDQuOSwyLjYsNS4xLDQuNC4yLjktMS4xLjYtMS42LjgtLjcsMC0xLjguNi0xLjYtLjVaIi8+Cgk8cGF0aCBkPSJNMjIuNiw4Yy0uNSwxLjYuNSw2LjEtLjksNi43LTQuMy0uNS0xLjgtMi4yLTIuMy01LjIsMC0uNS0uNi0xLjMuMi0xLjQuOSwwLDIuNC0uOCwzLDBaIi8+Cgk8cGF0aCBkPSJNMTMuNiwyMS40YzAtLjYuNi0uNCwxLS41LDEuNywwLDMuMi0uOSw0LjUtMiwuNy0uNS4zLDEsMS44LDEuMi45LDEuNy01LjMsMy42LTYuOCwzLjUtLjctLjItLjMtMS42LS42LTIuMloiLz4KCTxwYXRoIGQ9Ik02LjcsMTIuM2MuMi0uOSwwLTQsLjktNCwuNy41LDIuNi43LDIuNCwxLjgtLjMsMS4yLS4yLDIuNSwwLDMuNy4xLjYtLjguNy0xLjIuOS0yLjMsMS42LTEuOS0uNy0yLjEtMi40WiIvPgoJPHBhdGggZD0iTTExLjMsMTguMmMtMSwuMy01LjEtMS43LTMuNS0yLjYsMS40LS4yLDIuMi0xLjUsMi42LS44LjYuOSwxLjkuNSwyLjYtLjEuOC0uNS41LDEuMy45LDEuNywxLDEuNS0xLjYsMS43LTIuNiwxLjgsMCwwLDAsMCwwLDBaIi8+Cgk8cGF0aCBkPSJNMTMuNCw4LjJjMCwuMywwLDEuMy0uNC44LTEtMS4yLTIuMSwwLTMsMC0uNy0uNC0xLjQtLjctMi4xLTEtMS0xLjUsNi40LTQuNyw1LjYuMloiLz4KPC9zdmc+';

import { injectCSS, removeCSS } from './utils';

export interface SwitchLoadingTiming {
  /** load 完成后的稳定驻留，与启动揭示节奏一致 */
  settleMs?: number;
  /** 最长驻留兜底：网络卡死/慢资源不能把用户困在过场里 */
  maxMs?: number;
  /**
   * 提交时刻预铺模式：不安排 load 收场（导航会带走整个 JS 上下文），
   * 仅保留 maxMs 兜底（默认 2.5s）——导航因同站短路/守卫拒绝而未发生时
   * 过场自动淡出，不会把用户困死。
   */
  sticky?: boolean;
  /** 探针注册宽限（毫秒），默认 1500；测试传 0 跳过等待 */
  probeGraceMs?: number;
}

/**
 * 站点呈现就绪探针：由各书城插件注册（正文已渲染且站点样式已应用）。
 * 过场层撤场前会等待探针为 true（maxMs 硬顶），站点 CSS 迟到的 FOUC 裸页
 * 不会再被提前暴露。探针只作用于非 sticky 的撤场判定。
 */
let readinessProbe: (() => boolean) | null = null;
export const setSiteReadinessProbe = (probe: () => boolean): void => {
  readinessProbe = probe;
};

const SWITCH_LOADING_CSS = `
/* 站点反色滤镜激活时（html.wxrd-theme-inverted），过场层二次反转抵消，
   保持自有深色观感不被一起反色；内部元素交回原色（过场无图片资源） */
html.wxrd-theme-inverted #${OVERLAY_ID} {
  filter: invert(1) hue-rotate(180deg);
}
html.wxrd-theme-inverted #${OVERLAY_ID} :is(img, video, canvas, svg),
html.wxrd-theme-inverted #${OVERLAY_ID} [style*="background-image"] {
  filter: none !important;
}
#${OVERLAY_ID} {
  position: fixed;
  /* 不用 inset:0——它的宽度跟随布局视口，页面加载中经典滚动条出现/消失
     会挤压居中内容（可见的左移一跳）。100vw/vh 含滚动条槽，宽度恒定。 */
  left: 0;
  top: 0;
  width: 100vw;
  height: 100vh;
  z-index: 2147483647;
  display: grid;
  place-items: center;
  overflow: hidden;
  color: #edf5f1;
  background:
    radial-gradient(circle at 50% 42%, rgba(52, 159, 102, .14), transparent 38%),
    linear-gradient(145deg, #202826, #171c1b 64%);
  font-family: "Songti SC", "Noto Serif CJK SC", STSong, serif;
  user-select: none;
  -webkit-user-select: none;
  opacity: 1;
  transition: opacity .24s ease;
}
#${OVERLAY_ID}.atreader-switch-loading-done {
  opacity: 0;
  pointer-events: none;
}
#${OVERLAY_ID} main {
  width: min(360px, calc(100vw - 64px));
  display: grid;
  justify-items: center;
  text-align: center;
}
#${OVERLAY_ID} .logo {
  width: 72px;
  height: 72px;
  background: #349f66;
  -webkit-mask: url('${LOGO_DATA_URI}') center / contain no-repeat;
  mask: url('${LOGO_DATA_URI}') center / contain no-repeat;
  filter: drop-shadow(0 12px 26px rgba(52, 159, 102, .18));
  animation: atreaderSwitchBreathe ${BREATHE_MS}ms ease-in-out infinite;
  /* 挂载时注入墙上时钟对齐的负 animation-delay（见 mount），预铺过场与
     新文档过场因此共享同一相位轴，交接只剩导航冻结帧的微小相位差 */
}
#${OVERLAY_ID} h1 {
  margin: 25px 0 0;
  font-size: 30px;
  font-weight: 600;
  letter-spacing: .2em;
  text-indent: .2em;
  /* 显式行高：normal 跟随字体度量，文档间存在差异的理论空间 */
  line-height: 1.2;
}
#${OVERLAY_ID} .status {
  margin: 13px 0 0;
  color: #91a39c;
  font: 12px/1.6 ui-monospace, "SF Mono", Menlo, monospace;
  letter-spacing: .08em;
}
#${OVERLAY_ID} .progress {
  width: 132px;
  height: 1px;
  margin-top: 24px;
  overflow: hidden;
  background: rgba(237, 245, 241, .1);
}
#${OVERLAY_ID} .progress-block {
  width: 48%;
  height: 100%;
  background: #349f66;
  animation: atreaderSwitchTravel ${TRAVEL_MS}ms ease-in-out infinite;
}
@keyframes atreaderSwitchBreathe {
  50% { transform: scale(.95); opacity: .72; }
}
@keyframes atreaderSwitchTravel {
  from { transform: translateX(-105%); }
  to { transform: translateX(215%); }
}
@media (prefers-reduced-motion: reduce) {
  #${OVERLAY_ID} .logo,
  #${OVERLAY_ID} .progress-block { animation: none; }
  #${OVERLAY_ID} .progress-block { width: 100%; opacity: .55; }
  #${OVERLAY_ID} { transition: none; }
}
`;

/**
 * 纯判定：本次导航是否为「跨站进入」。
 * referrer 为空 = 程序化 navigate（Rust switch_to_site）或全新启动；
 * referrer host ≠ 当前 host = 从其他站点跳入。站内跳转与刷新不成立。
 */
export const isSiteSwitchNavigation = (
  location: { protocol: string; host: string },
  referrer: string,
): boolean => {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return false;
  if (!referrer) return true;
  let refHost: string | null = null;
  try {
    refHost = new URL(referrer).host || null;
  } catch {
    refHost = null;
  }
  return refHost !== location.host;
};

/** 启动后多少毫秒内的导航视为「启动恢复」，不铺过场（启动窗口本身就是加载动画） */
export const STARTUP_SUPPRESS_MS = 5000;

/**
 * 遥控器主页键「回书架」导航标记（RemoteManager 置位，多看弹回守卫消费）。
 * 回书架是站内跳转：过场层 5 秒内见到该标记就不铺（值 = 置位时间戳）。
 */
export const HOME_NAV_FLAG_KEY = 'atreader-home-nav';
export const HOME_NAV_SKIP_MS = 5000;

export const isRecentHomeNav = (
  storage: { getItem(key: string): string | null },
  now: number = Date.now(),
): boolean => {
  let value = Number.NaN;
  try {
    value = Number(storage.getItem(HOME_NAV_FLAG_KEY));
  } catch {
    return false;
  }
  return Number.isFinite(value) && value > 0 && now - value >= 0 && now - value < HOME_NAV_SKIP_MS;
};

/**
 * 纯判定：当前是否处于启动窗口期（Rust 在初始化脚本里注入启动时间戳）。
 * 启动恢复的首个页面与手动切换在 documentStart 都表现为 referrer 为空，
 * 只能靠 Rust 注入的时间戳区分。窗口期过短阈值会把快速用户的手动切换
 * 误判成启动——铺过场的两处（documentStart 与浮层提交预铺）必须同时使用。
 */
export const isStartupWindow = (
  boot: { launchedAt?: unknown } | undefined,
  now: number,
): boolean => {
  const launchedAt = boot?.launchedAt;
  return typeof launchedAt === 'number' && now - launchedAt < STARTUP_SUPPRESS_MS;
};

export const startupWindowFromGlobal = (now: number = Date.now()): boolean =>
  isStartupWindow((window as { __ATREADER_BOOT__?: { launchedAt?: unknown } }).__ATREADER_BOOT__, now);

/**
 * 同步铺上过场层并按 load + settleMs 淡出（maxMs 兜底）。
 * documentStart 时 <html> 可能尚未出现，DOM 就绪后再挂载（样式先行注入，
 * 与 utils.injectCSS 的无 head 兜底同构）。幂等：已存在则跳过。
 */
export const showSiteSwitchLoading = (
  doc: Document = document,
  timing: SwitchLoadingTiming = {},
): void => {
  if (doc.getElementById(OVERLAY_ID)) return;
  injectCSS(STYLE_ID, SWITCH_LOADING_CSS);
  // 根滚动条画在所有内容之上且 CSS 涂装打不赢站点样式：直接让它不存在，
  // 槽位用 padding 补偿（恢复时机 = 过场节点移除瞬间）
  injectCSS(SCROLLBAR_STYLE_ID, scrollbarLockCss(measureScrollbarWidth(doc)));

  const view = doc.defaultView ?? window;
  const settleMs = timing.settleMs ?? 320;
  const probeGraceMs = timing.probeGraceMs ?? PROBE_GRACE_MS;
  // 非 sticky 硬顶 15s：探针未就绪（站点渲染反复重建的混乱期）时过场持续
  // 遮盖；配合 10s 看门狗重载，用户看到的是「过场 → 完整页面」而非裸页
  const maxMs = timing.maxMs ?? (timing.sticky ? 2500 : 15000);
  const overlayStart = Date.now();
  let dismissed = false;
  // dismiss 必须闭包绑定本调用挂载的节点：showSiteSwitchLoading 幂等，但
  // 上一轮调用的收场计时器可能还活着（settle 宽限链可长达 1.5s+），现查
  // getElementById 会把「当前这轮」的过场层误拉淡出
  let overlay: HTMLElement | null = null;
  const dismiss = (): void => {
    if (dismissed) return;
    dismissed = true;
    if (!overlay) return;
    overlay.classList.add('atreader-switch-loading-done');
    // 计时器必须用全局 setTimeout：happy-dom 的 defaultView 计时器与真实
    // 事件循环不连通；生产环境两者本就是同一个 window
    setTimeout(() => {
      // 过场完全透明后才恢复滚动条，观感上无缝
      removeCSS(SCROLLBAR_STYLE_ID);
      overlay?.remove();
    }, 280);
  };

  const mount = (): void => {
    if (doc.getElementById(OVERLAY_ID)) return;
    const overlayEl = doc.createElement('div');
    overlayEl.id = OVERLAY_ID;
    overlayEl.setAttribute('role', 'status');
    overlayEl.setAttribute('aria-label', '正在加载');
    overlayEl.innerHTML =
      '<main><div class="logo" role="img" aria-label="艾特阅读标志"></div>'
      + '<h1>艾特阅读</h1>'
      + '<p class="status">正在准备阅读空间</p>'
      + '<div class="progress" aria-hidden="true"><div class="progress-block"></div></div></main>';
    // 相位同步：动画锚定墙上时钟（负 delay = 本周期已流逝的部分）。
    // 预铺过场与新文档过场各自挂载时独立计算，得到同一相位——交接处
    // 不再出现旧文档任意相位 → 新文档 0 相位的随机跳变。
    const logo = overlayEl.querySelector<HTMLElement>('.logo');
    const block = overlayEl.querySelector<HTMLElement>('.progress-block');
    if (logo) logo.style.animationDelay = `-${Date.now() % BREATHE_MS}ms`;
    if (block) block.style.animationDelay = `-${Date.now() % TRAVEL_MS}ms`;
    (doc.body ?? doc.documentElement)?.appendChild(overlayEl);
    overlay = overlayEl;
    // readyState 已 complete（注入晚于 load / 测试环境）直接进入稳定驻留；
    // sticky（提交预铺）不安排 load/settle 收场，只靠 maxMs 兜底
    if (timing.sticky) {
      setTimeout(dismiss, maxMs);
      return;
    }
    const settle = (): void => {
      // 探针未注册且开局未满宽限期：等插件注册探针（快站 load+320ms 时刻
      // 探针往往尚未就位）；探针已注册则按探针判定，未就绪 300ms 重查，
      // maxMs 硬顶到点强制撤场，绝不让用户被困
      if (!readinessProbe && Date.now() - overlayStart < probeGraceMs) {
        setTimeout(settle, 300);
        return;
      }
      if (readinessProbe && !readinessProbe() && Date.now() - overlayStart < maxMs) {
        setTimeout(settle, 300);
        return;
      }
      dismiss();
    };
    if (doc.readyState === 'complete') {
      setTimeout(settle, settleMs);
    } else {
      view.addEventListener('load', () => setTimeout(settle, settleMs), { once: true });
      // load 兜底：单个挂住的长尾资源（被墙统计脚本、慢图）会让 load 永远
      // 不来，用户被困到 maxMs 硬顶。DOM 骨架早于 load 就绪，4s 后直接进入
      // settle——探针（若已注册）继续把关撤场。
      setTimeout(() => {
        if (!dismissed) setTimeout(settle, settleMs);
      }, LOAD_FALLBACK_MS);
    }
    setTimeout(dismiss, maxMs);
  };

  // documentStart 时 <html>/<body> 可能尚未出现（WebView2 早期注入的已知
  // 时序），观察首个节点出现即挂载，兜底 DOMContentLoaded 防止观察器漏报
  if (doc.body || doc.documentElement) {
    mount();
    return;
  }
  const observer = new MutationObserver(() => {
    if (doc.body || doc.documentElement) {
      observer.disconnect();
      mount();
    }
  });
  observer.observe(doc, { childList: true });
  doc.addEventListener(
    'DOMContentLoaded',
    () => {
      observer.disconnect();
      mount();
    },
    { once: true },
  );
};
