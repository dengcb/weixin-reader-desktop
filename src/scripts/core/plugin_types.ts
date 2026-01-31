/**
 * Plugin Architecture Type Definitions
 * 插件架构类型定义
 * 
 * 设计原则：
 * 1. 统一阅读源抽象 - 支持 Web/Local/Cloud 三种类型
 * 2. 接口与实现分离 - 核心框架只依赖接口
 * 3. 向后兼容 - 现有 Adapter 可平滑迁移
 * 4. 前瞻性设计 - 为本地阅读预留扩展点
 */

// ==================== 基础类型 ====================

/**
 * 阅读源类型
 * - web: 网页阅读器（需要 WebView 渲染远程页面）
 * - local: 本地文件（需要解析并渲染 EPUB/TXT 等）
 * - cloud: 云存储（需要下载后渲染）
 */
export type SourceType = 'web' | 'local' | 'cloud';

/**
 * 内容渲染模式
 * - webview: 使用 WebView 渲染（当前 Web 插件使用）
 * - custom: 使用自定义渲染引擎（未来本地插件可用）
 */
export type RenderMode = 'webview' | 'custom';

// ==================== 插件清单 ====================

/**
 * 插件能力声明
 * 声明插件支持哪些功能，框架据此启用/禁用相应的 UI 和逻辑
 */
export interface PluginCapabilities {
  /** 宽屏模式 */
  wideMode?: boolean;
  /** 隐藏工具栏 */
  hideToolbar?: boolean;
  /** 隐藏导航栏 */
  hideNavbar?: boolean;
  /** 自动翻页 */
  autoFlip?: boolean;
  /** 章节导航 */
  chapterNav?: boolean;
  /** 进度追踪 */
  progressTracker?: boolean;
  /** 双栏模式 */
  doubleColumn?: boolean;
  /** 隐藏光标 */
  hideCursor?: boolean;
  /** 蓝牙遥控器支持 */
  remoteControl?: boolean;
}

/**
 * 网站配置（Web 类型插件专用）
 */
export interface WebSiteConfig {
  /** 匹配的域名（支持单个或多个） */
  domain: string | string[];
  /** 网站首页 URL */
  homeUrl: string;
  /** 阅读页面匹配模式（字符串或正则） */
  readerPattern: string;
  /** 首页匹配模式（可选） */
  homePattern?: string;
}

/**
 * 文件类型配置（Local 类型插件专用）
 */
export interface FileTypeConfig {
  /** 支持的文件扩展名 */
  extensions: string[];
  /** 支持的 MIME 类型 */
  mimeTypes?: string[];
}

/**
 * 插件清单
 * 每个插件必须提供的元信息，类似 package.json
 */
export interface PluginManifest {
  /** 插件唯一标识（如 'weread', 'epub'） */
  id: string;
  /** 插件显示名称 */
  name: string;
  /** 插件版本（语义化版本） */
  version: string;
  /** 插件描述 */
  description?: string;
  /** 插件作者 */
  author?: string;
  /** 插件主页 */
  homepage?: string;
  
  /** 阅读源类型 */
  sourceType: SourceType;
  /** 渲染模式 */
  renderMode: RenderMode;
  
  /** 网站配置（Web 类型必需） */
  site?: WebSiteConfig;
  /** 文件类型配置（Local 类型必需） */
  fileTypes?: FileTypeConfig;
  
  /** 插件能力声明 */
  capabilities: PluginCapabilities;
  
  /** 是否为内置插件 */
  builtin?: boolean;
}

// ==================== 插件 API ====================

/**
 * 样式 API
 * 提供 CSS 注入和移除能力
 */
export interface StyleAPI {
  /** 注入 CSS 样式 */
  inject(id: string, css: string): void;
  /** 移除 CSS 样式 */
  remove(id: string): void;
  /** 检查样式是否已注入 */
  has(id: string): boolean;
}

/**
 * 设置 API
 * 提供插件专属的设置存储（命名空间隔离）
 */
