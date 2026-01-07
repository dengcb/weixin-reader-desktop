# 测试指南

本文档介绍微信读书桌面应用的完整测试体系,包括 Rust 后端测试和 TypeScript 前端测试,为后续开发者提供测试编写指引。

## 测试概览

项目采用双层测试架构:
- **Rust 后端**: 使用 Rust 内置测试框架,测试文件位于 `src-tauri/tests/` 目录
- **TypeScript 前端**: 使用 Bun 测试框架,测试文件位于 `src/scripts/core/__tests__/` 目录

### 测试统计

#### 后端 (Rust)

| 测试文件 | 测试数量 | 覆盖模块 |
|---------|---------|---------|
| `commands_test.rs` | 14 | Tauri 命令处理 |
| `core_test.rs` | 10 | 核心功能 |
| `menu_test.rs` | 12 | 菜单系统 |
| `settings_test.rs` | 10 | 设置管理 |
| `sites_test.rs` | 12 | 站点配置 |
| `update_test.rs` | 18 | 更新管理器 |
| `monitor_test.rs` | 1 | 显示器集成 |
| **小计** | **79** | **Rust 后端全覆盖** |

#### 前端 (TypeScript)

| 测试文件 | 测试数量 | 覆盖模块 |
|---------|---------|---------|
| `utils.test.ts` | 30 | CSS 注入、键盘事件 |
| `scroll_state.test.ts` | 24 | 滚动恢复机制 |
| `site_registry.test.ts` | 33 | 站点适配器注册表 |
| `event_bus.test.ts` | 58 | 事件总线系统 |
| `optimistic_lock.test.ts` | 9 | 乐观锁并发控制 |
| `settings_store.test.ts` | 20+ | 设置存储管理 |
| **小计** | **174+** | **前端核心模块覆盖** |

#### 总计

**253+ 测试用例**,实现前后端核心功能的全面测试覆盖。

### 运行测试

#### 后端测试 (Rust)

```bash
# 运行所有后端测试
cargo test --manifest-path src-tauri/Cargo.toml

# 运行特定测试文件
cargo test --manifest-path src-tauri/Cargo.toml --test menu_test

# 运行特定测试函数
cargo test --manifest-path src-tauri/Cargo.toml test_menu_item_id_format

# 显示测试输出
cargo test --manifest-path src-tauri/Cargo.toml -- --nocapture

# 运行未通过的测试
cargo test --manifest-path src-tauri/Cargo.toml -- --fail-fast
```

#### 前端测试 (TypeScript)

```bash
# 运行所有前端测试
bun test

# 运行特定目录的测试
bun test src/scripts/core/__tests__/

# 运行特定测试文件
bun test src/scripts/core/__tests__/event_bus.test.ts

# 监听模式 (文件变化自动重新运行)
bun test --watch

# 显示覆盖率
bun test --coverage
```

---

## 第一部分: Rust 后端测试

## 测试文件说明

### 1. commands_test.rs - 命令处理测试

测试 Tauri 后端暴露给前端的命令接口。

**测试覆盖**:
- `MonitorInfo` 结构体 - 多显示器信息 (Retina 支持)
- `WeReadBookProgress` - 阅读进度数据结构
- WeRead API 错误码处理 (-2010, -2012)
- 自动翻页间隔范围 (5-60秒)
- 缩放值范围 (0.5-2.0)
- 光标可见性切换

**示例**:
```rust
#[test]
fn test_auto_flip_interval_range() {
    let valid_intervals = vec![5, 10, 30, 60];

    for interval in valid_intervals {
        assert!(interval >= 5 && interval <= 60,
            "Auto-flip interval should be 5-60 seconds");
    }
}
```

### 2. core_test.rs - 核心功能测试

测试应用核心的数据结构和计算逻辑。

**测试覆盖**:
- 设置序列化/反序列化
- 自动翻页设置结构
- 菜单项 ID 格式
- 版本号格式 (semver)
- 物理到逻辑坐标转换 (Retina 显示)
- 窗口居中计算
- 边界检查算法
- 显示器索引追踪

