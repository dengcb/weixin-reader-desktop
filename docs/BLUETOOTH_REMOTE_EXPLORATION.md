# 小米蓝牙遥控器 HID 访问探索记录

- 日期：2026-08-08
- 目的：探索在 macOS 上获取小米蓝牙语音遥控器音量键/返回键/语音键事件的技术可行性
- 结论（2026-08-08）：macOS 对键盘类 HID 设备的系统级独占无法绕过，探索终止
- 状态更新（2026-10-30）：结论被推翻——**监听路径可行**，识别层已落地为 `src-tauri/src/remote_hid.rs`，见文末「重启探索」

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

## 7. 重启探索（2026-10-30）：监听路径可行，识别层已落地

参照同作者生态的开源项目 remote-mic（SayAll，GPL-3.0，仅学机制不抄代码）确认了三个与上文结论相反的事实：

1. **`0xE00002C5` 不是死路**：那只是 `kIOHIDOptionsTypeNone` 普通打开的结果。`IOHIDDeviceOpen(device, kIOHIDOptionsTypeSeizeDevice)` 可以在仅有「输入监控」权限的情况下把设备从系统手里夺取（无需 root、无需 DriverKit）。且 SayAll 生产代码正常路径是监听模式打开 `IOHIDManagerOpen(kIOHIDOptionsTypeNone)` 并成功——上文失败的主因疑为裸命令行二进制的 TCC 归属问题（`0xE00002E2` 进程宿主不匹配即其症状）。
2. **「CGEventTap 抓不到音量键」结论错误**：音量键以 systemDefined（type 14，subtype 0/1）形式进入 session 级 CGEventTap，SayAll 生产环境稳定吞除。
3. **按键的真实 usage 在键盘页**：SayAll 实测解析 report ID 1——音量±为键盘页 0x80/0x81、返回键为保留区 0xF1、语音键为 0x3E（F5）、TV 0x35、电源 0x66、菜单 0x65（Application）、OK 0x28（Return）、Home 0x4A、方向 0x4F–0x52。与上文 Consumer 位图（0xE9/0xEA/0x223）的描述符分析不一致，属「描述符声明 ≠ 固件实际发送」，以真机报文为准。

### 已落地：`src-tauri/src/remote_hid.rs`（最小识别层）

第一性原理拆解：只需要「把所有按键识别成事件」，其余处理由既有链路承接。

- IOHIDManager + VID/PID 匹配 + `InputReportCallback` 直读原始报文（监听模式，不 seize，不改变系统行为）。
- report ID 1 双布局解析（紧凑 u16 数组 / 标准键盘 6 键位槽），与上次状态 diff 出按下/松开边沿。
- 广播 `remote-hid-button` 事件 `{ button, phase, usage }` 给 main 窗口；日志 target `remote-hid`。
- 权限：启动时 `IOHIDCheckAccess` 检查 + `IOHIDRequestAccess` 触发系统授权，失败后有界重试（6×5s）。

### 待真机验收（需实体遥控器）

- [ ] 监听模式在本机（打包/开发 app）能否打开；失败时授权流程是否引导成功。
- [ ] 逐键按 8 个键，核对日志与事件的 usage 值（尤其音量/返回/语音键），确认实际布局与双布局解析的匹配情况；未识别形状会记十六进制日志。
- [ ] 同一键是否同时产生原生键盘事件与 `remote-hid-button` 事件（预期如此，消费方按 `button` 名取舍去重）。
- [ ] 若监听模式收不到报文，再评估 seize 夺取路径（会接管全部按键，需自行注入回 WebView，成本高一个量级）。

#### 第一轮结果（2026-10-30 15:12）

