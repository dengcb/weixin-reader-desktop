/**
 * 跨站点「打开章节目录」入口（蓝牙遥控菜单键长按 0.5s 触发）。
 *
 * 各站打开方式分三类（真机逐一验证过，勿轻易合并）：
 * - CSS 强制显示：面板/抽屉本就渲染在 DOM 里（display:none），注入样式放开，
 *   不弹工具栏、无闪现——微信读书（另补滚动/定位/选章补丁）与七猫（:hover
 *   驱动的 flyout，合成事件触发不了 :hover）；
 * - 点击路径：起点/得到/番茄/多看/掌阅，入口被「隐藏工具栏」收起时先临时
 *   撤掉隐藏样式再点（起点/得到关闭态宽高由站点 JS 惰性设置，强制显示无效）；
 * - React 直调：能从 DOM 节点找到 __reactProps$/__reactFiber$ 的站点优先调用
 *   其 onClick（站点状态机原生接管），微信读书当前未暴露、自动落回强制方案。
 *
 * 站点官方脚本均为压缩框架包，没有暴露打开目录的窗口级入口。
 */

export type TocOpenOutcome = 'opened' | 'already-open' | 'not-found';

const textOf = (element: HTMLElement): string =>
  [
    element.textContent ?? '',
    element.getAttribute('aria-label') ?? '',
    element.getAttribute('title') ?? '',
  ]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

/** isTrusted 是原型 getter，实例上重定义可骗过只读该字段的反自动化校验。 */
const spoofTrusted = (event: Event): void => {
  try {
    Object.defineProperty(event, 'isTrusted', { value: true });
  } catch {
    // 引擎拒绝重定义则保持原样
  }
};

const click = (element: HTMLElement): TocOpenOutcome => {
  // 部分站点（如微信读书）忽略不可信点击：按真实点击顺序（含 pointerup）
  // 与常用字段派发，并把 isTrusted 伪装为可信。
  const view = element.ownerDocument.defaultView ?? window;
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const base: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view,
    button: 0,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
  };
  const fire = (event: Event): void => {
    spoofTrusted(event);
    element.dispatchEvent(event);
  };
  if (typeof view.PointerEvent === 'function') {
    fire(
      new view.PointerEvent('pointerdown', {
        ...base,
        buttons: 1,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      }),
    );
  }
  fire(new view.MouseEvent('mousedown', { ...base, buttons: 1, detail: 1 }));
  if (typeof view.PointerEvent === 'function') {
    fire(
      new view.PointerEvent('pointerup', {
        ...base,
        buttons: 0,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      }),
    );
  }
  fire(new view.MouseEvent('mouseup', { ...base, buttons: 0, detail: 1 }));
  fire(new view.MouseEvent('click', { ...base, buttons: 0, detail: 1 }));
  return 'opened';
};

const byText = (
  doc: Document,
  scope: string | null,
  label: string,
): HTMLElement | null => {
  const root = scope ? doc.querySelector(scope) : doc;
  if (!root) return null;
  const nodes = Array.from(
    root.querySelectorAll<HTMLElement>(
      'button, [role="button"], a, li, div, span',
    ),
  );
  const matches = nodes.filter((element) => {
    const text = textOf(element);
    return text === label || text.split(' ').includes(label);
  });
  if (matches.length === 0) return null;
  // 取最深的匹配节点：它一定位于真实按钮/链接内部，点击可向上冒泡；
  // 若取最外层容器（textContent 也含「目录」），点了不会触发按钮处理器。
  const deepest = matches.filter(
    (element) =>
      !matches.some((other) => other !== element && element.contains(other)),
  );
  return deepest[deepest.length - 1] ?? null;
};

