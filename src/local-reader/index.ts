import { AppRuntime } from '../scripts/core/app_runtime';
import { createSiteContext } from '../scripts/core/site_context';
import { setLocalReaderController, type LocalReaderController } from '../scripts/core/local_runtime_bridge';
import { settingsStore } from '../scripts/core/settings_store';
import { invoke, logToFile, waitForTauri } from '../scripts/core/tauri';
import type { Chapter, PluginAPI } from '../scripts/core/plugin_types';
import { EPUB_DOCUMENT_TYPES, chapterBreakCss as buildChapterBreakCss, sanitizeEpubMarkup, wrapSvgSpineDocument } from './epub_security';
import { resolveLocalKeyboardAction } from './keyboard';
import { PositionHistory } from './position_history';
import { splitTxtChapters, txtChapterToXHTML, type TxtChapter } from './txt';
import { buildToc, type FlatTocItem, type TocTreeNode } from './toc';

// 固定提交的上游原生 ES modules；源码与 LICENSE 位于 third-party/foliate-js。
// @ts-expect-error vendored JavaScript module has no TypeScript declarations
import { EPUB } from '../../third-party/foliate-js/epub.js';
// @ts-expect-error vendored JavaScript module has no TypeScript declarations
import * as CFI from '../../third-party/foliate-js/epubcfi.js';
import '../../third-party/foliate-js/paginator.js';
import '../../third-party/foliate-js/fixed-layout.js';

type LocalBookFormat = 'txt' | 'epub';

interface LocalBookMetadata {
  bookId: string;
  format: LocalBookFormat;
  title: string;
  fileSize: number;
  modifiedAt: number;
  lastOpenedAt: number;
  fixedLayout: boolean;
}

interface LocalProgress {
  format: LocalBookFormat;
  cfi?: string;
  sectionIndex: number;
  sectionFraction: number;
  bookFraction?: number;
  chapterId: string;
  characterOffset?: number;
  updatedAt: number;
}

interface TocItem {
  label: string | Record<string, string>;
  href: string;
  subitems?: TocItem[];
}

interface BookSection {
  id?: string;
  cfi?: string;
  size?: number;
  linear?: string;
  load(): string | Promise<string>;
  unload?(): void;
  createDocument?(): Document | Promise<Document>;
  resolveHref?(href: string): string;
}

interface FoliateBook {
  sections: BookSection[];
  toc?: TocItem[];
  metadata?: { title?: string | Record<string, string>; language?: string };
  rendition?: { layout?: string };
  transformTarget?: EventTarget;
  dir?: string;
  resolveHref?(href: string): { index: number; anchor?: (doc: Document) => Node | Range | number | null } | null;
  resolveCFI?(cfi: string): { index: number; anchor?: (doc: Document) => Node | Range | number | null } | null;
  destroy?(): void;
}

interface RelocateDetail {
  reason?: string;
  range?: Range;
  index: number;
  fraction?: number;
  size?: number;
}

interface RendererElement extends HTMLElement {
  open(book: FoliateBook): void;
  goTo(target: { index: number; anchor?: unknown }): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  nextSection?(): Promise<void>;
  prevSection?(): Promise<void>;
  setStyles?(styles: string | [string, string]): void;
  destroy?(): void;
  /** foliate-paginator 公开 getter；固定版式渲染器无此属性。 */
  readonly page?: number;
  readonly pages?: number;
}

interface LocalTypography {
  columnMode: 'single' | 'double';
  theme: 'light' | 'dark';
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  paragraphSpacing: number;
  pagePaddingX: number;
}

// 系统默认字体：macOS 解析为苹方，Windows 解析为 Segoe UI + 微软雅黑，
// 无版权依赖，也无需缓存内置字体。
const SYSTEM_FONT = 'system-ui, -apple-system, PingFang SC, Microsoft YaHei, sans-serif';

const DEFAULT_TYPOGRAPHY: LocalTypography = {
  columnMode: 'double',
  theme: 'light',
  fontFamily: SYSTEM_FONT,
  fontSize: 28,
  lineHeight: 1.8,
  paragraphSpacing: 1,
  pagePaddingX: 0,
};

// 正文默认细体：macOS 苹方/宋体、Windows 雅黑均有 Light 字重可用；
// 个别无 Light 变体的字体会由浏览器回退到最接近字重，属可接受的降级。
const CONTENT_FONT_WEIGHT = 300;

const LOCAL_FONTS = new Set([
  SYSTEM_FONT,
  'Songti SC, STSong, serif',
  'Kaiti SC, STKaiti, serif',
  'PingFang SC, Microsoft YaHei, sans-serif',
]);

const boundedNumber = (value: unknown, min: number, max: number, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

const element = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`缺少本地阅读界面元素：${id}`);
  return value as T;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const localReaderLog = (stage: string, details?: Record<string, unknown>): void => {
  const suffix = details ? ` ${JSON.stringify(details)}` : '';
  const message = `[LocalReader] ${stage}${suffix}`;
  console.info(message);
  logToFile(message);
};

const localReaderError = (message: string): string => {
  if (/Failed to load package document|No package document defined/i.test(message)) {
    return 'EPUB 缺少可读取的 package 文档';
  }
  if (/Failed to load section|Failed to load resource/i.test(message)) {
    return 'EPUB 章节资源无法读取';
  }
  if (/Invalid (?:archive|zip)|End of central directory|central directory/i.test(message)) {
    return 'EPUB 文件损坏或不是有效的 EPUB 文件';
  }
  if (/MISSING:/i.test(message)) return '图书文件已不存在';
  return message;
};

const EPUB_OPTIONAL_TEXT_ENTRIES = new Set([
  'META-INF/encryption.xml',
  'META-INF/com.apple.ibooks.display-options.xml',
  'META-INF/com.kobobooks.display-options.xml',
]);