- 监听模式打开成功、报文回调生效；`power`（0x66）/ `menu`（0x65）/ `home`（0x4A）识别正常，**电源键已可用作摸鱼键**。
- 返回/音量/语音键按下时：无 id=1 已知 usage，也无描述符预告的 id=241 报文。日志末尾出现一次 usages {0x08, 0x14}（键盘页 E/Y，同一秒两条 press、无 release 记录），时间点与被测键吻合，疑似即这些键的固件编码，待标注复测确认后才能映射。
- 存在两类周期性非按键报文：id=0 len=105（约 3Hz，前 4 字节计数、第 5-7 字节随机、其余恒定）与 id=0 len=5 成对握手（约 2.5s 周期，末字节自增）——疑为厂商遥测/保活通道（macOS 将该设备识别为 Mouse）。
- 成功解析的报文当时未记原始 hex，无法判断固件用的是标准 10 字节布局还是 SayAll 式紧凑 u16 布局（两者对音量键的预期编码完全不同）。

#### 第二轮准备：抓取模式（已实现）

- 成功解析报文按 hex 去重记录（`报文 id=… len=… hex=… usages=…`，有界 512 条）——一轮即可看清固件布局。
- 未识别报文按 (id, len) 类别 + 稳定区签名去重（每类前 3 条必记，遥测流只记一条不刷屏）；若按键事件藏于遥测报文，稳定区变化必然触发日志。
- 设备匹配时读取 `DeviceUsagePage` 并尝试节点级 `IOHIDDeviceOpen(None)`（SayAll 生产路径）；消费者页(12)节点被拒时尝试夺取兜底——macOS 本就不消费该节点，夺取不改变任何既有行为；键盘页节点绝不夺取。断开时关闭已打开节点。
- 复测方法：启动开发版（或打包版），静置 5 秒后依次按键，每键间隔 2 秒以上：**音量+ → 音量− → 返回 → 语音 → OK**，然后把 `remote-hid` 日志发回。

#### 节点独占问题（2026-10-30 16:40 发现）

- 纠正误读：`result=-536870203` 一直是 **0xE00002C5 = kIOReturnExclusiveAccess（节点被其他进程独占）**，不是 TCC 权限错误（0xE00002E2 是另一个数）。授权前的打开失败也报 0x2C5，掩盖了这一点。
- 每次会话约 20 个匹配节点中有 2 个被独占持有、重试无效。**和弦节点若在被占的 2 个里，音量/返回键整体静默**（15:48 会话可用、16:40 会话静默，节点打开结构完全相同，差异就在被占的是哪两个）。
- 嫌疑持有者：SayAll / Karabiner 等 seize 遥控器的 HID 工具；或狂按语音键后 macOS 蓝牙/音频栈独占厂商节点（遥控器断电重连可解）。
- 已实现：节点身份日志（LocationID / PrimaryUsagePage / PrimaryUsage）、失败节点 60 秒自动重试（主线程 dispatch 串行，防悬垂打开）、**非键盘页节点的夺取兜底**（PrimaryUsagePage 可读且 ≠1 才夺取；夺取消费者/厂商页不影响键盘路径，因为系统本就不消费它们）。

#### 启动崩溃事故（2026-10-31，已修复）

- 现象：加节点身份日志后 app 启动即 SIGSEGV（EXC_BAD_ACCESS at 0x0），重启无效。
- 根因：`cf_string()` 把 Rust `&str` 字节指针直接传给 `CFStringCreateWithCString`——`&str` 无 NUL 结尾，C 侧越界找 NUL，特定内存布局下返回 NULL key，`IOHIDDeviceGetProperty` 对 NULL 求长度即崩。崩溃报告栈：`IOHIDDeviceGetProperty ← read_device_property_i32 ← node_identity ← open_node ← 初始枚举`。此前只读一个属性「碰巧」没炸，纯运气。
- 修复：`CString::new()` 保证 NUL 结尾；属性值读取前用 `CFGetTypeID == CFNumberGetTypeID` 校验类型。
- 教训：此前「DeviceUsagePage 恒为 None」可能同样是越界读出的垃圾键名查不到属性所致——修复后属性读取第一次可信，本轮身份日志才算数。FFI 边界上的字符串必须显式 NUL 结尾，`&str.as_ptr()` 严禁直接交给 C。