**关键测试 - 坐标转换**:
```rust
#[test]
fn test_display_info_logical_conversion() {
    // Retina 显示 (scale factor 2)
    let physical_width = 3840u32;
    let scale_factor = 2.0f64;
    let logical_width = (physical_width as f64 / scale_factor) as u32;
    assert_eq!(logical_width, 1920);
}
```

### 3. menu_test.rs - 菜单系统测试

测试 macOS 原生菜单的构建和交互逻辑。

**测试覆盖**:
- 菜单项 ID 格式 (snake_case)
- 多显示器菜单项生成逻辑
- 显示器名称中文双引号格式 ("...")
- 快捷键格式 (CmdOrCtrl+)
- 菜单勾选状态与设置的映射
- 菜单重建触发条件
- 当前显示器过滤
- 窗口跨显示器居中计算
- 退出时自动翻页状态清理
- 菜单中文本地化

**关键测试 - 显示器过滤**:
```rust
#[test]
fn test_current_monitor_filtering() {
    let total_monitors = 3;
    let current_monitor_index = Some(1);

    let mut available_monitors = Vec::new();
    for index in 0..total_monitors {
        if current_monitor_index != Some(index) {
            available_monitors.push(index);
        }
    }

    // 当前显示器不应出现在菜单中
    assert_eq!(available_monitors.len(), 2);
    assert!(!available_monitors.contains(&1));
}
```

### 4. settings_test.rs - 设置管理测试

测试设置的持久化、版本控制和并发安全。

**测试覆盖**:
- 版本控制与乐观锁
- 并发更新处理
- 允许的键验证 (_version, global, sites)
- 隐藏光标设置
- 多站点支持
- 设置合并逻辑 (浅合并策略)
- 版本溢出保护

**关键测试 - 版本控制**:
```rust
#[test]
fn test_version_control() {
    let settings = json!({
        "_version": 1,
        "global": { "theme": "dark" }
    });

    // 模拟版本不匹配导致保存失败
    let stored_version = settings.get("_version")
        .and_then(|v| v.as_i64())
        .unwrap();

    let update_version = stored_version + 1; // 递增版本号
    assert_eq!(update_version, 2);
}
```

### 5. sites_test.rs - 站点配置测试

测试多站点配置结构,支持未来扩展。

**测试覆盖**:
- 站点配置结构完整性
- 网络检测地址生成 (domain:443)
- 域名格式验证
- URL 格式验证 (HTTPS)
- 站点 ID 唯一性
- 默认站点配置
- DNS 规范合规性
- 多站点扩展性

**关键测试 - 网络检测地址**:
```rust
#[test]
fn test_network_check_addr_generation() {
    struct SiteConfig {
        domain: &'static str,
    }

    let site = SiteConfig {
        domain: "weread.qq.com",
    };

    let check_addr = format!("{}:443", site.domain);
    assert_eq!(check_addr, "weread.qq.com:443");
}
```

### 6. update_test.rs - 更新管理器测试

测试应用自动更新机制。

**测试覆盖**:
- 更新状态初始化与设置
- 更新信息结构 (has_update, version, body)
- 版本号格式 (semver)
- 菜单文本状态转换
- 超时配置 (检查 10s, 下载 30s, 手动 15s)
- 自动更新开关
- 更新检查间隔 (24h)
- 初始化延迟 (10s 等待菜单就绪)
- 版本比较逻辑
- 网络错误恢复

**关键测试 - 超时配置**:
```rust
#[test]
fn test_timeout_configurations() {
    let silent_check_timeout = Duration::from_secs(10);
    let download_timeout = Duration::from_secs(30);
    let manual_check_timeout = Duration::from_secs(15);

    // 下载超时应该大于检查超时
    assert!(download_timeout > silent_check_timeout);
}
```

### 7. monitor_test.rs - 显示器集成测试

测试显示器相关的集成功能。

**测试覆盖**:
- Mock 环境下的显示器 API 调用
- Panic 捕获和错误处理

## 测试编写指南

### 基本结构

