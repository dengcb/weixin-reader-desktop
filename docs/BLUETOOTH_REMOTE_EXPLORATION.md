# 小米蓝牙遥控器 HID 访问探索记录

- 日期：2026-08-08
- 目的：探索在 macOS 上获取小米蓝牙语音遥控器音量键/返回键/语音键事件的技术可行性
- 结论：macOS 对键盘类 HID 设备的系统级独占无法绕过，探索终止

## 1. 背景

### 1.1 需求

小米蓝牙语音遥控器在安卓平台上被广泛用作翻页器，音量加减键是翻页的标准操作。项目希望在 macOS 桌面端实现同样的音量键翻页体验，与安卓习惯一致。

### 1.2 当前支持现状

通过 WebView 的 DOM 键盘事件已正常工作的按键：

| 按键 | 事件来源 | 状态 |
|---|---|---|
| 电源键 | 键盘事件 | ✅ |
| 上/下/左/右 | 键盘事件（PageUp/PageDown/ArrowKey） | ✅ |
| 确认键 | 键盘事件（Enter） | ✅ |
| Home 键 | 键盘事件 | ✅ |
| 菜单键 | macOS 上的 heuristic 识别（contextmenu + Unidentified keyup） | ✅ |

无法获取事件的按键：

| 按键 | 原因 | 状态 |
|---|---|---|
| 音量+ | macOS 不生成系统事件 | ❌ |
| 音量- | macOS 不生成系统事件 | ❌ |
| 返回键 | macOS 不生成系统事件 | ❌ |
| 语音键 | macOS 不生成系统事件 | ❌ |

前端 `RemoteManager`（`src/scripts/managers/remote_manager.ts`）通过 WebView 的 `keydown`/`keyup`/`contextmenu` 事件接收遥控器输入。按音量键等时，WebView 收到的全是 null——不是"事件到了但没转发"，而是事件根本没进入应用层。

## 2. 设备信息

### 2.1 系统识别

macOS 系统信息中的设备属性：

```
小米蓝牙语音遥控器：
  地址：       08:EB:29:77:61:6A
  供应商ID：   0x2717
  产品ID：     0x32B8
  固件版本：   18667
  次要类型：   Mouse
  服务：       0x400000 < BLE >
```

macOS 将该设备识别为 **Mouse**（次要类型），而非键盘或 Consumer Control 设备。

### 2.2 IORegistry 设备节点

通过 `ioreg` 确认，macOS 为该设备创建了**一个 IOHIDDevice 服务**（`DevSrvsID:4327018639`），包含两个 usage collection：

- `DeviceUsagePairs` = `({"DeviceUsagePage"=1,"DeviceUsage"=6}, {"DeviceUsagePage"=12,"DeviceUsage"=1})`
  - Page 1, Usage 6 = Generic Desktop / Keyboard
  - Page 12, Usage 1 = Consumer / Consumer Control

两个 usage collection 共享同一个设备服务路径，不是两个独立设备。

其他属性：
- `Transport` = `Bluetooth Low Energy`
- `Manufacturer` = `Realtek BT`
- `SerialNumber` = `RTKBeeSerialNum`
- `RequiresTCCAuthorization` = Yes
- `HIDVirtualDevice` = No

### 2.3 HID Report Descriptor

完整 report descriptor（十六进制）：

```
05010906a1018501050719e029e715002501750195088102
950175088101950575010508190129059102950175039101
95067508152825fe0507192829fe8100050c0901a10185f1
150025017501951809b509b609b709cd09e209e509e709e9
09ea0a52010a53010a54010a55010a83010a8a010a92010a
94010a21020a23020a24020a25020a26020a27020a2a0281
02c0c0
```

#### Report ID 1：标准键盘报告（72 bits）

```
Usage Page = Generic Desktop (0x01)
Usage = Keyboard (0x06)

  8 bits: 修饰键 (Ctrl/Shift/Alt/GUI)
  8 bits: 保留
  5 bits: LED 指示灯 (NumLock/CapsLock/ScrollLock/Compose/Kana)
  3 bits: 保留
  48 bits: 6 键同时按下数组 (Usage 0x28~0xFE)
```

