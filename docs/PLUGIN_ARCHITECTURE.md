# 插件化架构设计文档

本文档介绍微信读书桌面客户端 v0.8.0 引入的插件化架构，为第三方开发者提供插件开发指南。

## 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                         Tauri 应用层                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    插件系统 (Plugin System)               │  │
│  │                                                          │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │  │
│  │  │ PluginLoader │  │PluginRegistry│  │  PluginAPI  │     │  │
│  │  │  插件加载器   │  │  插件注册表   │  │  插件接口   │     │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘     │  │
│  │                                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              │                                  │
│              ┌───────────────┼───────────────┐                  │
│              ▼               ▼               ▼                  │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐  │
│  │   WeRead 插件    │ │   未来: 本地    │ │  第三方插件      │  │
│  │   (内置默认)     │ │   EPUB/TXT     │ │  (开发者扩展)    │  │
│  └─────────────────┘ └─────────────────┘ └─────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 核心概念

### 1. 插件类型 (SourceType)

| 类型 | 说明 | 渲染模式 | 示例 |
|------|------|---------|------|
| `web` | 在线阅读网站 | WebView | 微信读书、豆瓣阅读 |
| `local` | 本地文件 | 自定义渲染 | EPUB、TXT（规划中） |
| `cloud` | 云存储服务 | 混合模式 | 网盘同步（规划中） |

### 2. 插件能力 (Capabilities)

```typescript
interface PluginCapabilities {
  wideMode?: boolean;      // 宽屏模式
  hideToolbar?: boolean;   // 隐藏工具栏
  hideNavbar?: boolean;    // 隐藏导航栏
  autoFlip?: boolean;      // 自动翻页
  chapterNav?: boolean;    // 章节导航
  progressTracker?: boolean; // 进度追踪
  doubleColumn?: boolean;  // 双栏模式
  hideCursor?: boolean;    // 隐藏光标
  remoteControl?: boolean; // 遥控器支持
}
```

## 插件结构

### 目录结构

```
src/plugins/
├── builtin/              # 内置插件
│   └── weread/           # 微信读书插件
│       ├── manifest.json # 插件清单
│       ├── index.ts      # 入口文件
│       └── styles/       # 样式文件
│           ├── wide.css
│           ├── toolbar.css
│           └── navbar.css
└── template/             # 插件模板
    ├── manifest.json
    └── index.ts
```

### manifest.json 清单文件

```json
{
  "id": "weread",
  "name": "微信读书",
  "version": "1.0.0",
  "description": "微信读书官方网站阅读增强",
  "author": "艾特阅读",
  "sourceType": "web",
  "site": {
    "domain": ["weread.qq.com"],
    "homeUrl": "https://weread.qq.com/",
    "readerPattern": "/web/reader/"
  },
  "capabilities": {
    "wideMode": true,
    "hideToolbar": true,
    "hideNavbar": true,
    "autoFlip": true,
    "chapterNav": true,
    "progressTracker": true,
    "doubleColumn": true,
    "hideCursor": true,
    "remoteControl": true
  }
}
```

## 插件开发指南

### 1. 创建插件

复制 `src/plugins/template/` 目录，重命名为你的插件名称。

### 2. 实现 ReaderPlugin 接口