```rust
#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn test_feature_name() {
        // Arrange (准备)
        let input = "some value";

        // Act (执行)
        let result = process(input);

        // Assert (断言)
        assert_eq!(result, "expected");
    }
}
```

### 命名规范

- 测试函数: `test_<被测试的功能>_<具体场景>`
- 测试模块: `<模块名>_tests`
- 测试文件: `<模块名>_test.rs`

### 断言技巧

```rust
// 相等断言
assert_eq!(actual, expected);
assert_ne!(actual, unexpected);

// 布尔断言
assert!(condition, "Error message: {}", value);

// 匹配断言
assert!(result.is_ok());
assert!(result.is_err());

// 宏断言
assert_matches!(result, Ok(value) if value > 0);
```

### 测试数据构造

```rust
// 使用 serde_json 构造复杂数据
let settings = json!({
    "readerWide": true,
    "autoFlip": {
        "active": false,
        "interval": 30
    }
});

// 使用 vec! 构造批量数据
let test_cases = vec![
    ("input1", "expected1"),
    ("input2", "expected2"),
];

for (input, expected) in test_cases {
    assert_eq!(process(input), expected);
}
```

## 测试最佳实践

### 1. 测试独立性

每个测试应该独立运行,不依赖其他测试的状态:

```rust
// ✅ 好的做法
#[test]
fn test_feature_a() {
    let state = create_test_state(); // 每次创建新状态
    assert!(state.is_valid());
}

// ❌ 坏的做法
static mut SHARED_STATE: usize = 0;

#[test]
fn test_with_shared_state() {
    unsafe { SHARED_STATE = 1; } // 依赖共享状态
}
```

### 2. 测试可读性

使用描述性的测试名称和清晰的注释:

```rust
/// 测试当窗口移动到新显示器时,菜单应该重建
#[test]
fn test_menu_rebuild_trigger_logic() {
    // 场景 1: 首次检测 - 应该触发重建
    let last_monitor_index: Option<usize> = None;
    let current_monitor_index = Some(0);
    let should_rebuild = last_monitor_index != current_monitor_index;
    assert!(should_rebuild, "Should rebuild menu on first monitor detection");
}
```

### 3. 边界测试

覆盖边界条件和异常情况:

```rust
#[test]
fn test_auto_flip_interval_boundaries() {
    // 最小边界
    assert!(is_valid_interval(5));

    // 最大边界
    assert!(is_valid_interval(60));

    // 超出边界
    assert!(!is_valid_interval(4));
    assert!(!is_valid_interval(61));
}
```

### 4. 使用 Mock 避免外部依赖

对于需要 Tauri 运行时的功能,使用 mock 环境:

```rust
use tauri::test::mock_builder;

#[test]
fn test_with_mock_runtime() {
    let app = mock_builder()
        .setup(|app| {
            // 测试设置
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build app");

    // 使用 mock app 进行测试
}
```

## 持续集成

测试在 CI/CD 流程中自动运行:

```yaml
# .github/workflows/test.yml
jobs:
  test:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions-rs/toolchain@v1
        with:
          toolchain: stable
      - run: cargo test --manifest-path src-tauri/Cargo.toml
```

## 调试测试

### 显示输出

```bash
# 显示所有 println! 输出
cargo test -- --nocapture

# 显示特定测试的输出
cargo test test_name -- --nocapture
```

### 只运行失败的测试

```bash
# 第一次运行
cargo test

# 只运行上次失败的测试
cargo test -- --fail-fast
```

### 条件编译

在测试中使用条件编译:

```rust
#[cfg(test)]
mod tests {
    #[test]
    #[cfg(target_os = "macos")]
    fn test_macos_only() {
        // macOS 专属测试
    }
}
```

---

## 第二部分: TypeScript 前端测试

前端测试使用 **Bun 测试框架**,测试文件位于 `src/scripts/core/__tests__/` 目录。

### 前端测试文件说明

#### 1. utils.test.ts - 工具函数测试

测试核心工具函数,包括 CSS 注入和键盘事件触发。