const fetchChecked = async (url: string, stage = 'request'): Promise<Response> => {
  const response = await fetch(url);
  if (response.ok) return response;
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = await response.text();
    message = (JSON.parse(body) as { error?: string }).error ?? message;
  } catch { /* noop */ }
  localReaderLog('request_failed', {
    stage,
    url,
    status: response.status,
    message,
  });
  throw new Error(localReaderError(message));
};

const withTimeout = <T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
};

const createTxtBook = (chapters: TxtChapter[], title: string): FoliateBook => {
  const urls = new Map<number, string>();
  const parser = new DOMParser();
  const sections: BookSection[] = chapters.map((chapter, index) => ({
    id: chapter.id,
    cfi: CFI.fake.fromIndex(index),
    size: new TextEncoder().encode(chapter.text).length,
    load: () => {
      const old = urls.get(index);
      if (old) URL.revokeObjectURL(old);
      const url = URL.createObjectURL(new Blob([txtChapterToXHTML(chapter)], { type: 'application/xhtml+xml' }));
      urls.set(index, url);
      return url;
    },
    unload: () => {
      const url = urls.get(index);
      if (url) URL.revokeObjectURL(url);
      urls.delete(index);
    },
    createDocument: () => parser.parseFromString(txtChapterToXHTML(chapter), 'application/xhtml+xml'),
  }));
  return {
    sections,
    dir: 'ltr',
    metadata: { title, language: 'zh-CN' },
    toc: chapters.map((chapter, index) => ({ label: chapter.title, href: `txt:${index}` })),
    resolveHref: (href: string) => {
      const match = href.match(/^txt:(\d+)$/);
      return match ? { index: Number(match[1]), anchor: () => 0 } : null;
    },
    resolveCFI: (cfi: string) => {
      const parts = CFI.parse(cfi);
      const index = CFI.fake.toIndex((parts.parent ?? parts).shift());
      return { index, anchor: (doc: Document) => CFI.toRange(doc, parts) };
    },
    destroy: () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    },
  };
};

class LocalReader implements LocalReaderController {
  private readonly bookId: string;
  private metadata: LocalBookMetadata | null = null;
  private book: FoliateBook | null = null;
  private renderer: RendererElement | null = null;
  private typography: LocalTypography = { ...DEFAULT_TYPOGRAPHY };
  private pluginAPI: PluginAPI | null = null;
  private unsubscribeSettings: (() => void) | null = null;
  private ready = false;
  private fixedLayout = false;
  private currentSection = 0;
  private currentFraction = 0;
  private currentCFI: string | undefined;
  private currentCharacterOffset: number | undefined;
  private currentPage = 1;
  private totalPages = 1;
  private lastEpubError: string | null = null;
  private lastProgressUpdatedAt = 0;
  private toc: FlatTocItem[] = [];
  private tocTree: TocTreeNode[] = [];
  /** 当前 section 内各目录项的锚点节点，用于区分同文件内的多个章节。 */
  private sectionAnchors: Array<{ position: number; node: Node }> | null = null;
  private currentRange: Range | null = null;
  /** 目录点击意图：导航完成后直接采用所点目录项，不依赖可见范围反推。 */
  private overrideTocPosition: number | null = null;
  private readonly positionHistory = new PositionHistory<LocalProgress>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private runtime: AppRuntime | null = null;
  private keyHandler: ((event: KeyboardEvent) => void) | null = null;
  private visibilityHandler: (() => void) | null = null;
  private resizeHandler: (() => void) | null = null;
  private destroyed = false;

  constructor(bookId: string) {
    this.bookId = bookId;
  }

  async initialize(): Promise<void> {
    localReaderLog('initialize_start', { bookId: this.bookId });
    localReaderLog('tauri_wait_start', { bookId: this.bookId });
    await waitForTauri();
    localReaderLog('tauri_api_state', { bookId: this.bookId, available: Boolean(window.__TAURI__) });
    if (!window.__TAURI__) throw new Error('本地阅读服务尚未就绪，请重新打开图书');
    await withTimeout(settingsStore.init(), 8_000, '本地阅读初始化超时，请重新打开图书');
    localReaderLog('settings_ready', { bookId: this.bookId });
    this.metadata = await withTimeout(
      invoke<LocalBookMetadata>('get_local_book', { bookId: this.bookId }),
      8_000,
      '读取本地图书信息超时，请重新打开图书',
    );
    localReaderLog('metadata_loaded', {
      bookId: this.bookId,
      format: this.metadata.format,
      fileSize: this.metadata.fileSize,
      fixedLayout: this.metadata.fixedLayout,
    });
    this.fixedLayout = this.metadata.fixedLayout;
    this.typography = this.readTypography();
    this.book = this.metadata.format === 'txt'
      ? await this.loadTxtBook()
      : await this.loadEpubBook();
    localReaderLog('book_loaded', {
      bookId: this.bookId,
      format: this.metadata.format,
      sections: this.book.sections.length,
    });
    this.fixedLayout = this.book.rendition?.layout === 'pre-paginated' || this.fixedLayout;
    const toc = buildToc(this.book.toc ?? []);
    this.toc = toc.flat;
    this.tocTree = toc.tree;
    this.resolveTocIndices();
    this.createRenderer();
    localReaderLog('renderer_created', { bookId: this.bookId, fixedLayout: this.fixedLayout });
    this.bindUI();
    this.applyTypography();
    await this.restorePosition();
    localReaderLog('position_restored', { bookId: this.bookId });
    this.ready = true;
    setLocalReaderController(this);
    this.runtime = new AppRuntime('local');
    await this.runtime.initialize();
    this.unsubscribeSettings = settingsStore.subscribe(() => {
      this.typography = this.readTypography();
      this.applyTypography();
    });
    this.updateTitles();
    this.renderChapterList();
    this.hideLoading();
    this.setupKeyboard();
    window.__ATREADER_RUNTIME__ = this;
  }