对应正常工作的方向键、确认键、Home 键等。

#### Report ID 241 (0xF1)：Consumer Control 报告（32 bits）

```
Usage Page = Consumer (0x0C)
Usage = Consumer Control (0x01)

24 位 bitmap，按声明顺序对应以下 usage：

  bit 0:  0xB5  Scan Next Track
  bit 1:  0xB6  Scan Previous Track
  bit 2:  0xB7  Stop
  bit 3:  0xCD  Play/Pause
  bit 4:  0xE2  Mute
  bit 5:  0xE5  Bass Boost
  bit 6:  0xE7  Loudness
  bit 7:  0xE9  Volume Increment  ← 音量+
  bit 8:  0xEA  Volume Decrement  ← 音量-
  bit 9:  0x152 AC Pan
  bit 10: 0x153 AC Copy
  bit 11: 0x154 AC Cut
  bit 12: 0x155 AC Paste
  bit 13: 0x183 AC Undo
  bit 14: 0x18A AC Find
  bit 15: 0x192 AC Help
  bit 16: 0x194 AC Forward
  bit 17: 0x210 AC Home
  bit 18: 0x223 AC Back           ← 返回键
  bit 19: 0x224 AC Forward (browser)
  bit 20: 0x225 AC Refresh
  bit 21: 0x226 AC Bookmarks
  bit 22: 0x227 AC Search
  bit 23: 0x22A AC Delete
```

**关键发现**：音量键（0xE9/0xEA）和返回键（0x0223）在 HID 描述符中完整声明。数据通过蓝牙到达了 macOS 的 IOHIDDevice 层（`InputReportElements` 注册了 Report ID 241），但未被映射成系统事件。

### 2.4 为什么 macOS 对音量键毫无反应

macOS 的 HID 事件系统（`IOHIDEventSystem`）将 IOHIDDevice 的 input report 转换为高层事件。但该设备使用了**非标准的 Report ID 241（0xF1）**来发送 Consumer Control 数据。标准的 HID Consumer Control 通常使用 Report ID 1 或不设 Report ID。macOS 的 HID 事件映射器可能不认识这个非标准 Report ID，导致 report 到达了设备层但没有被映射为 `NX_SYSDEFINED` 系统事件。

后果：
- 系统层面：按音量键无音量浮窗、无 OSD 提示
- 应用层面：`CGEventTap` 抓不到（事件未进入 CoreGraphics 层）
- WebView 层面：`keydown`/`keyup` 收到 null

## 3. 探索过程

### 3.1 hidapi 方案

#### 假设

如果 macOS 没有为 Consumer Control interface 创建系统 HID 服务（或未独占），hidapi 可以 open 设备直接读 raw input report，绕过系统解析。

#### 实现

在独立测试项目中使用 Rust `hidapi` crate（v2.6，启用 `macos-shared-device` feature）。

#### 验证结果

设备枚举成功：

```
VID=2717 PID=32b8 ★ Product=Some("小米蓝牙语音遥控器") Manufacturer=Some("Realtek BT")
VID=2717 PID=32b8 ★ Product=Some("小米蓝牙语音遥控器") Manufacturer=Some("Realtek BT")
```

发现两个 HID 节点（共享同一 `DevSrvsID`）：
- 节点 0：Usage Page 0x0001 (Keyboard)
- 节点 1：Usage Page 0x000C (Consumer Control)

尝试打开：

| 运行方式 | 错误码 | 含义 |
|---|---|---|
| `cargo run`（iTerm2，无输入监听权限） | `0xE00002E2` | TCC 权限不足 |
| `cargo run`（iTerm2，有输入监听权限） | `0xE00002E2` | TCC 权限不足（进程宿主不匹配） |
| 直接运行二进制（有输入监听权限） | `0xE00002C5` | **exclusive access and device already open** |

#### 结论

`0xE00002C5`（`kIOReturnExclusiveAccess`）确认 macOS 的 HID 事件系统已以独占模式 seize 了整个设备。hidapi 通过 `IOHIDDeviceOpen` 无法打开，即使是 shared 模式（`kIOHIDOptionsTypeNone`）。

### 3.2 IOHIDManager Report Callback 方案