#### 和弦状态机（已实现）

- 完整手势 `{E} → {E,码} → {码} → {}` 做集合级解释，只产出一次按下/松开；尾帧不再伪造 `key_E` 单击（逐 usage 边沿会伪造，已弃用）。
- 语音键 = id=2 len=65 报文对（byte1 非零=按下、全零=松开），产出 `voice` 按钮。
- 标注期（已结束）：按键定案前，`key_E` / `chord_E_Tab` / `chord_E_Y` / `voice` 按下时曾向主窗口发 `show-toast`；真机定案后已移除，只保留控制台日志。

## 8. 一期：前端接入与按键映射（2026-10-30）

架构定案：**自有蓝牙识别层为主，系统键盘事件路径降级为兜底**。系统路径继续承担方向/OK/Home/菜单等既有映射（HID 挂掉或未授权不受影响）；HID 事件只消费系统给不到的按键，两条链路按 `button` 天然分工，无需去重逻辑。

- `src/scripts/core/remote_hid_source.ts`：`remote-hid-button` 订阅封装（含注册/销毁竞态处理）与动作映射纯函数 `resolveRemoteHidAction`。
- `RemoteManager`（`src/scripts/managers/remote_manager.ts`）：`setupKeyboardListener` 末尾订阅，`disable` 取消。既有键盘/contextmenu 处理一行未动。
- 最终映射（2026-10-31 真机定案 + 用户拍板，遵循「只增不改」）：