  private readTypography(): LocalTypography {
    const config = settingsStore.getPluginConfig('local');
    const fontFamily = typeof config.fontFamily === 'string' && LOCAL_FONTS.has(config.fontFamily)
      ? config.fontFamily
      : DEFAULT_TYPOGRAPHY.fontFamily;
    return {
      columnMode: config.columnMode === 'single' ? 'single' : 'double',
      theme: config.theme === 'dark' ? 'dark' : 'light',
      fontFamily,
      fontSize: boundedNumber(config.fontSize, 20, 36, DEFAULT_TYPOGRAPHY.fontSize),
      lineHeight: boundedNumber(config.lineHeight, 1.3, 2.5, DEFAULT_TYPOGRAPHY.lineHeight),
      paragraphSpacing: boundedNumber(config.paragraphSpacing, 0, 2.5, DEFAULT_TYPOGRAPHY.paragraphSpacing),
      pagePaddingX: boundedNumber(config.pagePaddingX, 0, 60, DEFAULT_TYPOGRAPHY.pagePaddingX),
    };
  }

  private async loadTxtBook(): Promise<FoliateBook> {
    const response = await fetchChecked(`/local/books/${this.bookId}/text`, 'txt.text');
    const chapters = splitTxtChapters(await response.text(), this.metadata!.title);
    localReaderLog('txt_loaded', { bookId: this.bookId, chapters: chapters.length });
    return createTxtBook(chapters, this.metadata!.title);
  }

  private async loadEpubBook(): Promise<FoliateBook> {
    this.lastEpubError = null;
    localReaderLog('epub_entries_start', { bookId: this.bookId });
    const response = await fetchChecked(`/local/books/${this.bookId}/entries`, 'epub.entries');
    const entries = await response.json() as Array<{ name: string; size: number }>;
    if (!entries.length) throw new Error('EPUB 没有可读取的资源');
    localReaderLog('epub_entries_loaded', {
      bookId: this.bookId,
      count: entries.length,
      totalBytes: entries.reduce((total, entry) => total + entry.size, 0),
    });
    const sizes = new Map(entries.map(entry => [entry.name, entry.size]));
    const entryURL = (name: string) => `/local/books/${this.bookId}/entry?name=${encodeURIComponent(name)}`;
    const loadEntry = async (name: string, stage: string): Promise<Response> => {
      const url = entryURL(name);
      try {
        return await fetchChecked(url, stage);
      } catch (error) {
        this.lastEpubError = errorMessage(error);
        localReaderLog('epub_entry_failed', {
          bookId: this.bookId,
          stage,
          name,
          error: errorMessage(error),
        });
        throw error;
      }
    };
    const loader = {
      loadText: async (name: string) => {
        try {
          const result = await loadEntry(name, 'epub.entry.text');
          return result.text();
        } catch (error) {
          // Foliate treats encryption.xml as optional. A normal, unencrypted
          // EPUB must continue initialization when this entry is absent.
          if (EPUB_OPTIONAL_TEXT_ENTRIES.has(name)) {
            this.lastEpubError = null;
            localReaderLog('epub_optional_entry_missing', { bookId: this.bookId, name });
            return null;
          }
          throw error;
        }
      },
      loadBlob: async (name: string) => {
        const result = await loadEntry(name, 'epub.entry.blob');
        return result.blob();
      },
      getSize: (name: string) => sizes.get(name) ?? 0,
      sha1: async (value: string) => new Uint8Array(await invoke<number[]>('local_sha1', { value })),
    };
    let book: FoliateBook;
    try {
      book = await new EPUB(loader).init() as FoliateBook;
    } catch (error) {
      localReaderLog('epub_init_failed', {
        bookId: this.bookId,
        error: errorMessage(error),
      });
      throw new Error(localReaderError(errorMessage(error)));
    }
    localReaderLog('epub_initialized', {
      bookId: this.bookId,
      sections: book.sections.length,
      toc: book.toc?.length ?? 0,
      layout: book.rendition?.layout ?? 'reflowable',
    });
    const spineDocuments = new Set(
      book.sections.map(section => section.id).filter((id): id is string => Boolean(id)),
    );
    book.sections = book.sections.map((section) => {
      const originalLoad = section.load.bind(section);
      return {
        ...section,
        load: async () => {
          try {
            const source = await originalLoad();
            if (!source) throw new Error(`EPUB 章节资源为空：${section.id ?? '未知章节'}`);
            return source;
          } catch (error) {
            this.lastEpubError = errorMessage(error);
            throw error;
          }
        },
      };
    });
    book.transformTarget?.addEventListener('load', (event) => {
      const detail = (event as CustomEvent<{ isScript?: boolean; allow: boolean }>).detail;
      if (detail.isScript) detail.allow = false;
    });
    book.transformTarget?.addEventListener('data', (event) => {
      const detail = (event as CustomEvent<{ data: unknown; type: string; readonly name: string }>).detail;
      if (!EPUB_DOCUMENT_TYPES.has(detail.type)) return;
      const mediaType = detail.type;
      const wrapSpineSvg = mediaType === 'image/svg+xml' && spineDocuments.has(detail.name);
      if (wrapSpineSvg) detail.type = 'application/xhtml+xml';
      detail.data = Promise.resolve(detail.data).then(data => {
        if (typeof data !== 'string') return data;
        return wrapSpineSvg
          ? wrapSvgSpineDocument(data)
          : sanitizeEpubMarkup(data, mediaType, this.chapterBreakCss(detail.name));
      }).catch(error => {
        this.lastEpubError = errorMessage(error);
        localReaderLog('epub_transform_failed', {
          bookId: this.bookId,
          name: detail.name,
          error: this.lastEpubError,
        });
        throw error;
      });
    });
    return book;
  }