const findTrigger = (siteId: string, doc: Document): HTMLElement | null => {
  switch (siteId) {
    case 'weread':
      return (
        doc.querySelector<HTMLElement>('.readerControls button.catalog') ??
        doc.querySelector<HTMLElement>('button.readerControls_item.catalog')
      );
    case 'fanqie': {
      const icon = doc.querySelector<HTMLElement>(
        '.muyeicon-icon-chapter-menu',
      );
      const item = icon?.closest('.reader-toolbar-item') as HTMLElement | null;
      return (
        item ??
        byText(doc, '.reader-toolbar', '目录') ??
        byText(doc, null, '目录')
      );
    }
    case 'qidian':
      return byText(doc, '#r-menu', '目录');
    case 'qimao':
      return (
        doc.querySelector<HTMLElement>('.qm-fixed-right-item.catalog a') ??
        doc.querySelector<HTMLElement>('.qm-fixed-right-item.catalog') ??
        doc.querySelector<HTMLElement>('.qm-fixed-right .catalog')
      );
    case 'ireader':
      return (
        doc.querySelector<HTMLElement>(
          '.atreader-ireader-toolbar button[data-role="catalog"]',
        ) ?? byText(doc, null, '目录')
      );
    case 'dedao':
      return (
        doc.querySelector<HTMLElement>(
          'button.reader-tool-button.right-button-group-first-button',
        ) ??
        byText(doc, '.iget-reader-toolbar', '目录') ??
        byText(doc, null, '目录')
      );
    case 'duokan':
      return (
        doc.querySelector<HTMLElement>('span.j-toc') ??
        doc.querySelector<HTMLElement>('.j-md-ctrl .j-toc') ??
        byText(doc, null, '目录')
      );
    case 'zread':
      // 左侧章节目录树常驻，无需打开；尝试把当前章滚动到可视区。
      doc
        .querySelector<HTMLElement>(
          'a[aria-current="page"], nav a.active, aside a.active',
        )
        ?.scrollIntoView({ block: 'center' });
      return null;
    default:
      return byText(doc, null, '目录');
  }
};

/** 各站「隐藏工具栏」样式元素 ID：临时禁用即可恢复站点原生布局。 */
const HIDE_TOOLBAR_STYLE_ID: Record<string, string> = {
  weread: 'wxrd-hide-toolbar',
  qidian: 'plugin-qidian-toolbar',
  qimao: 'plugin-qimao-toolbar',
};

interface ToolbarReveal {
  restore: () => void;
}

/**
 * 目录入口被「隐藏工具栏」藏起来时，站点的事件处理器可能直接忽略不可见
 * 按钮的点击。临时撤掉隐藏样式，让入口恢复原生布局后再点击。
 */
const revealToolbar = (siteId: string, doc: Document): ToolbarReveal | null => {
  const styleId = HIDE_TOOLBAR_STYLE_ID[siteId];
  if (styleId) {
    const style = doc.getElementById(styleId) as HTMLStyleElement | null;
    if (!style || style.disabled) return null;
    style.disabled = true;
    let restored = false;
    return {
      restore: () => {
        if (restored) return;
        restored = true;
        style.disabled = false;
      },
    };
  }
  if (siteId === 'dedao') {
    // 得到没有「隐藏工具栏」能力，但它的工具栏平时是站内自动隐藏的。
    const toolbar = doc.querySelector<HTMLElement>('.iget-reader-toolbar');
    const view = doc.defaultView;
    if (!toolbar || !view || view.getComputedStyle(toolbar).display !== 'none') {
      return null;
    }
    const style = doc.createElement('style');
    style.setAttribute('data-atreader-toc-reveal', '');
    style.textContent =
      'html body .iget-reader-toolbar { display: flex !important; visibility: visible !important; opacity: 1 !important; pointer-events: auto !important; }';
    (doc.head ?? doc.documentElement).appendChild(style);
    let restored = false;
    return {
      restore: () => {
        if (restored) return;
        restored = true;
        style.remove();
      },
    };
  }
  return null;
};

/**
 * 强制显示目录面板，直到用户下一次点击或按 Esc。
 * 站点官方脚本是压缩框架包、没有暴露打开目录的入口，但目录面板/抽屉
 * 本就渲染在 DOM 里（关闭态 display:none 或 transform 移出屏），
 * 直接注入样式放开即可，等效于替官方脚本完成「显示目录」这一步。
 */