```typescript
import type { ReaderPlugin, PluginAPI, PluginManifest } from '../../core/plugin_types';

export class MyPlugin implements ReaderPlugin {
  manifest: PluginManifest;
  private api: PluginAPI | null = null;

  constructor() {
    this.manifest = require('./manifest.json');
  }

  // 插件加载时调用
  onLoad(api: PluginAPI): void {
    this.api = api;
    api.log.info('MyPlugin loaded');
    
    // 订阅设置变化
    api.settings.subscribe((settings) => {
      this.applySettings(settings);
    });
  }

  // 插件卸载时调用
  onUnload(): void {
    // 清理资源
    this.api = null;
  }

  // 是否匹配当前域名
  matchesDomain(): boolean {
    const hostname = window.location.hostname;
    const domains = this.manifest.site?.domain || [];
    return domains.some(d => hostname.includes(d));
  }

  // 是否在阅读页
  isReaderPage(): boolean {
    const pattern = this.manifest.site?.readerPattern;
    return pattern ? window.location.pathname.includes(pattern) : false;
  }

  // 下一页
  nextPage(): void {
    // 实现翻页逻辑
  }

  // 上一页
  prevPage(): void {
    // 实现翻页逻辑
  }

  // 获取样式
  getStyles(): PluginStyles {
    return {
      wideMode: { enabled: '...', disabled: '...' },
      toolbar: { enabled: '...', disabled: '...' }
    };
  }
}
```

### 3. 使用 PluginAPI

插件通过 `PluginAPI` 与框架交互，API 提供以下能力：

#### 样式管理

```typescript
// 注入 CSS
api.style.inject('my-style', 'body { background: #fff; }');

// 移除 CSS
api.style.remove('my-style');

// 检查样式是否存在
api.style.has('my-style');
```

#### 设置管理

```typescript
// 获取所有设置
const settings = api.settings.getAll();

// 获取单个设置
const value = api.settings.get('readerWide', false);

// 更新设置
await api.settings.set('readerWide', true);

// 订阅设置变化
const unsubscribe = api.settings.subscribe((settings) => {
  console.log('Settings changed:', settings);
});
```

#### 事件系统

```typescript
// 监听事件
const unsubscribe = api.events.on('route-changed', (data) => {
  console.log('Route changed:', data);
});

// 触发事件
api.events.emit('my-event', { data: 'value' });

// 一次性监听
api.events.once('init', () => {
  console.log('Initialized');
});
```

#### 日志输出

```typescript
api.log.debug('Debug message');
api.log.info('Info message');
api.log.warn('Warning message');
api.log.error('Error message');
```

## 内置插件: 微信读书

### 功能清单

| 功能 | 状态 | 说明 |
|------|------|------|
| 宽屏模式 | ✅ | 扩展阅读区域至全屏 |
| 隐藏工具栏 | ✅ | 隐藏顶部工具栏 |
| 隐藏导航栏 | ✅ | 双栏模式下隐藏底部导航 |
| 自动翻页 | ✅ | 单栏滚动/双栏定时翻页 |
| 进度追踪 | ✅ | 实时显示章节阅读进度 |
| 章节导航 | ✅ | 遥控器上下键切换章节 |
| 双栏检测 | ✅ | 自动检测双栏/单栏模式 |
| 光标隐藏 | ✅ | 静止后自动隐藏鼠标 |

### 键盘快捷键

| 快捷键 | 功能 |
|--------|------|
| `←` / `→` | 上一页 / 下一页 |
| `↑` / `↓` | 上一章 / 下一章（遥控器） |

## 未来规划

### 本地阅读插件 (LocalReaderPlugin)

支持本地电子书格式：

- **EPUB**: 标准电子书格式
- **TXT**: 纯文本格式
- **MOBI**: Kindle 格式（可选）

### 第三方网站适配

开发者可基于插件模板适配其他阅读网站：

- 豆瓣阅读
- 起点读书
- 番茄小说
- 等等...

## 性能优化

v0.8.0 包含以下性能优化：

1. **RAF 循环优化**: 页面后台时暂停 requestAnimationFrame 循环
2. **MutationObserver 节流**: 增加节流间隔至 1000ms
3. **回调调度优化**: 移除冗余的 RAF + setTimeout 组合

测试结果：
- Debug 版本 CPU 占用：8% → 3%
- Release 版本 CPU 占用：更低（待测）

## 参考资料

- [Tauri v2 文档](https://v2.tauri.app/)
- [项目开发规范](../CLAUDE.md)
- [测试指南](./TESTING.md)