  private createRenderer(): void {
    const tag = this.fixedLayout ? 'foliate-fxl' : 'foliate-paginator';
    const renderer = document.createElement(tag) as RendererElement;
    renderer.setAttribute('exportparts', 'head,foot,filter');
    if (this.fixedLayout) renderer.setAttribute('zoom', 'fit-page');
    else {
      renderer.setAttribute('flow', 'paginated');
      renderer.setAttribute('margin', '54px');
      renderer.setAttribute('gap', '8%');
      renderer.setAttribute('max-block-size', '1440px');
    }
    renderer.addEventListener('load', (event) => this.onSectionLoad(event as CustomEvent<{ doc: Document; index: number }>));
    renderer.addEventListener('relocate', (event) => this.onRelocate(event as CustomEvent<RelocateDetail>));
    renderer.open(this.book!);
    element('readerStage').append(renderer);
    this.renderer = renderer;
  }

  private onSectionLoad(event: CustomEvent<{ doc: Document; index: number }>): void {
    const { doc, index } = event.detail;
    localReaderLog('section_loaded', { bookId: this.bookId, index });
    doc.querySelectorAll('script').forEach(script => script.remove());
    // 同一 section 内的多个目录项（整部一书、章为锚点）记录锚点节点，
    // 供 currentTocPosition 按文档顺序区分具体章节；无 hash 的项视为章节开头。
    const anchors: Array<{ position: number; node: Node }> = [];
    this.toc.forEach((item, position) => {
      if (item.index !== index) return;
      const node = item.hash
        ? doc.getElementById(item.hash)
          ?? doc.querySelector(`[name="${CSS.escape(item.hash)}"]`)
        : doc.body;
      if (node) anchors.push({ position, node });
    });
    this.sectionAnchors = anchors.length ? anchors : null;
    // 正文在 iframe 内，点击不会冒泡到外层 document；在文档内挂关闭面板钩子。
    doc.addEventListener('click', () => this.closePanels());
    doc.addEventListener('click', (clickEvent) => {
      const anchor = (clickEvent.target as Element | null)?.closest?.('a[href]');
      if (!anchor || !this.book?.resolveHref) return;
      const href = anchor.getAttribute('href');
      if (!href) return;
      clickEvent.preventDefault();
      const absoluteHref = this.book.sections[index]?.resolveHref?.(href) ?? href;
      const resolved = this.book.resolveHref(absoluteHref);
      if (!resolved) return;
      void this.navigate(resolved, true);
    });
  }

  private onRelocate(event: CustomEvent<RelocateDetail>): void {
    const detail = event.detail;
    const oldSection = this.currentSection;
    // 新的位置报告到来即取代点击意图；goTo 期间的中间报告发生在意图设置之前，不受影响。
    this.overrideTocPosition = null;
    this.currentSection = Number.isFinite(detail.index) ? detail.index : this.currentSection;
    this.currentFraction = Math.min(1, Math.max(0, detail.fraction ?? 0));
    if (detail.size && detail.size > 0) {
      // 优先直接读分页器公开的 page/pages（0 基跨页序号）：relocate 的
      // fraction=(page-1)/(pages-2) 与 0 基 page 错位，首两个跨页会同显“第 1 页”，
      // 造成首次翻页进度不动。总跨页数 = pages-1（含首尾内边距各约半页）。
      const spreadPage = this.renderer?.page;
      const spreadPages = this.renderer?.pages;
      if (typeof spreadPage === 'number' && Number.isFinite(spreadPage)
        && typeof spreadPages === 'number' && spreadPages > 1) {
        this.totalPages = spreadPages - 1;
        this.currentPage = Math.min(this.totalPages, spreadPage + 1);
      } else {
        this.totalPages = Math.max(1, Math.round(1 / detail.size));
        this.currentPage = Math.min(this.totalPages, Math.floor(this.currentFraction / detail.size) + 1);
      }
    } else {
      this.currentPage = 1;
      this.totalPages = 1;
    }
    this.currentCFI = this.makeCFI(detail.index, detail.range);
    this.currentRange = detail.range ?? null;
    this.currentCharacterOffset = this.metadata?.format === 'txt'
      ? this.characterOffsetFromRange(detail.range)
      : undefined;
    element('pageProgress').textContent = `${this.currentPage} / ${this.totalPages}`;
    this.updateTitles();
    this.updateActiveChapter();
    this.positionHistory.replace(this.currentProgress());
    this.scheduleProgressSave();
    if (oldSection !== this.currentSection) {
      window.dispatchEvent(new CustomEvent('ipc:chapter-changed', {
        detail: { url: location.href, pathname: location.pathname },
      }));
    }
  }

  private makeCFI(index: number, range?: Range): string | undefined {
    const base = this.book?.sections[index]?.cfi ?? CFI.fake.fromIndex(index);
    try { return range ? CFI.joinIndir(base, CFI.fromRange(range)) : base; }
    catch { return base; }
  }

  private characterOffsetFromRange(range?: Range): number | undefined {
    if (!range) return undefined;
    const doc = range.startContainer.ownerDocument;
    if (!doc?.body) return undefined;
    try {
      const before = doc.createRange();
      before.selectNodeContents(doc.body);
      before.setEnd(range.startContainer, range.startOffset);
      return before.toString().length;
    } catch {
      return undefined;
    }
  }

  private textAnchor(characterOffset: number): (doc: Document) => Range | number {
    return (doc: Document) => {
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      let remaining = Math.max(0, characterOffset);
      let node: Node | null = walker.nextNode();
      while (node) {
        const length = node.textContent?.length ?? 0;
        if (remaining <= length) {
          const range = doc.createRange();
          range.setStart(node, remaining);
          range.collapse(true);
          return range;
        }
        remaining -= length;
        node = walker.nextNode();
      }
      return 1;
    };
  }