const PANEL_FORCE_CSS: Record<string, string> = {
  // 微信读书关闭态是纯 display:none，放开即恢复原生布局（真机已验证）。
  // 起点/得到不在此列：它们的关闭态宽高由站点 JS 惰性设置（rect 0x0），
  // 强制显示会卡在零尺寸/屏外，走点击路径更可靠。
  weread:
    'display: block !important; visibility: visible !important; opacity: 1 !important; pointer-events: auto !important; z-index: 2147483200 !important;',
};

const forcePanelStyle = (
  siteId: string,
  doc: Document,
  css: string,
): HTMLStyleElement | null => {
  const hint = PANEL_HINT[siteId];
  if (!hint) return null;
  if (!doc.querySelector(hint)) return null;
  const style = doc.createElement('style');
  style.setAttribute('data-atreader-toc-reveal', '');
  style.textContent = `html body ${hint} { ${css} }`;
  (doc.head ?? doc.documentElement).appendChild(style);
  return style;
};

/** 任意 pointerdown（面板外）或 Esc 后 300ms 执行清理；30s 安全兜底。 */
let activeDismissCleanup: (() => void) | null = null;

const armDismissCleanup = (
  doc: Document,
  cleanup: () => void,
  /** 面板内的交互（拖滚动条、点章节）不应触发关闭。 */
  isInside?: (target: Element | null) => boolean,
): void => {
  const view = doc.defaultView;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const finish = (): void => {
    if (done) return;
    done = true;
    doc.removeEventListener('pointerdown', onPointer, true);
    doc.removeEventListener('keydown', onKey, true);
    if (timer) clearTimeout(timer);
    clearTimeout(safety);
    if (activeDismissCleanup === armed) activeDismissCleanup = null;
    cleanup();
  };
  const armed = finish;
  const safety = setTimeout(finish, 30000);
  function onPointer(event: Event): void {
    if (isInside?.((event.target as Element | null) ?? null)) return;
    if (timer) clearTimeout(timer);
    timer = (view?.setTimeout(finish, 300) ??
      setTimeout(finish, 300)) as ReturnType<typeof setTimeout>;
  }
  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') finish();
  }
  doc.addEventListener('pointerdown', onPointer, true);
  doc.addEventListener('keydown', onKey, true);
  activeDismissCleanup = armed;
};

const scheduleRevealRestore = (
  reveal: ToolbarReveal,
  doc: Document,
  siteId: string,
  holdMs = 250,
): void => {
  // 面板展开成功就提前恢复隐藏，别让用户看着工具栏干等
  const early = setTimeout(() => {
    if (panelOpen(siteId, doc)) reveal.restore();
  }, 500);
  setTimeout(() => {
    clearTimeout(early);
    reveal.restore();
  }, holdMs);
};

const tryInvokeReactOnClick = (element: HTMLElement, stub: unknown): boolean => {
  const anyElement = element as unknown as Record<string, unknown>;
  for (const key of Object.keys(anyElement)) {
    if (!key.startsWith('__react')) continue;
    const node = anyElement[key] as
      | { onClick?: unknown; memoizedProps?: { onClick?: unknown } }
      | undefined;
    const handler = node?.onClick ?? node?.memoizedProps?.onClick;
    if (typeof handler === 'function') {
      (handler as (event: unknown) => void).call(element, stub);
      return true;
    }
  }
  return false;
};

/**
 * 直接调用 React 挂在 DOM 节点上的 onClick 处理器（__reactProps$ / __reactFiber$）。
 * 站点状态机自己接管目录开合（滚动初始化、当前章定位、再点收起），
 * 比合成事件可靠——微信读书会忽略合成点击，纯 CSS 强制又缺状态。
 * 处理器可能挂在祖先元素上，沿父链向上找几层。
 */
const invokeReactOnClick = (element: HTMLElement): boolean => {
  const stub = {
    preventDefault: () => {},
    stopPropagation: () => {},
    nativeEvent: null,
    target: element,
    currentTarget: element,
  };
  let current: HTMLElement | null = element;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (tryInvokeReactOnClick(current, stub)) return true;
    current = current.parentElement;
  }
  return false;
};