| 按键 | usage | 动作 | 生效范围 |
|---|---|---|---|
| `volume_up` | 0x80 | **上一页** | 仅阅读页 |
| `volume_down` | 0x81 | **下一页** | 仅阅读页 |
| `back` | 0xF1 | **循环切换到下一个书城**（get_bookstore_list → 当前站+1 → sticky 过场 → switch_bookstore_by_index） | 任意页面 |
| `tv` | 0x35 | **切换阅读区域宽/窄**（simulate_menu_click('reader_wide')，继承菜单门禁） | 菜单门禁 |
| `power` | 0x66 | 摸鱼键（`toggle_stealth`，与 Cmd+` 同路径） | 任意页面 |
| `voice` | 0x3E | **按住语音翻页**（ATVV 收音 → 本机识别，与「语音翻页」开关解耦） | 仅 macOS |

- 设置页新增「蓝牙遥控」标签页（`src/windows/settings.html`）：SVG 遥控器示意图 + 8 项编号图例（几何审计零越界），含输入监控权限与平台差异说明。
- 已知副作用（二期解决）：监听模式下按音量键，系统音量仍会真实变化——音量以 NX_SYSDEFINED 进入 session 级 CGEventTap。
- 二期：学 SayAll `KeyboardEventSuppressor` 的布防窗口方案（收到原始报文先 arm 预期原生事件描述符，500ms 窗口内命中即吞），三条铁律：event tap 必须挂专用线程 RunLoop（挂主线程 = 主线程一卡整机输入停摆）；释放必须 `CFMachPortInvalidate`（残留 tap 随重连累积拖慢全系统输入）；权限撤销立即停 tap。
- 三期：语音键接 ATVV 蓝牙音频流（SayAll 的 `AB5E0001-…` 服务族，IMA/DVI ADPCM → 16kHz PCM → 喂现有 `voice_turner` 的 Speech.framework 识别），遥控器作为语音翻页的输入麦克风；固件仅在按住语音键时发音频，天然 PTT。
- 许可约束：SayAll 为 GPL-3.0-only，只学机制（API 序列、参数、坑位、实测 usage 表），Rust 独立实现，不引入其任何源码。

### 最终协议确认（2026-10-30 17:16 会话，Karabiner 卸载后）

正确遥控器的协议就是 SayAll RC003 式**单 usage 报文**（id=1 len=9，`01 00 00 <usage> 00…`）：0x80/0x81 音量、0xF1 返回、0x3E 语音（键盘页 F5），原始 `usage_name` 表零修改直接命中。此前的「字母和弦」全部来自另一台遥控器/受 Karabiner 干扰的会话，**不是本机协议**；和弦状态机保留作为另一台遥控器的兼容路径（其 `key_E`/`chord_*` 名与本机协议互不干扰）。Karabiner（独占 seize 键盘类设备）是节点 0xE00002C5 独占错误的元凶，卸载后节点全部可打开。

## 9. Windows 支持与边界（2026-10-31，W1 已实现）

参照 remote-mic-app-windows（SayAll Windows 版，Rust + Tauri 2，GPL-3.0，只学机制不抄代码）的真机调查（其 docs/investigations/2026-09-23 系列）：

- RC003 固件把返回 0xF1 / 音量± 0x80/0x81 声明在键盘页 report 1（与可用的 OK/Home 同一报告），但 Windows `kbdhid` 驱动的 HID→VK 映射表缺这三个 usage，**键码翻译阶段直接丢弃，系统层面零事件**。
- **无提权路径已被穷尽实测否决**：厂商 GATT 通知静默、GATT HID 特征 AccessDenied、用户态直读 HID 顶层集合被 Raw Input Manager 独占拒绝、Raw Input 注册厂商页零事件。音量±/返回（RC003 协议）在 Windows 不可得，维持文档边界。
- SayAll 增强轨 = UAC Helper + **Frida Gadget 注入 WUDFHost.exe 报告层**（读/清空报告，实测通过）。本项目不做提权注入（杀软敏感、审计与签名成本远超阅读器收益）。

### W1：零提权 Raw Input（`src-tauri/src/remote_hid_windows.rs`）

- 专用线程 message-only 窗口 + `RegisterRawInputDevices`（键盘 TLC，`RIDEV_INPUTSINK | RIDEV_DEVNOTIFY`）。
- `GetRawInputData` 解析 `RAWKEYBOARD`；`GetRawInputDeviceInfoW` 设备路径 VID/PID 归因（结果缓存）；`hDevice` 为空的事件（系统注入/遗留）忽略。
- 增补按键（`button_for_keyboard`）：TV（VK_OEM_3 0xC0）、语音（F5 0x74）、媒体音量键（VK_VOLUME_UP/DOWN 0xAF/0xAE）、**RC001 系厂商键族**（VK 0xFF + 扫描码：0x6A 返回、0x30/0x2E 音量±、0x5E 电源——物理键盘不会产生 VK 0xFF，零原生副作用）。
- 刻意不接：**VK_SLEEP**（RC003 电源形态，原生触发系统睡眠，接入即「按电源电脑睡眠」）；方向/OK/Home/菜单（WebView 键盘路径已处理，只增不改）；静音（无绑定动作）。
- 副作用说明：F5 的页面刷新与未接入时的现状基线一致，接入只增加事件可见性；TV 的 `` ` `` 字符输入在阅读页无感。
- 边沿状态机去自动重复；`WM_INPUT_DEVICE_CHANGE` 清归因缓存，设备移除时复位边沿状态防粘键。
- 事件契约与 macOS 相同（`remote-hid-button` `{button, phase, usage}`），前端零改动。
- 验证状态：VK 映射与边沿纯逻辑已单测（macOS 上运行）；`x86_64-pc-windows-msvc` cargo xwin check 通过；aarch64 本地交叉检查被既有工具链问题阻挡（ring 0.17 构建脚本与 cargo-xwin 的 `/imsvc` 参数注入不兼容，与本模块无关），由 CI 原生 Windows ARM64 构建验证；**运行时行为待 Windows 真机验收**。

## 10. 三期：ATVV 语音翻页（2026-10-31 已实现，待真机验收）

小米遥控器的语音走 Android TV 私有 ATVV 服务（GATT），macOS 不认识它——**本项目进程内充当遥控器专属语音客户端**，系统蓝牙栈只搬运字节，语义由 `remote_voice.rs` 与遥控器按协议约定（机制参照 remote-mic/SayAll，GPL-3.0，只学机制不抄代码；ADPCM 按公开 IMA 算法独立实现）。