  private currentProgress(): LocalProgress {
    this.lastProgressUpdatedAt = Math.max(Date.now(), this.lastProgressUpdatedAt + 1);
    return {
      format: this.metadata!.format,
      cfi: this.metadata!.format === 'epub' ? this.currentCFI : undefined,
      sectionIndex: this.currentSection,
      sectionFraction: this.currentFraction,
      bookFraction: (this.currentSection + this.currentFraction)
        / Math.max(1, this.book?.sections.length ?? 1),
      chapterId: this.book?.sections[this.currentSection]?.id ?? String(this.currentSection),
      characterOffset: this.metadata!.format === 'txt' ? this.currentCharacterOffset : undefined,
      updatedAt: this.lastProgressUpdatedAt,
    };
  }

  private async restorePosition(): Promise<void> {
    const enabled = settingsStore.getGlobal().lastPage !== false;
    const progress = enabled
      ? await invoke<LocalProgress | null>('get_local_reading_progress', { bookId: this.bookId })
      : null;
    let target: { index: number; anchor?: unknown } = { index: this.firstLinearSection() };
    if (progress) target = this.progressTarget(progress);
    localReaderLog('restore_start', {
      bookId: this.bookId,
      index: target.index,
      hasAnchor: target.anchor !== undefined,
    });
    let timeoutId = 0;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = window.setTimeout(() => reject(new Error('本地 EPUB 首章加载超时')), 12_000);
    });
    try {
      await Promise.race([this.renderer!.goTo(target), timeout]);
    } finally {
      window.clearTimeout(timeoutId);
    }
    if (this.lastEpubError) {
      throw new Error(`EPUB 章节无法读取：${this.lastEpubError}`);
    }
    this.positionHistory.reset(this.currentProgress());
  }

  private firstLinearSection(): number {
    const index = this.book?.sections.findIndex(section => section.linear !== 'no') ?? 0;
    return Math.max(0, index);
  }

  private scheduleProgressSave(): void {
    if (settingsStore.getGlobal().lastPage === false || !this.ready) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persistProgressNow();
    }, 500);
  }

  private persistProgressNow(): void {
    if (!this.ready || settingsStore.getGlobal().lastPage === false || !this.metadata || !this.book) return;
    void invoke('save_local_reading_progress', {
      bookId: this.bookId,
      progress: this.currentProgress(),
    }).catch(error => console.warn('[LocalReader] 无法保存阅读进度', error));
  }

  private progressTarget(progress: LocalProgress): { index: number; anchor?: unknown } {
    if (progress.format === 'epub' && progress.cfi && this.book?.resolveCFI) {
      const resolved = this.book.resolveCFI(progress.cfi);
      if (resolved && this.isValidSectionIndex(resolved.index)) return resolved;
    }
    const fallbackIndex = this.fallbackSectionIndex(progress);
    if (progress.format === 'txt') {
      const chapterIndex = this.book?.sections.findIndex(section => section.id === progress.chapterId) ?? -1;
      const index = chapterIndex >= 0 ? chapterIndex : fallbackIndex;
      if (Number.isInteger(progress.characterOffset) && progress.characterOffset! >= 0) {
        return { index, anchor: this.textAnchor(progress.characterOffset!) };
      }
      return { index, anchor: progress.sectionFraction };
    }
    return { index: fallbackIndex, anchor: progress.sectionFraction };
  }

  private isValidSectionIndex(index: number): boolean {
    return Number.isInteger(index) && index >= 0 && index < (this.book?.sections.length ?? 0);
  }

  private fallbackSectionIndex(progress: LocalProgress): number {
    if (this.isValidSectionIndex(progress.sectionIndex)) return progress.sectionIndex;
    const sections = Math.max(1, this.book?.sections.length ?? 1);
    const fraction = Math.min(.999999, Math.max(0, progress.bookFraction ?? 0));
    return Math.floor(fraction * sections);
  }

  private async navigate(target: { index: number; anchor?: unknown }, recordHistory: boolean): Promise<void> {
    if (!recordHistory) {
      await this.renderer?.goTo(target);
      return;
    }
    await this.positionHistory.record(
      this.currentProgress(),
      () => this.renderer?.goTo(target),
      () => this.currentProgress(),
    );
  }

  private resolveTocIndices(): void {
    if (!this.book?.resolveHref) return;
    for (const item of this.toc) item.index = this.book.resolveHref(item.href)?.index ?? -1;
  }

  /**
   * 收集指向该文档的目录锚点并生成“每章起新栏”样式；无锚点的文档返回空。
   * 分页器是原生 CSS 多栏，单列模式下新栏即新页，章节不再与上一章同页混排。
   */
  private chapterBreakCss(entryName: string): string {
    if (!entryName) return '';
    const normalize = (path: string): string => {
      try { return decodeURIComponent(path); } catch { return path; }
    };
    const hashes: string[] = [];
    for (const item of this.toc) {
      const hash = item.href.split('#')[1];
      if (!hash) continue;
      if (normalize(item.href.split('#')[0]) === normalize(entryName)) hashes.push(hash);
    }
    return buildChapterBreakCss(hashes);
  }

  private currentTocPosition(): number {
    // 目录点击后的首次展示直接采用点击意图：导航后的可见范围反推在章标题
    // 落于页尾时仍可能早一章，而点击行为本身就是最准确的位置声明。
    if (this.overrideTocPosition !== null) return this.overrideTocPosition;
    let position = -1;
    this.toc.forEach((item, index) => {
      if (item.index >= 0 && item.index < this.currentSection) position = index;
    });
    // 同一 section 内多个章节共享 index 时，用可见范围与锚点的文档顺序确定具体
    // 章节。foliate 的 relocate range 覆盖整个可见跨页：章标题落在右栏时，页首
    // 仍是上一章末尾几行，按“页首”判定会早一章；因此收最后一个已开始于可见
    // 范围内的锚点，点击第 N 章即定位 N。
    const range = this.currentRange;
    const doc = range?.endContainer.ownerDocument ?? null;
    if (this.sectionAnchors?.length && range && doc) {
      for (const { position: anchorPosition, node: anchorNode } of this.sectionAnchors) {
        if (this.toc[anchorPosition]?.index !== this.currentSection) continue;
        const anchorRange = doc.createRange();
        anchorRange.setStartBefore(anchorNode);
        anchorRange.collapse(true);
        // 锚点起点不晚于可见范围终点，即该章已开始于当前页。
        if (anchorRange.compareBoundaryPoints(Range.START_TO_END, range) <= 0) {
          position = anchorPosition;
        }
      }
    } else {
      this.toc.forEach((item, index) => {
        if (item.index >= 0 && item.index === this.currentSection) position = index;
      });
    }
    return position;
  }

  private currentChapterLabel(): string {
    const item = this.toc[this.currentTocPosition()];
    return item?.label.trim() || `第 ${this.currentSection + 1} 章`;
  }

  private updateTitles(): void {
    if (!this.metadata) return;
    element('bookTitle').textContent = this.metadata.title;
    element('chapterTitle').textContent = this.currentChapterLabel();
    document.title = `《${this.metadata.title}》 - 艾特阅读`;
  }

  private bindUI(): void {
    element('columnButton').addEventListener('click', () => {
      if (this.fixedLayout) return;
      void this.updateTypography({ columnMode: this.typography.columnMode === 'double' ? 'single' : 'double' });
    });
    element('themeButton').addEventListener('click', () => {
      void this.updateTypography({ theme: this.typography.theme === 'light' ? 'dark' : 'light' });
    });
    element('chapterButton').addEventListener('click', () => this.togglePanel('chapterPanel'));
    element('styleButton').addEventListener('click', () => this.togglePanel('stylePanel'));
    // 点击面板与开关按钮以外的区域关闭面板；正文 iframe 内的点击另挂钩子。
    document.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('.reader-panel, #chapterButton, #styleButton')) this.closePanels();
    });
    document.querySelectorAll('[data-close-panel]').forEach(button => {
      button.addEventListener('click', () => this.closePanels());
    });
    element('resetStyle').addEventListener('click', () => void this.updateTypography(DEFAULT_TYPOGRAPHY));
    this.bindStyleInput('fontFamily', 'fontFamily', value => value);
    this.bindStyleInput('fontSize', 'fontSize', Number);
    this.bindStyleInput('lineHeight', 'lineHeight', Number);
    this.bindStyleInput('paragraphSpacing', 'paragraphSpacing', Number);
    this.bindStyleInput('pagePaddingX', 'pagePaddingX', Number);
    if (this.fixedLayout) {
      element<HTMLButtonElement>('columnButton').disabled = true;
      element('styleFields').classList.add('fixed-layout');
      element('styleFields').querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')
        .forEach(input => input.disabled = true);
      element<HTMLButtonElement>('resetStyle').disabled = true;
    }
    // 窗口尺寸变化时重算百分比书页宽度；事件驱动，无轮询。
    this.resizeHandler = () => this.applyPageSize();
    window.addEventListener('resize', this.resizeHandler);
  }

  private bindStyleInput<K extends keyof LocalTypography>(
    id: string,
    key: K,
    convert: (value: string) => LocalTypography[K],
  ): void {
    const input = element<HTMLInputElement | HTMLSelectElement>(id);
    input.addEventListener('change', () => void this.updateTypography({ [key]: convert(input.value) } as Pick<LocalTypography, K>));
  }

  private async updateTypography(partial: Partial<LocalTypography>): Promise<void> {
    this.typography = { ...this.typography, ...partial };
    this.applyTypography();
    createSiteContext().invalidate();
    await settingsStore.updatePluginConfig('local', partial);
  }

  /**
   * 书页宽度按窗口百分比计算（非宽屏 80%、宽屏 90%，对齐番茄范例），而非绝对
   * 像素。foliate 的 max-inline-size 是“每栏”宽度：双栏时目标总宽按 2 栏
   * 加 8% 栏间距折算到单栏；280px 下限保证窄窗口可读。窗口变化时重算。
   */
  private applyPageSize(): void {
    if (this.fixedLayout || !this.renderer) return;
    const ratio = settingsStore.getSite('local').readerWide ? 0.9 : 0.8;
    const available = element('readerStage').clientWidth * ratio;
    const perColumn = this.typography.columnMode === 'double'
      ? available / 2.08
      : available;
    this.renderer.setAttribute('max-inline-size', `${Math.max(280, Math.floor(perColumn))}px`);
  }

  private applyTypography(): void {
    document.body.dataset.theme = this.typography.theme;
    element('themeLabel').textContent = this.typography.theme === 'light' ? '浅色' : '深色';
    element('columnLabel').textContent = this.typography.columnMode === 'double' ? '双栏' : '单列';
    element('columnButton').dataset.mode = this.typography.columnMode;
    if (!this.fixedLayout && this.renderer) {
      this.renderer.setAttribute('max-column-count', this.typography.columnMode === 'double' ? '2' : '1');
      this.applyPageSize();
      const dark = this.typography.theme === 'dark';
      const style = `
        :root { color-scheme: ${dark ? 'dark' : 'light'}; background: ${dark ? '#262522' : '#f5f1e8'} !important; }
        html, body { background: ${dark ? '#262522' : '#f5f1e8'} !important; color: ${dark ? '#dedbd2' : '#2e2b26'} !important; }
        body { box-sizing: border-box; padding-inline: ${this.typography.pagePaddingX}px !important; font-family: ${this.typography.fontFamily} !important; font-weight: ${CONTENT_FONT_WEIGHT} !important; font-size: ${this.typography.fontSize}px !important; line-height: ${this.typography.lineHeight} !important; }
        p { margin-block: 0 ${this.typography.paragraphSpacing}em !important; text-align: justify; }
        h1, h2, h3 { break-after: avoid; line-height: 1.45; }
        img, svg, video { max-width: 100% !important; max-height: 100% !important; object-fit: contain; }
        a { color: ${dark ? '#80b294' : '#4d8262'}; }
      `;
      this.renderer.setStyles?.(style);
    }
    const values: Array<[string, string | number]> = [
      ['fontFamily', this.typography.fontFamily],
      ['fontSize', this.typography.fontSize],
      ['lineHeight', this.typography.lineHeight],
      ['paragraphSpacing', this.typography.paragraphSpacing],
      ['pagePaddingX', this.typography.pagePaddingX],
    ];
    for (const [id, value] of values) {
      const input = element<HTMLInputElement | HTMLSelectElement>(id);
      input.value = String(value);
      const output = document.getElementById(`${id}Value`);
      if (output) output.textContent = id === 'fontSize' || id === 'pagePaddingX' ? `${value}px` : String(value);
    }
  }

  private togglePanel(id: 'chapterPanel' | 'stylePanel'): void {
    const panel = element(id);
    const open = !panel.classList.contains('open');
    this.closePanels();
    if (open) {
      panel.classList.add('open');
      panel.setAttribute('aria-hidden', 'false');
      element(id === 'chapterPanel' ? 'chapterButton' : 'styleButton').classList.add('active');
      // 打开章节面板时重算展开路径：全部折叠后仅展开当前章节的祖先分组。
      if (id === 'chapterPanel') {
        this.expandActivePath();
        this.updateActiveChapter();
      }
    }
  }

  private closePanels(): boolean {
    let wasOpen = false;
    document.querySelectorAll('.reader-panel').forEach(panel => {
      if (panel.classList.contains('open')) wasOpen = true;
      panel.classList.remove('open');
      panel.setAttribute('aria-hidden', 'true');
    });
    element('chapterButton').classList.remove('active');
    element('styleButton').classList.remove('active');
    // 关闭面板时把焦点收回外层文档：正文 iframe 一旦持有焦点，键盘事件只进入
    // iframe，window 级翻页处理收不到；仅在确实关闭了面板时收回，避免正文
    // 划选等常规交互被抢焦点。
    if (wasOpen) document.body.focus();
    return wasOpen;
  }

  private renderChapterList(): void {
    const container = element('chapterList');
    container.replaceChildren();
    this.renderTocNodes(this.tocTree, container);
    this.updateActiveChapter();
  }

  private renderTocNodes(nodes: TocTreeNode[], container: HTMLElement): void {
    nodes.forEach(node => container.append(this.createTocRow(node)));
  }

  /** 叶子渲染为普通章节行；带子级的目录项渲染为可折叠分组行 + 嵌套容器。 */
  private createTocRow(node: TocTreeNode): HTMLElement {
    const row = document.createElement('button');
    row.type = 'button';
    row.dataset.position = String(node.position);
    const index = document.createElement('span');
    index.className = 'chapter-index';
    index.textContent = String(node.position + 1).padStart(2, '0');
    const label = document.createElement('span');
    label.className = 'chapter-label';
    label.textContent = node.label;
    row.append(index, label);
    const navigateToNode = (): void => {
      const resolved = this.book?.resolveHref?.(node.href);
      if (resolved) {
        void (async () => {
          await this.navigate(resolved, true);
          this.overrideTocPosition = node.position;
          this.updateTitles();
          this.updateActiveChapter();
        })();
      }
      this.closePanels();
    };

    if (!node.children.length) {
      row.className = 'chapter-item';
      row.addEventListener('click', navigateToNode);
      return row;
    }

    // 分组行整行切换展开/收起；跳到某部开头先展开再点第一章。
    row.className = 'chapter-item chapter-group-row';
    const group = document.createElement('div');
    group.className = 'chapter-group collapsed';
    const chevron = document.createElement('span');
    chevron.className = 'chapter-chevron';
    chevron.setAttribute('role', 'button');
    chevron.setAttribute('tabindex', '0');
    chevron.setAttribute('aria-expanded', 'false');
    chevron.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.3 4.7 16.6 12l-7.3 7.3-1.8-1.8L13 12 7.5 6.5Z"/></svg>';
    const toggleGroup = (): void => {
      const collapsed = group.classList.toggle('collapsed');
      chevron.setAttribute('aria-expanded', String(!collapsed));
    };
    row.addEventListener('click', toggleGroup);
    chevron.addEventListener('click', event => {
      event.stopPropagation();
      toggleGroup();
    });
    chevron.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      toggleGroup();
    });
    const children = document.createElement('div');
    children.className = 'chapter-children';
    row.append(chevron);
    group.append(row, children);
    this.renderTocNodes(node.children, children);
    return group;
  }

  private updateActiveChapter(): void {
    // 与顶栏章节标题同源：高亮“最后一个 index 不超过当前 section”的目录项。
    // 这里只切高亮不展开分组；展开路径在面板每次打开时重算，避免自动翻页
    // 把用户手动折叠的分组又展开。
    const activePosition = this.currentTocPosition();
    const buttons = Array.from(
      element('chapterList').querySelectorAll<HTMLButtonElement>('.chapter-item'),
    );
    buttons.forEach(button => {
      button.classList.toggle('active', Number(button.dataset.position) === activePosition);
    });
    buttons.find(button => button.classList.contains('active'))
      ?.scrollIntoView({ block: 'nearest' });
  }

  /** 展开当前章节的祖先分组：先全部折叠，再沿激活行向上展开，保证确定性。 */
  private expandActivePath(): void {
    const list = element('chapterList');
    list.querySelectorAll<HTMLElement>('.chapter-group').forEach(group => {
      group.classList.add('collapsed');
      group.querySelector('.chapter-chevron')?.setAttribute('aria-expanded', 'false');
    });
    const active = list.querySelector<HTMLButtonElement>('.chapter-item.active');
    if (!active) return;
    for (let parent = active.parentElement; parent && parent !== list; parent = parent.parentElement) {
      if (!parent.classList.contains('chapter-group')) continue;
      parent.classList.remove('collapsed');
      parent.querySelector('.chapter-chevron')?.setAttribute('aria-expanded', 'true');
    }
  }

  private setupKeyboard(): void {
    const isWindows = navigator.userAgent.includes('Windows');
    const shortcutMap: Record<string, string> = {
      ',': 'settings', r: 'refresh', '[': 'back', ']': 'forward', i: 'auto_flip',
      '=': 'zoom_in', '-': 'zoom_out', '0': 'zoom_reset', '9': 'reader_wide',
      '8': 'hide_cursor', o: 'hide_toolbar', p: 'hide_navbar',
    };
    this.keyHandler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.matches('input, select, textarea') || target.isContentEditable) return;
      if (event.key === 'Escape') { this.closePanels(); return; }
      const localAction = resolveLocalKeyboardAction(event.key, isWindows);
      if (localAction) {
        event.preventDefault();
        event.stopImmediatePropagation();
        switch (localAction) {
          case 'previous-page': void this.prevPage(); break;
          case 'next-page': void this.nextPage(); break;
          case 'previous-chapter': void this.prevChapter(); break;
          case 'next-chapter': void this.nextChapter(); break;
          case 'toggle-wide': {
            const site = settingsStore.getSite('local');
            void settingsStore.updateSite('local', { readerWide: !site.readerWide });
            break;
          }
          case 'toggle-navbar': {
            const site = settingsStore.getSite('local');
            void settingsStore.updateSite('local', { hideNavbar: !site.hideNavbar });
            break;
          }
          case 'toggle-fullscreen':
            void invoke('simulate_menu_click', { action: 'toggle_fullscreen' });
            break;
        }
        return;
      }
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key >= '1' && event.key <= '7') {
        event.preventDefault();
        void invoke('switch_bookstore_by_index', { index: Number(event.key) });
        return;
      }
      if (isWindows && event.ctrlKey) {
        if (event.key.toLowerCase() === 'h') {
          event.preventDefault();
          void invoke('toggle_menu_bar');
          return;
        }
        const action = shortcutMap[event.key.toLowerCase()];
        if (action) {
          event.preventDefault();
          event.stopImmediatePropagation();
          void invoke('simulate_menu_click', { action });
        }
      }
    };
    window.addEventListener('keydown', this.keyHandler, { capture: true });
    this.visibilityHandler = () => {
      if (document.visibilityState === 'hidden') this.persistProgressNow();
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  private hideLoading(): void { element('loadingLayer').classList.add('hidden'); }
  isReady(): boolean { return this.ready; }
  isDoubleColumn(): boolean { return !this.fixedLayout && this.typography.columnMode === 'double'; }
  isAtBottom(): boolean {
    return this.currentSection >= (this.book?.sections.length ?? 1) - 1 && this.currentFraction >= .995;
  }
  getChapterProgress(): number { return Math.round(this.currentFraction * 1000) / 10; }
  getChapters(): Promise<Chapter[]> {
    return Promise.resolve(this.toc.map((item, index) => ({
      id: item.href,
      title: item.label.trim(),
      index,
    })));
  }
  attachPluginAPI(api: PluginAPI): void { this.pluginAPI = api; }
  detachPluginAPI(): void { this.pluginAPI = null; }
  nextPage(): void | Promise<void> { return this.renderer?.next(); }
  prevPage(): void | Promise<void> { return this.renderer?.prev(); }

  async nextChapter(): Promise<boolean> { return this.changeChapter(1); }
  async prevChapter(): Promise<boolean> { return this.changeChapter(-1); }
  private async changeChapter(direction: -1 | 1): Promise<boolean> {
    let index = this.currentSection + direction;
    while (index >= 0 && index < (this.book?.sections.length ?? 0)) {
      if (this.book!.sections[index].linear !== 'no') {
        await this.navigate({ index, anchor: direction < 0 ? 1 : 0 }, true);
        return true;
      }
      index += direction;
    }
    this.pluginAPI?.toast.show(direction < 0 ? '已经是第一章' : '已经是最后一章');
    return false;
  }

  async back(): Promise<void> {
    await this.positionHistory.back(progress => this.renderer?.goTo(this.progressTarget(progress)));
  }

  async forward(): Promise<void> {
    await this.positionHistory.forward(progress => this.renderer?.goTo(this.progressTarget(progress)));
  }

  destroy(): void {
    if (this.destroyed) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.persistProgressNow();
    this.destroyed = true;
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler, { capture: true });
    this.keyHandler = null;
    if (this.visibilityHandler) document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.visibilityHandler = null;
    if (this.resizeHandler) window.removeEventListener('resize', this.resizeHandler);
    this.resizeHandler = null;
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    this.runtime?.destroy();
    this.runtime = null;
    this.renderer?.destroy?.();
    this.renderer = null;
    this.book?.destroy?.();
    this.book = null;
    setLocalReaderController(null);
    delete window.__ATREADER_RUNTIME__;
  }
}

declare global {
  interface Window {
    __ATREADER_RUNTIME__?: Pick<LocalReader, 'back' | 'forward'>;
  }
}

const showFatalError = (error: unknown): void => {
  const message = localReaderError(errorMessage(error));
  localReaderLog('fatal', { bookId: new URLSearchParams(location.search).get('book'), error: message });
  const layer = element('loadingLayer');
  layer.classList.add('error');
  element('loadingText').textContent = message;
  document.title = '本地图书打开失败 - 艾特阅读';
};

const main = async (): Promise<void> => {
  const bookId = new URLSearchParams(location.search).get('book');
  if (!bookId || !/^[a-f0-9]{64}$/i.test(bookId)) throw new Error('无效的本地图书地址');
  const reader = new LocalReader(bookId);
  window.addEventListener('pagehide', () => reader.destroy(), { once: true });
  try {
    await reader.initialize();
  } catch (error) {
    localReaderLog('initialize_failed', { bookId, error: errorMessage(error) });
    throw error;
  }
};

void main().catch(showFatalError);