const clickNative = (element: HTMLElement): TocOpenOutcome => {
  // 原生 click() 只派发 click 事件，但会执行 <a> 的默认动作——
  // 七猫等站点的目录链接靠 href/javascript 或框架默认行为展开。
  element.click();
  return 'opened';
};

/** 这些站的入口是 <a>/Vue/React 组件，优先走原生 click()。 */
const NATIVE_CLICK_SITES = new Set(['dedao', 'duokan']);

const PANEL_HINT: Record<string, string> = {
  weread: '.readerCatalog',
  fanqie: '.reader-catalog',
  qidian: '#chapter-list',
  qimao: '.qm-fixed-right-extend',
  // 得到的 slide-bar 本体打开时仍是 0 宽（宽度在子级面板上），检测子级
  dedao: '.reader-slide-bar .iget-reader-catalog-wrapper',
  duokan: '.u-side-layer.j-md-toc',
};

const panelOpen = (siteId: string, doc: Document): boolean => {
  const hint = PANEL_HINT[siteId];
  if (!hint) return false;
  return Array.from(doc.querySelectorAll<HTMLElement>(hint)).some((el) => isShown(el));
};

const isShown = (element: HTMLElement): boolean => {
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  const cs = view.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return (
    cs.display !== 'none' &&
    cs.visibility !== 'hidden' &&
    Number(cs.opacity) > 0.01 &&
    rect.width > 0 &&
    rect.height > 0
  );
};

/**
 * 七猫的章节抽屉靠 CSS :hover 展开，合成事件触发不了 :hover；
 * 直接强制显示抽屉（章节列表就在其中），隐藏样式由调用方恢复。
 */
const openQimaoDrawer = (doc: Document): HTMLStyleElement | null => {
  const host = doc.querySelector('li.qm-fixed-right-item.catalog');
  if (!host) return null;
  const style = doc.createElement('style');
  style.setAttribute('data-atreader-toc-reveal', '');
  // 工具栏本身被站点/隐藏样式收起时连容器一起放开；只留目录项避免满栏噪音；
  // 抽屉是工具栏右侧的 flyout，翻到左侧避免溢出屏幕。
  style.textContent = [
    'html body .qm-fixed-right { display: flex !important; visibility: visible !important; opacity: 1 !important; transform: none !important; }',
    'html body .qm-fixed-right-item:not(.catalog) { display: none !important; }',
    'html body li.qm-fixed-right-item.catalog .qm-fixed-right-extend { display: block !important; visibility: visible !important; opacity: 1 !important; pointer-events: auto !important; left: auto !important; right: 100% !important; }',
  ].join('\n');
  (doc.head ?? doc.documentElement).appendChild(style);
  return style;
};

/**
 * 打开当前阅读页的目录。`already-open` 用于站点目录本身已展开的场景，
 * 调用方不应再提示失败。
 */