export interface SettingsAPI {
  /** 获取设置值 */
  get<T>(key: string, defaultValue?: T): T;
  /** 设置值 */
  set(key: string, value: any): Promise<void>;
  /** 获取所有设置 */
  getAll(): Record<string, any>;
  /** 订阅设置变化 */
  subscribe(callback: (settings: Record<string, any>) => void): () => void;
}

/**
 * 事件 API
 * 提供事件发布/订阅能力
 */
export interface EventsAPI {
  /** 监听事件 */
  on(event: string, handler: (...args: any[]) => void): () => void;
  /** 发送事件 */
  emit(event: string, ...args: any[]): void;
  /** 监听一次 */
  once(event: string, handler: (...args: any[]) => void): () => void;
}

/**
 * 菜单项定义
 */
export interface MenuItem {
  /** 菜单项 ID */
  id: string;
  /** 菜单项标签 */
  label: string;
  /** 快捷键 */
  accelerator?: string;
  /** 是否可选中（复选框类型） */
  checkable?: boolean;
  /** 是否选中 */
  checked?: boolean;
  /** 是否启用 */
  enabled?: boolean;
  /** 点击处理器 */
  handler?: () => void;
}

/**
 * 菜单 API
 * 提供菜单注册和状态控制
 */
export interface MenuAPI {
  /** 注册菜单项 */
  register(items: MenuItem[]): void;
  /** 设置菜单项启用状态 */
  setEnabled(id: string, enabled: boolean): void;
  /** 设置菜单项选中状态 */
  setChecked(id: string, checked: boolean): void;
  /** 获取阅读器专用菜单项 ID 列表 */
  getReaderMenuIds(): string[];
}

/**
 * 存储 API
 * 提供持久化存储能力（插件专属命名空间）
 */
export interface StorageAPI {
  /** 获取存储值 */
  get<T>(key: string): Promise<T | null>;
  /** 设置存储值 */
  set(key: string, value: any): Promise<void>;
  /** 删除存储值 */
  remove(key: string): Promise<void>;
  /** 获取所有键 */
  keys(): Promise<string[]>;
}

/**
 * 日志 API
 * 提供带插件前缀的日志输出
 */
export interface LogAPI {
  debug(...args: any[]): void;
  info(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
}

/**
 * 内容 API（未来 Local 插件使用）
 * 提供内容渲染相关能力
 */
export interface ContentAPI {
  /** 渲染 HTML 内容到阅读区域 */
  render(html: string): void;
  /** 获取当前阅读区域元素 */
  getContainer(): HTMLElement | null;
  /** 滚动到指定位置 */
  scrollTo(position: number): void;
  /** 获取当前滚动位置 */
  getScrollPosition(): number;
}

/**
 * 插件 API
 * 核心框架提供给插件的所有能力
 */
export interface PluginAPI {
  /** 样式管理 */
  style: StyleAPI;
  /** 设置管理（插件专属命名空间） */
  settings: SettingsAPI;
  /** 事件系统 */
  events: EventsAPI;
  /** 菜单系统 */
  menu: MenuAPI;
  /** 持久化存储 */
  storage: StorageAPI;
  /** 日志系统 */
  log: LogAPI;
  /** 内容渲染（未来 Local 插件使用） */
  content: ContentAPI;
}

// ==================== 插件样式系统 ====================

/**
 * 样式对
 * 用于开关类型的样式（如宽屏/窄屏）
 */
export interface StylePair {
  /** 启用时的 CSS */
  enabled: string;
  /** 禁用时的 CSS */
  disabled: string;
}

/**
 * 插件样式集合
 * 插件需要提供的所有样式
 */
export interface PluginStyles {
  /** 宽屏模式样式 */
  wideMode?: StylePair;
  /** 工具栏样式 */
  toolbar?: StylePair;
  /** 导航栏样式 */
  navbar?: StylePair;
  /** 主题样式 */
  theme?: {
    dark: string;
    light: string;
  };
  /** 自定义样式（按需注入） */
  custom?: Record<string, string>;
}

// ==================== 章节和进度 ====================

/**
 * 章节信息
 */
export interface Chapter {
  /** 章节 ID */
  id: string;
  /** 章节标题 */
  title: string;
  /** 章节索引（用于排序） */
  index: number;
  /** 章节 URL（Web 类型） */
  url?: string;
  /** 字数（可选） */
  wordCount?: number;
}

/**
 * 章节内容
 */
export interface ChapterContent {
  /** 章节 ID */
  id: string;
  /** 章节标题 */
  title: string;
  /** HTML 内容（已渲染） */
  html?: string;
  /** 纯文本内容 */
  text?: string;
  /** 远程 URL（Web 类型，用于导航） */
  url?: string;
  /** 本地文件路径（Local 类型） */
  filePath?: string;
}

/**
 * 阅读进度
 */
export interface ReadingProgress {
  /** 书籍 ID */
  bookId: string;
  /** 当前章节 ID */
  chapterId: string;
  /** 章节内位置（0-1 或具体像素值） */
  chapterProgress: number;
  /** 全书进度（0-100） */
  totalProgress: number;
  /** 时间戳 */
  timestamp: number;
  /** 阅读时长（秒） */
  readingTime?: number;
}

/**
 * 书籍进度信息（从 API 获取）
 */
export interface BookProgress {
  /** 全书进度百分比 */
  progress?: number;
  /** 阅读时长（秒） */
  readingTime?: number;
  /** 最后阅读日期 */
  lastReadDate?: string;
  /** 当前章节 UID */
  chapterUid?: number;
  /** 当前章节索引 */
  chapterIdx?: number;
  /** 阅读位置摘要 */
  summary?: string;
}

// ==================== 插件接口 ====================

/**
 * 阅读器插件接口
 * 所有插件都需要实现这个接口
 */
export interface ReaderPlugin {
  // ==================== 元信息 ====================
  