**测试覆盖**:
- CSS 注入到 `<head>` 标签
- 更新已存在的 style 元素
- CSS 移除功能
- 特殊字符和媒体查询处理
- ArrowLeft/ArrowRight 键盘事件触发
- 事件冒泡验证
- keyCode 映射 (Left → 37, Right → 39)

**示例**:
```typescript
describe('injectCSS', () => {
  it('should inject CSS into document head', () => {
    const cssContent = '.test { color: red; }';
    injectCSS('test-style-1', cssContent);

    const style = document.getElementById('test-style-1');
    expect(style).not.toBeNull();
    expect(style?.innerHTML).toBe(cssContent);
  });

  it('should update existing style element', () => {
    injectCSS('test-id', '.test { color: red; }');
    injectCSS('test-id', '.test { color: blue; }');

    const styles = document.querySelectorAll('#test-id');
    expect(styles.length).toBe(1); // 只有一个元素
  });
});
```

#### 2. scroll_state.test.ts - 滚动状态测试

测试滚动位置恢复的互斥机制,防止保存操作与恢复操作冲突。

**测试覆盖**:
- 恢复完成状态检查 (`isRestorationComplete`)
- 恢复完成标记 (`markRestorationComplete`)
- 异步等待恢复 (`waitForRestoration`)
- 轮询机制 (100ms 间隔)
- 超时处理 (默认 2000ms)
- 并发等待调用
- 状态持久化

**关键测试 - 异步等待**:
```typescript
it('should resolve when restoration completes during wait', async () => {
  const start = Date.now();

  // 200ms 后标记完成
  setTimeout(() => {
    ScrollState.markRestorationComplete();
  }, 200);

  await ScrollState.waitForRestoration(1000);
  const elapsed = Date.now() - start;

  // 应该在 200-400ms 之间完成
  expect(elapsed).toBeGreaterThanOrEqual(200);
  expect(elapsed).toBeLessThan(400);
});
```

**应用场景**:
```typescript
// 恢复前不允许保存
if (ScrollState.isRestorationComplete()) {
  saveScrollPosition(); // 只有恢复完成后才保存
}

// 等待恢复完成后再执行自动滚动
await ScrollState.waitForRestoration();
startAutoScroll();
```

#### 3. site_registry.test.ts - 站点注册表测试

测试多站点适配器的注册和管理机制。

**测试覆盖**:
- 单例模式验证
- 适配器注册 (`register`, `registerAll`)
- 适配器检索 (`getAdapter`, `getAllAdapters`)
- 当前域名匹配 (`getCurrentAdapter`)
- 域名变化时缓存失效
- 阅读页面/主页检测 (`isReaderPage`, `isHomePage`)
- 菜单项委托 (`getReaderMenuItems`)
- 边界情况处理 (缺失方法、空适配器)

**关键测试 - 域名匹配与缓存**:
```typescript
it('should cache current adapter', () => {
  const adapter = createMockAdapter('weread', 'weread.qq.com');
  registry.register(adapter);

  const first = registry.getCurrentAdapter();
  const second = registry.getCurrentAdapter();

  expect(first).toBe(second); // 缓存相同实例
});

it('should invalidate cache when domain changes', () => {
  registry.register(wereadAdapter);
  registry.register(kindleAdapter);

  expect(registry.getCurrentAdapter()).toBe(wereadAdapter);

  // 更改域名
  Object.defineProperty(window, 'location', {
    value: { hostname: 'read.amazon.com' }
  });

  expect(registry.getCurrentAdapter()).toBe(kindleAdapter);
});
```

#### 4. event_bus.test.ts - 事件总线测试 (最复杂)

测试应用的核心事件分发系统,包含历史回放、自动去重、错误隔离等高级功能。

**测试覆盖**:
- 基础订阅和发布 (`on`, `emit`)
- 自动去重 (同一回调不会重复注册)
- 一次性监听器 (`once`)
- **历史回放** (`onWithHistory`) - 解决"迟到订阅者"问题
- 错误隔离 (一个监听器失败不影响其他)
- 模块清理 (`offModule`)
- AbortSignal 取消订阅
- 统计工具 (`getListenerCount`, `getStats`)
- 事件链 (一个事件触发另一个事件)