export const openReaderToc = (
  siteId: string,
  doc: Document = document,
): TocOpenOutcome => {
  // iReader 的原生抽屉已展开时，再点目录键会把它关掉。
  if (siteId === 'ireader') {
    const drawer = doc.querySelector<HTMLElement>('.directory-wrapper');
    if (drawer) {
      const opacity = doc.defaultView?.getComputedStyle(drawer).opacity;
      if (opacity && Number(opacity) > 0.5) return 'already-open';
    }
  }
  if (siteId === 'zread') return 'already-open';
  const trigger = findTrigger(siteId, doc);
  if (!trigger) return 'not-found';
  const extraStyles: HTMLStyleElement[] = [];
  let overlay: HTMLDivElement | null = null;
  let detachWheelGuard: (() => void) | null = null;
  const cleanupAll = (): void => {
    detachWheelGuard?.();
    detachWheelGuard = null;
    overlay?.remove();
    overlay = null;
    for (const style of extraStyles) style.remove();
    extraStyles.length = 0;
  };

  // 微信读书：React onClick 直调（同步、无延迟）；失败立即 CSS 强制显示——
  // 合成点击对微信已被多轮实证无效，不再等它 600ms，与其他书城同时弹出。
  if (siteId === 'weread') {
    if (invokeReactOnClick(trigger)) return 'opened';
    const style = forcePanelStyle('weread', doc, PANEL_FORCE_CSS.weread);
    if (!style) return 'not-found';
    extraStyles.push(style);
    const overlayEl = doc.createElement('div');
    overlayEl.setAttribute('data-atreader-toc-overlay', '');
    overlayEl.style.cssText =
      'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,0.45);';
    (doc.body ?? doc.documentElement).appendChild(overlayEl);
    overlay = overlayEl;
    const detach = applyWeReadForceExtras(doc, extraStyles, (title) => {
      // 站点状态机没参与，点章节不会自己导航：交给 RemoteManager 匹配
      // chapterManager 跳转，并同步收起目录。
      doc.defaultView?.dispatchEvent(
        new CustomEvent('atreader:toc-chapter-pick', { detail: { title } }),
      );
      cleanupAll();
    });
    if (detach) detachWheelGuard = detach;
    armDismissCleanup(
      doc,
      cleanupAll,
      (target) => !!target?.closest('.readerCatalog'),
    );
    return 'opened';
  }

  // 目录面板/抽屉已在 DOM 中的站点：直接注入样式显示，不模拟点击、不弹工具栏。
  // 面板缺失（懒加载站点）时落回下方的点击路径。
  const forceCss = PANEL_FORCE_CSS[siteId];
  if (forceCss) {
    const style = forcePanelStyle(siteId, doc, forceCss);
    if (style) {
      extraStyles.push(style);
      armDismissCleanup(doc, cleanupAll);
      return 'opened';
    }
  }

  // 七猫：章节抽屉嵌在工具栏内且靠 CSS :hover 展开，连容器一起强制显示
  if (siteId === 'qimao') {
    const style = openQimaoDrawer(doc);
    if (style) {
      extraStyles.push(style);
      armDismissCleanup(doc, cleanupAll);
    }
    return 'opened';
  }

  const reveal = revealToolbar(siteId, doc);
  if (NATIVE_CLICK_SITES.has(siteId)) {
    clickNative(trigger);
  } else {
    click(trigger);
  }

  if (reveal) {
    const holdMs = siteId === 'dedao' ? 600 : 250;
    scheduleRevealRestore(reveal, doc, siteId, holdMs);
  }
  return 'opened';
};

/** 强制显示后把微信读书目录滚动到当前章（站点原生靠 React 状态定位）。 */
const scrollWeReadToCurrentChapter = (doc: Document): void => {
  const panel = doc.querySelector<HTMLElement>('.readerCatalog');
  if (!panel || !isShown(panel)) return;
  const title = doc
    .querySelector('.renderTargetPageInfo_header_chapterTitle')
    ?.textContent?.trim();
  if (!title) return;
  const items = Array.from(
    panel.querySelectorAll<HTMLElement>('.readerCatalog_list_item_title'),
  );
  // 同名章（如多个番外同名）取最后一个，最接近当前进度
  let target: HTMLElement | null = null;
  for (const el of items) {
    if (isCatalogTitleMatch((el.textContent ?? '').trim(), title)) target = el;
  }
  if (!target) return;
  target.closest('li')?.classList.add('atreader-toc-current');
  target.scrollIntoView({ block: 'center' });
};

/**
 * 目录项文本与当前章标题的匹配：目录项带「第N章 」前缀，用去空白后的
 * 相等/后缀关系；同名章取最后一个（最接近当前进度）。
 */
export const isCatalogTitleMatch = (itemText: string, title: string): boolean => {
  const item = itemText.replace(/\s+/g, '');
  const head = title.replace(/\s+/g, '');
  return item.length > 0 && head.length > 0 && item.endsWith(head);
};

/**
 * 微信读书 CSS 强制方案的补丁：面板改 flex 列、滚动区 flex:1 形成滚动容器
 *（否则滚动区高度跟着 8 万像素的章节列表走，内部没有可滚溢出），按章节
 * 标题匹配定位当前章，并手动滚 scrollTop——站点在 document 捕获期就
 * preventDefault 了滚轮，浏览器默认滚动已不可救。
 * 站点状态机没参与，点章节不会自己导航：拦截点击交给 onPick（调用方导航）。
 */
