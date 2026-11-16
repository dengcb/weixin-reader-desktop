/**
 * 首绘样式引导（Boot Styles）
 *
 * 插件样式（沉浸模式/隐藏导航栏等）要等 get_runtime_plugin IPC + 动态
 * import 之后才注入，zread 这类整页改造型站点会先闪现原版布局、再塌陷成
 * 沉浸模式。Rust 壳在启动时把已启用站点插件的导航/工具栏隐藏 CSS 与设置
 * 快照嵌进初始化脚本（window.__ATREADER_BOOT__），本模块在 documentStart
 * 同步套用；插件系统就绪后由 AppRuntime 调 settleBootStyles() 移除引导
 * 样式，之后完全由插件接管。
 *
 * reader 引导（MPA 分栏站点，目前仅起点）：起点切章是整页导航，新页面首绘
 * 在插件就绪前，会先闪原生单栏再坍缩成双栏。快照额外携带 reader/wide CSS
 * 与分栏类，documentStart 直接以最终版式首绘，正文经 reader.css 的
 * 「未绑视口前隐藏」规则保持不可见，插件绑定后显现。双栏偏好不进快照——
 * 此处同步读 localStorage（与插件 LAYOUT_PREFERENCE_KEY 同键）实时判定，
 * 不存在快照过期问题。引导不写任何站点存储、不设任何背景色：隐藏区域
 * 透出的是站点自身深浅色主题背景，不会出现黑白闪烁。
 *
 * 只读取壳内嵌数据与 localStorage，不向站点写任何存储（起点风控脚本会因
 * 未知存储键触发自刷新，整页预接管方案因此回退，见
 * qidian-site-injection-gotchas 记忆）；主题引导只写「站点本该自己写的」
 * DOM 属性，不触碰存储键。
 * 快照是应用启动时刻的设置；会话内改设置后由插件注入正确样式并移除引导，
 * 下一页面的引导快照在应用重启前保持启动时的值。
 */

interface BootStyleEntry {
  id?: string;
  domains?: unknown;
  capabilities?: Record<string, unknown>;
  pagedClass?: unknown;
  readerPattern?: unknown;
  bootTheme?: {
    hostSelector?: unknown;
    storageKey?: unknown;
    attr?: unknown;
    valuePath?: unknown;
  } | null;
  styles?: { navbar?: unknown; toolbar?: unknown; reader?: unknown; wide?: unknown; night?: unknown };
}

interface BootSnapshot {
  siteSettings?: Record<string, Record<string, unknown>>;
  plugins?: BootStyleEntry[];
}

const BOOT_PREFIX = 'atreader-boot-';

const hostMatchesDomain = (host: string, domain: string): boolean => {
  const normalizedDomain = domain.trim().replace(/^\.+|\.+$/g, '').toLowerCase();
  const normalizedHost = host.replace(/\.+$/, '').toLowerCase();
  if (normalizedDomain.length === 0) return false;
  return normalizedHost === normalizedDomain
    || normalizedHost.endsWith(`.${normalizedDomain}`);
};

const readSnapshot = (): BootSnapshot | null => {
  try {
    const raw = (window as unknown as { __ATREADER_BOOT__?: unknown }).__ATREADER_BOOT__;
    if (!raw || typeof raw !== 'object') return null;
    return raw as BootSnapshot;
  } catch {
    return null;
  }
};

/** 各分栏插件 LAYOUT_PREFERENCE_KEY 的同名后缀（经 plugin_api 存 localStorage）。 */
const LAYOUT_PREFERENCE_SUFFIX = 'double-column-enabled';

/** 双栏偏好实时判定；读取失败或从未写入时按插件默认值 true。 */
const readerPreferenceEnabled = (pluginId: string): boolean => {
  try {
    const raw = localStorage.getItem(`plugin_${pluginId}_${LAYOUT_PREFERENCE_SUFFIX}`);
    return raw === null || JSON.parse(raw) !== false;
  } catch {
    return true;
  }
};

const matchesReaderPattern = (pattern: unknown): boolean => {
  if (typeof pattern !== 'string' || pattern.length === 0) return false;
  try {
    return new RegExp(pattern).test(window.location.pathname);
  } catch {
    return false;
  }
};

const applyPagedClass = (cls: string): void => {
  try {
    if (document.body) {
      document.body.classList.add(cls);
      return;
    }
    // documentStart 时 <body> 常未解析；观察 documentElement，body 一出现即
    // 补类（微任务时机先于任何正文首绘）。插件 enable() 会幂等重加同一类。
    const observer = new MutationObserver(() => {
      if (!document.body) return;
      observer.disconnect();
      document.body.classList.add(cls);
    });
    observer.observe(document.documentElement, { childList: true });
  } catch {
    /* ignore */
  }
};

/** 主题引导观察器：找宿主阶段与防重置阶段共用；settle 时统一断开。 */
let themeBootObserver: MutationObserver | null = null;

const stopThemeBoot = (): void => {
  themeBootObserver?.disconnect();
  themeBootObserver = null;
};

const readStoredThemeValue = (storageKey: string, valuePath: string): string | null => {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const value = (JSON.parse(raw) as Record<string, unknown> | null)?.[valuePath];
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
};