**核心功能 - 历史回放**:
```typescript
describe('onWithHistory', () => {
  it('should replay last event immediately for new subscribers', () => {
    let receivedData: number | null = null;

    // 先发布事件
    eventBus.emit('data-loaded', 42);

    // 后订阅 - 应该立即收到历史事件
    eventBus.onWithHistory('data-loaded', (data) => {
      receivedData = data;
    });

    expect(receivedData).toBe(42); // 立即收到历史数据
  });
});
```

**错误隔离测试**:
```typescript
it('should isolate errors and not break other listeners', () => {
  const results: number[] = [];

  eventBus.on('test', () => {
    throw new Error('Listener 1 failed');
  });

  eventBus.on('test', (data) => {
    results.push(data); // 应该仍然执行
  });

  eventBus.emit('test', 100);

  expect(results).toEqual([100]); // 第二个监听器正常工作
});
```

**实际应用场景**:
```typescript
// 场景 1: 避免模块初始化顺序问题
// AppManager 先于 MenuManager 初始化并发布 'route-changed'
// MenuManager 后初始化,但仍能收到最近的路由变化
eventBus.onWithHistory('route-changed', (route) => {
  updateMenuForRoute(route);
});

// 场景 2: 模块卸载时批量清理
class MyManager extends BaseManager {
  destroy() {
    eventBus.offModule('MyManager'); // 清理所有监听器
  }
}
```

#### 5. optimistic_lock.test.ts - 乐观锁测试

测试并发更新的乐观锁机制,防止设置冲突。

**测试覆盖**:
- 版本号递增
- 并发更新冲突检测
- 最大重试次数限制
- 版本溢出保护

**示例**:
```typescript
it('should detect version conflict', async () => {
  const lock = new OptimisticLock();

  const update1 = lock.tryUpdate(async (data) => {
    await sleep(100);
    return { ...data, value: 'A' };
  });

  const update2 = lock.tryUpdate(async (data) => {
    return { ...data, value: 'B' };
  });

  const results = await Promise.allSettled([update1, update2]);

  // 只有一个成功,另一个因版本冲突失败
  const successes = results.filter(r => r.status === 'fulfilled');
  expect(successes.length).toBe(1);
});
```

#### 6. settings_store.test.ts - 设置存储测试

测试设置的持久化、同步和并发控制。

**测试覆盖**:
- 单例模式
- 设置加载和保存
- 跨窗口同步 (通过 Tauri 事件)
- 版本冲突处理
- 嵌套对象更新
- 自动重试机制

### 前端测试编写指南

#### 基本结构

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

describe('Feature Name', () => {
  beforeEach(() => {
    // 每个测试前的准备工作
  });

  afterEach(() => {
    // 每个测试后的清理工作
  });

  it('should do something', () => {
    // Arrange (准备)
    const input = createTestData();

    // Act (执行)
    const result = functionUnderTest(input);

    // Assert (断言)
    expect(result).toBe(expected);
  });
});
```

#### Mock 浏览器 API

前端测试需要模拟浏览器环境:

```typescript
// Mock window.location
const mockLocation = {
  hostname: 'weread.qq.com',
  href: 'https://weread.qq.com/',
};

beforeEach(() => {
  Object.defineProperty(window, 'location', {
    writable: true,
    value: mockLocation,
  });
});