#### 假设

`IOHIDManagerRegisterInputReportCallback` 是 Karabiner-Elements 等键盘监控工具使用的方式，以监听模式注册回调，不需要独占 open 设备。

#### 实现

直接使用 IOHIDManager FFI（不经过 hidapi），匹配 Keyboard + Consumer Control 两种 usage，注册 input report callback。

#### 验证结果

```
IOHIDManagerCreate           → 成功
IOHIDManagerSetDeviceMatching → 成功（匹配到设备）
IOHIDManagerRegisterInputReportCallback → 成功
IOHIDManagerScheduleWithRunLoop → 成功
IOHIDManagerOpen(None)       → 0xE00002C5 (exclusive access)
```

#### 结论

即使用 `kIOHIDOptionsTypeNone`（非独占、仅监听），`IOHIDManagerOpen` 仍返回 `0xE00002C5`。macOS 对键盘类 HID 设备的独占锁覆盖了整个设备服务（包括 Consumer Control collection），连监听模式都拒绝。

### 3.3 Karabiner-Elements 的实现方式

经查证，Karabiner-Elements 不是用普通用户态 API 实现的，它的架构是：

```
真实键盘 ──seize──→ Karabiner-Core-Service（root 守护进程）
                       │ 修改/过滤事件
                       ▼
                Karabiner-DriverKit-VirtualHIDDevice（DriverKit 系统扩展）
                       │ 虚拟 HID 设备
                       ▼
                   macOS 系统 ──→ 应用程序
```

- **Karabiner-Core-Service** 以 **root 权限**运行，seize 真实键盘硬件
- **Karabiner-DriverKit-VirtualHIDDevice** 是 **DriverKit 系统扩展**，提供虚拟键盘/鼠标
- 事件经拦截修改后通过虚拟设备重新注入系统

普通 Tauri 应用无法复制这种方式——它需要安装 root 守护进程和 DriverKit 系统扩展，对用户来说安装成本远超收益。

## 4. 方案总结

| 方案 | 能否拿到音量键 | 失败原因 |
|---|---|---|
| WebView DOM 事件 | ❌ | 事件未进入应用层 |
| hidapi (`IOHIDDeviceOpen`) | ❌ | `0xE00002C5` 系统独占 |
| IOHIDManager + Report Callback | ❌ | `0xE00002C5` 系统独占 |
| CGEventTap (`NX_SYSDEFINED`) | ❌ | 事件未进入 CoreGraphics 层 |
| Karabiner 式 root + DriverKit | ❌（不现实） | 需要安装系统扩展，安装成本过高 |
| CoreBluetooth / BLE GATT 直连 | 未验证 | 最后一条未探索的路径 |

### CoreBluetooth 方案的风险评估

CoreBluetooth 是唯一未验证的路径——从 BLE GATT 层直接订阅 HID Service (UUID 0x1812) 的 Report characteristic，完全绕过 HID 驱动栈。但风险在于：

1. macOS 的蓝牙栈管理 HID 设备时可能不允许应用层再建立 GATT 访问
2. BLE 连接可能已被系统蓝牙栈占用，应用无法获取第二个 GATT 会话
3. 实现复杂度高（需要 Objective-C/Swift FFI + CoreBluetooth 异步委托模式）

这条路的投入产出比不足以支撑当前阶段的开发，暂时搁置。

## 5. 对产品的影响

### 5.1 当前可接受的边界

macOS 上小米遥控器的音量键、返回键、语音键不可用，是 macOS 系统级别的限制，非应用层可解决。当前已支持的 8 个按键（电源、方向、确认、Home、菜单）覆盖了核心阅读操作。

### 5.2 重新探索的触发条件

以下任一条件满足时，可重新评估 CoreBluetooth 方案：

- 有用户明确提出音量键翻页需求且有 macOS 使用场景
- macOS 修改了 BLE HID 设备的 GATT 访问策略
- 出现社区验证过的 CoreBluetooth 读 HID report 的成功案例

## 6. 已删除的测试代码

本次探索创建了独立测试项目 `test-hidapi/`（含 hidapi 和 IOHIDManager 两个验证程序），探索结束后已完整删除，不影响主项目构建。