const applyWeReadForceExtras = (
  doc: Document,
  extraStyles: HTMLStyleElement[],
  onPick?: (title: string) => void,
): (() => void) | null => {
  const scrollStyle = doc.createElement('style');
  scrollStyle.setAttribute('data-atreader-toc-reveal', '');
  scrollStyle.textContent = [
    'html body .readerCatalog { display: flex !important; flex-direction: column !important; }',
    // 滚动用我们自己的（wheel 手动 scrollTop），外侧 WebKit 滚动条藏起来，
    // 只留微信自带的 perfect-scrollbar 那条
    'html body .readerCatalog_list_scroll_area { overflow-y: auto !important; -webkit-overflow-scrolling: touch !important; flex: 1 1 auto !important; min-height: 0 !important; height: auto !important; scrollbar-width: none !important; }',
    'html body .readerCatalog_list_scroll_area::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }',
    'html body .readerCatalog_list_item.atreader-toc-current { background: rgba(52, 159, 102, 0.14) !important; }',
  ].join('\n');
  (doc.head ?? doc.documentElement).appendChild(scrollStyle);
  extraStyles.push(scrollStyle);
  const panel = doc.querySelector<HTMLElement>('.readerCatalog');
  const detachers: Array<() => void> = [];
  if (panel) {
    const onWheel = (event: WheelEvent): void => {
      const area = panel.querySelector<HTMLElement>(
        '.readerCatalog_list_scroll_area',
      );
      if (area) area.scrollTop += event.deltaY;
      event.preventDefault();
      event.stopPropagation();
    };
    panel.addEventListener('wheel', onWheel, { capture: true, passive: false });
    detachers.push(() =>
      panel.removeEventListener('wheel', onWheel, { capture: true }),
    );
    if (onPick) {
      const onItemClick = (event: Event): void => {
        const item = (event.target as Element | null)?.closest(
          '.readerCatalog_list_item',
        );
        const title = item
          ?.querySelector('.readerCatalog_list_item_title')
          ?.textContent?.trim();
        if (title) onPick(title);
      };
      panel.addEventListener('click', onItemClick);
      detachers.push(() => panel.removeEventListener('click', onItemClick));
    }
  }
  setTimeout(() => scrollWeReadToCurrentChapter(doc), 350);
  return () => {
    for (const detach of detachers) detach();
  };
};

/** 目录当前是否展开（遥控「单击收目录」的判定依据）。 */
export const isReaderTocOpen = (siteId: string, doc: Document = document): boolean => {
  if (siteId === 'ireader') {
    const drawer = doc.querySelector<HTMLElement>('.directory-wrapper');
    if (!drawer) return false;
    const opacity = doc.defaultView?.getComputedStyle(drawer).opacity;
    return !!opacity && Number(opacity) > 0.5;
  }
  return panelOpen(siteId, doc);
};

/**
 * 收起目录。强制显示的站点（微信/七猫）直接清理注入样式；站点自管的
 * 面板（起点/得到/多看/番茄/掌阅）再触发一次入口，站点按原逻辑收起。
 */
export const closeReaderToc = (siteId: string, doc: Document = document): boolean => {
  if (activeDismissCleanup) {
    const cleanup = activeDismissCleanup;
    activeDismissCleanup = null;
    cleanup();
    return true;
  }
  if (siteId === 'zread' || !isReaderTocOpen(siteId, doc)) return false;
  const trigger = findTrigger(siteId, doc);
  if (!trigger) return false;
  if (invokeReactOnClick(trigger)) return true;
  const reveal = revealToolbar(siteId, doc);
  if (NATIVE_CLICK_SITES.has(siteId)) clickNative(trigger);
  else click(trigger);
  if (reveal) scheduleRevealRestore(reveal, doc, siteId, siteId === 'dedao' ? 600 : 250);
  return true;
};