// Mock Tauri API
beforeEach(() => {
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args: any) => {
        // Mock 实现
      }
    },
    event: {
      listen: (event: string, handler: Function) => {
        // Mock 实现
        return Promise.resolve(() => {});
      }
    }
  };
});
```

#### 异步测试

```typescript
it('should handle async operations', async () => {
  const promise = asyncFunction();

  // 等待完成
  const result = await promise;
  expect(result).toBe(expected);

  // 或者测试超时
  await expect(
    asyncFunctionWithTimeout(100)
  ).resolves.toBeUndefined();
});
```

#### 测试定时器

```typescript
it('should poll every 100ms', async () => {
  let pollCount = 0;
  const originalFunc = MyClass.checkStatus;

  MyClass.checkStatus = () => {
    pollCount++;
    return originalFunc.call(MyClass);
  };

  await MyClass.waitWithPolling(500);

  // 500ms 应该轮询约 5 次
  expect(pollCount).toBeGreaterThanOrEqual(4);
  expect(pollCount).toBeLessThanOrEqual(6);

  MyClass.checkStatus = originalFunc;
});
```

### 前端测试最佳实践

#### 1. 清理副作用

确保每个测试后清理 DOM 和全局状态:

```typescript
afterEach(() => {
  // 清理 DOM
  document.querySelectorAll('style[id^="test-"]')
    .forEach(el => el.remove());

  // 清理全局变量
  delete (window as any).__test_data;

  // 清理事件监听器
  eventBus.off('test-event');
});
```

#### 2. 使用描述性的测试名称

```typescript
// ✅ 好的命名
it('should replay history immediately for late subscribers')
it('should invalidate cache when domain changes')
it('should isolate errors between listeners')

// ❌ 不好的命名
it('should work')
it('test history')
it('test error')
```

#### 3. 一个测试只验证一个行为

```typescript
// ✅ 好的做法
it('should inject CSS into document head', () => {
  injectCSS('id', 'css');
  expect(document.getElementById('id')).not.toBeNull();
});

it('should update existing style element', () => {
  injectCSS('id', 'css1');
  injectCSS('id', 'css2');
  expect(document.querySelectorAll('#id').length).toBe(1);
});

// ❌ 坏的做法
it('should handle CSS injection', () => {
  // 测试了太多行为
  injectCSS('id', 'css');
  expect(document.getElementById('id')).not.toBeNull();
  injectCSS('id', 'css2');
  expect(document.querySelectorAll('#id').length).toBe(1);
  removeCSS('id');
  expect(document.getElementById('id')).toBeNull();
});
```

#### 4. 测试边界情况

```typescript
describe('Edge Cases', () => {
  it('should handle empty input', () => {
    expect(processData('')).toBe('');
  });

  it('should handle null values', () => {
    expect(processData(null)).toBeNull();
  });

  it('should handle concurrent operations', async () => {
    const promises = Array(100).fill(0).map(() =>
      asyncOperation()
    );
    const results = await Promise.all(promises);
    // 验证结果
  });
});
```

### 前端测试调试

#### 显示详细输出

```bash
# 显示所有 console.log
bun test --verbose

# 显示失败测试的详细信息
bun test --bail
```

#### 只运行特定测试

```bash
# 使用 it.only 只运行一个测试
it.only('should test this specific case', () => {
  // ...
});

# 使用 describe.only 只运行一组测试
describe.only('Critical Tests', () => {
  // ...
});
```

#### 跳过测试

```bash
# 临时跳过
it.skip('should test later', () => {
  // ...
});

# 条件跳过
it.skipIf(process.env.CI)('should skip in CI', () => {
  // ...
});
```

### 持续集成 (CI/CD)

完整的 CI 配置应该包含前后端测试:

```yaml
# .github/workflows/test.yml
jobs:
  test:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v3

      # Rust 后端测试
      - uses: actions-rs/toolchain@v1
        with:
          toolchain: stable
      - name: Run Rust tests
        run: cargo test --manifest-path src-tauri/Cargo.toml

      # TypeScript 前端测试
      - uses: oven-sh/setup-bun@v1
      - name: Install dependencies
        run: bun install
      - name: Run frontend tests
        run: bun test
```

---

## 参考资源

### 后端 (Rust)
- [Rust 测试文档](https://doc.rust-lang.org/book/ch11-00-testing.html)
- [Tauri 测试指南](https://v2.tauri.app/start/testing/)
- 项目内测试文件: `src-tauri/tests/`

### 前端 (TypeScript)
- [Bun 测试文档](https://bun.sh/docs/cli/test)
- [TypeScript 测试最佳实践](https://github.com/goldbergyoni/javascript-testing-best-practices)
- 项目内测试文件: `src/scripts/core/__tests__/`