  /** 插件清单 */
  readonly manifest: PluginManifest;
  
  // ==================== 生命周期 ====================
  
  /**
   * 插件加载时调用
   * @param api 核心框架提供的 API
   */
  onLoad(api: PluginAPI): void;
  
  /**
   * 插件卸载时调用
   * 应在此清理所有资源（事件监听器、定时器等）
   */
  onUnload(): void;
  
  // ==================== 路由检测（Web 类型必需）====================
  
  /**
   * 检测当前页面是否是阅读页面
   */
  isReaderPage(): boolean;
  
  /**
   * 检测当前页面是否是首页
   */
  isHomePage(): boolean;
  
  /**
   * 检测当前域名是否匹配
   */
  matchesDomain(): boolean;
  
  // ==================== 翻页控制 ====================
  
  /**
   * 下一页
   */
  nextPage(): void | Promise<void>;
  
  /**
   * 上一页
   */
  prevPage(): void | Promise<void>;
  
  // ==================== 样式提供 ====================
  
  /**
   * 获取插件样式集合
   */
  getStyles(): PluginStyles;
  
  // ==================== 可选能力 ====================
  
  /**
   * 检测是否为双栏模式
   */
  isDoubleColumn?(): boolean;
  
  /**
   * 检测是否滚动到底部
   */
  isAtBottom?(): boolean;
  
  /**
   * 获取当前章节进度（0-100）
   */
  getChapterProgress?(): number;
  
  /**
   * 获取书籍进度（从 API）
   */
  getBookProgress?(): Promise<BookProgress | null>;
  
  /**
   * 获取章节列表
   */
  getChapters?(): Promise<Chapter[]>;
  
  /**
   * 获取章节 URL
   * @param chapterIdx 章节索引
   */
  getChapterUrl?(chapterIdx: number): string | null;
  
  /**
   * 获取阅读器专用菜单项 ID
   */
  getReaderMenuItems?(): string[];
}

// ==================== 插件状态 ====================

/**
 * 插件状态
 */
export type PluginState = 'unloaded' | 'loading' | 'loaded' | 'error';

/**
 * 已注册的插件信息
 */
export interface RegisteredPlugin {
  /** 插件实例 */
  plugin: ReaderPlugin;
  /** 插件状态 */
  state: PluginState;
  /** 错误信息（如果有） */
  error?: string;
  /** 加载时间 */
  loadedAt?: number;
}
