import { chapterManager } from './chapter_manager';
function navigateToChapterTitle(title: string): void {
    const normalized = title.replace(/\s+/g, '');
    const chapters = chapterManager.getChapters();
    // 目录项带「第N章 」前缀，用去空白后缀匹配；同名章取最后一个
    let target: (typeof chapters)[number] | null = null;
    for (const chapter of chapters) {
      const chapterTitle = (chapter.title ?? '').replace(/\s+/g, '');
      if (chapterTitle.endsWith(normalized) || normalized.endsWith(chapterTitle)) {
        target = chapter;
      }
    }
    if (!target) {
      return;
    }
    const url = chapterManager.buildChapterUrl(target.chapterIdx);
    if (!url) return;
    window.location.href = url;
  }

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

const scrollWeReadToCurrentChapter = (doc: Document): void => {
  const panel = doc.querySelector<HTMLElement>('.readerCatalog');
  if (!panel || doc.defaultView?.getComputedStyle(panel).display === 'none' || panel.getBoundingClientRect().width === 0) return;
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
  const timer = setTimeout(() => scrollWeReadToCurrentChapter(doc), 350);
  return () => {
    clearTimeout(timer);
    for (const detach of detachers) detach();
  };
};


export function openToc(doc: Document = document): 'opened' | 'not-found' {
  const trigger = doc.querySelector<HTMLElement>('.readerControls button.catalog,button.readerControls_item.catalog');
  if (!trigger) return 'not-found';
  activeDismissCleanup?.();
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

    if (invokeReactOnClick(trigger)) return 'opened';
    if (!doc.querySelector('.readerCatalog')) return 'not-found';
    const style = doc.createElement('style');
    style.setAttribute('data-atreader-toc-reveal', '');
    style.textContent = 'html body .readerCatalog {display:block!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important;z-index:2147483200!important}';
    doc.head.append(style);
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
      navigateToChapterTitle(title);
      activeDismissCleanup?.();
    });
    if (detach) detachWheelGuard = detach;
    armDismissCleanup(
      doc,
      cleanupAll,
      (target) => !!target?.closest('.readerCatalog'),
    );
    return 'opened';
}

export function closeToc(doc: Document = document): boolean {
  if (activeDismissCleanup) { activeDismissCleanup(); return true; }
  const panel = doc.querySelector<HTMLElement>('.readerCatalog');
  if (!panel || panel.getBoundingClientRect().width === 0 || doc.defaultView?.getComputedStyle(panel).display === 'none') return false;
  const trigger = doc.querySelector<HTMLElement>('.readerControls button.catalog,button.readerControls_item.catalog');
  if (!trigger) return false;
  if (!invokeReactOnClick(trigger)) trigger.click();
  return true;
}