### 协议规格（真机与参考实现核对，规格注在模块头注释）

- 服务 `AB5E0001-5A21-4F05-BC7D-AF01F617B664`；特征 AB5E0002 下行命令（写，支持 writeWithoutResponse 时优先）、AB5E0003 上行音频（通知）、AB5E0004 上行控制（通知）。
- 建链：`retrieveConnectedPeripherals`（系统已为 HID 连着，无需扫描）→ connect → 发现特征 → 订阅 audio/control → 写能力查询 `0A 01 00 00 03 03` → 控制通道 0x0B 能力（codec 0x02=16kHz 才可用，frameSize=120 字节=240 样本=15ms）→ 0x07 就绪。
- **遥控器主动发起**：按住语音键 → 控制通道 0x08 请求开麦 → 宿主写 `0C 00`（version≥0x0100）→ 0x04 流开始（b3=会话 ID）；松开 → 0x00 流结束 → 宿主写 `0D <sid>`。同步包 0x0A 携带 predictor/stepIndex，丢弃半帧后应用于下一整帧。
- 音频通道是纯 ADPCM 字节流，按 frameSize 累积 → IMA 解码（高半字节优先）→ 三点平滑 → 送识别器；stop 后 0.3s 内到达的音频丢弃；音频先于 0x04 到达视为隐式开始。

### 架构与交互（用户拍板的模型）

- `remote_voice.rs`（macOS，约 1050 行）：CoreBluetooth 客户端（`define_class!` 委托 + 主队列回调）+ ATVV 协议解析 + IMA ADPCM 解码 + 帧累积（纯逻辑 6 项单测：编解码往返、能力/控制解析、帧切分、竞态守卫）。**链路生命周期与「语音翻页」开关解耦**：遥控器经 HID 连接即 `ensure_started()` 建链，开关关闭也不拆链；开关开启时也会提前建链（不依赖输入监控权限）。进程级静态状态不进 tauri State。
- `voice_turner.rs`：新增 `ListenMode`（Microphone/RemotePush）。语音键是独立输入：ATVV 就绪且（开关开启或语音键按过）→ PTT 监听器；开关开启但遥控器未就绪 → 常开麦克监听；两者皆无 → 不监听。断开自动回落，设置本身不变。
- 音频出口：解码样本经 mpsc 送 PTT 监听线程，装 `AVAudioPCMBuffer`（16kHz 单声道 Float32）喂 `SFSpeechAudioBufferRecognitionRequest`；识别回调与 TriggerGate/翻页动作完全复用既有链路。ATVV 模式**不需要麦克风权限**（不用系统录音设备），只要语音识别授权 + 新增的蓝牙授权。
- `Info.plist` 新增 `NSBluetoothAlwaysUsageDescription`；dev 裸二进制缺该键时链路不启动（TCC 守卫）。

### 真机验收清单（需实体遥控器 + 打包版）

- [ ] 遥控器连接后触发蓝牙授权弹窗（或首次开启语音翻页时触发）；允许后日志出现「蓝牙已就绪，检索遥控器（ATVV）」。
- [ ] 连接遥控器后日志依次出现：遥控器已连接 → 已连接（ATVV）→ 订阅 audio/control → 能力确认 → 监听形态切换为 remote ptt。
- [ ] 语音翻页开关关闭时：首次按住语音键触发语音识别授权；允许后再按一次，说「翻页」触发翻页（命中率标准：安静环境 20 次中 ≥18）。
- [ ] 松开：「流结束」；重复按住可持续会话。
- [ ] 断开遥控器 → 开关开启则回常开麦克监听、关闭则停止监听；重连 → 回 PTT。关闭设置「语音翻页」→ 只停常开麦克风，蓝牙链路与语音键保持可用。
- [ ] 全程系统麦克风列表无新设备、其他 app 不受影响。