/**
 * 首绘主题引导：站点 SSR 固定渲染默认主题、其 JS 启动后才把存储偏好写到
 * 主题宿主属性（七猫 .reader-layout-theme[data-theme]，curl 实证 SSR 硬编码
 * "default"），深色用户切章会经历「黑→白→黑」。此处读站点自身存储，宿主一
 * 出现就把属性写成存储值——与站点 JS 稍后做的同一件事，只是提前到首绘前。
 * 引导期内水合若把属性重置回默认，补写一次；settle 后停手交还站点/插件。
 * 只写「站点本该自己写的」属性，不触碰任何存储键。
 */
const applyThemeBoot = (boot: NonNullable<BootStyleEntry['bootTheme']>): void => {
  const hostSelector = typeof boot.hostSelector === 'string' ? boot.hostSelector : '';
  const storageKey = typeof boot.storageKey === 'string' ? boot.storageKey : '';
  const attr = typeof boot.attr === 'string' ? boot.attr : '';
  const valuePath = typeof boot.valuePath === 'string' ? boot.valuePath : '';
  if (!hostSelector || !storageKey || !attr || !valuePath) return;
  const theme = readStoredThemeValue(storageKey, valuePath);
  if (theme === null) return;

  const writeTheme = (host: Element): void => {
    try {
      if (host.getAttribute(attr) !== theme) host.setAttribute(attr, theme);
    } catch {
      /* ignore */
    }
  };
  const guardHost = (host: Element): void => {
    stopThemeBoot();
    themeBootObserver = new MutationObserver(() => writeTheme(host));
    themeBootObserver.observe(host, { attributes: true, attributeFilter: [attr] });
  };
  const seekHost = (): void => {
    try {
      const host = document.querySelector(hostSelector);
      if (host) {
        writeTheme(host);
        guardHost(host);
        return;
      }
      const root = document.body ?? document.documentElement;
      if (!root) return;
      stopThemeBoot();
      themeBootObserver = new MutationObserver(() => seekHost());
      themeBootObserver.observe(root, { childList: true, subtree: true });
    } catch {
      /* ignore */
    }
  };
  seekHost();
};

/**
 * documentStart 同步调用（先于任何 await）：按域名匹配站点插件，把设置
 * 开启且清单能力允许的导航/工具栏隐藏 CSS 在首绘前注入；MPA 分栏站点
 * 额外套用 reader/wide 引导与分栏类。
 */
export const applyBootStyles = (): void => {
  const snapshot = readSnapshot();
  const plugins = Array.isArray(snapshot?.plugins) ? snapshot!.plugins : [];
  if (plugins.length === 0) return;
  const host = window.location.hostname;

  for (const entry of plugins) {
    if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) continue;
    const domains = Array.isArray(entry.domains)
      ? entry.domains.filter((domain): domain is string => typeof domain === 'string')
      : [];
    if (!domains.some(domain => hostMatchesDomain(host, domain))) continue;

    const capabilities = (entry.capabilities ?? {}) as Record<string, unknown>;
    const siteSettings = snapshot?.siteSettings?.[entry.id] ?? {};
    const readerCss = typeof entry.styles?.reader === 'string' ? entry.styles.reader : '';
    const onReaderPage = matchesReaderPattern(entry.readerPattern);
    // reader 引导三重门：快照带类名（Rust 允许列表）+ 当前是正文页 +
    // 双栏偏好开启（localStorage 实时值）。
    const readerBoot = readerCss.length > 0
      && typeof entry.pagedClass === 'string'
      && entry.pagedClass.length > 0
      && onReaderPage
      && readerPreferenceEnabled(entry.id);
    // reader 在前 wide 在后：同特异性的书页宽度变量靠文档顺序让 wide 覆盖
    // reader 的 80% 基线（与插件 applyStyleFile 注入顺序一致）。wide 与插件
    // 语义对齐：仅在正文页注入（首页/书架无对应选择器，但也不必提前套用）。
    const wants: Array<[string, unknown, boolean]> = [
      ['reader', readerCss, readerBoot],
      ['wide', entry.styles?.wide, onReaderPage && siteSettings.readerWide === true],
      // 深色加深覆盖（theme-night.css）：与插件一致无条件注入——规则全部
      // 锚定 [data-theme=dark]，非深色主题不匹配，首绘即最终深色。
      ['night', entry.styles?.night, true],
      [
        'navbar',
        entry.styles?.navbar,
        capabilities.hideNavbar === true && siteSettings.hideNavbar === true,
      ],
      [
        'toolbar',
        entry.styles?.toolbar,
        capabilities.hideToolbar === true && siteSettings.hideToolbar === true,
      ],
    ];
    for (const [key, css, enabled] of wants) {
      if (enabled !== true || typeof css !== 'string' || css.length === 0) continue;
      const id = `${BOOT_PREFIX}${key}`;
      if (document.getElementById(id)) continue;
      try {
        const style = document.createElement('style');
        style.id = id;
        style.textContent = css;
        (document.head ?? document.documentElement).appendChild(style);
      } catch {
        /* ignore */
      }
    }
    if (readerBoot && typeof entry.pagedClass === 'string') {
      applyPagedClass(entry.pagedClass);
    }
    if (entry.bootTheme) applyThemeBoot(entry.bootTheme);
  }
};

/** 移除引导样式与主题守卫；幂等，之后由插件样式/站点 JS 接管。 */
export const settleBootStyles = (): void => {
  stopThemeBoot();
  try {
    document.querySelectorAll(`style[id^="${BOOT_PREFIX}"]`).forEach(el => el.remove());
  } catch {
    /* ignore */
  }
};
