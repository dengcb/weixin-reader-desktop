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
- [ ] 音量键按住时只翻页、系统音量不变（需「辅助功能」授权）；松开后物理键盘音量键正常；未授权时仅提示、不阻断翻页。

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
| `volume_up` | 0x80 | **短按上一页；长按页面放大**（simulate_menu_click('zoom_in')，同 ⌘+=） | 短按仅阅读页，长按任意页面 |
| `volume_down` | 0x81 | **短按下一页；长按页面缩小**（同 ⌘+-） | 同上 |
| `back` | 0xF1 | **短按切换阅读区域宽/窄**（simulate_menu_click('reader_wide')，继承菜单门禁）；**长按页面恢复 100%**（同 ⌘0） | 短按菜单门禁，长按任意页面 |
| `home` | 0x4A | **短按显隐顶部导航栏**（原系统键盘路径语义，系统路径只拦截不再触发）；**长按回书架**（新菜单动作 bookstore_shelf：插件 `manifest.site.shelf` 优先，缺省回退首页；本地书由 local-reader 跳本地书架页） | 短按仅阅读页，长按任意页面 |
| `tv` | 0x35 | **短按切下一个书城；长按呼出 Cmd+Tab 式书城浮层**（0.5 秒/项轮播，松开提交） | 任意页面 |
| `power` | 0x66 | **短按摸鱼**（`toggle_stealth`，与 Cmd+` 同路径）。长按不绑定动作：macOS 的 loginwindow 在 HID 系统层对电源键按住 ~1 秒直接发起 Software Sleep 息屏，CGEventTap 拦不住（2026-11-10 实证：抑制器吞掉 keyDown 122 后仍在按下整 1 秒息屏），应用层无解；退出走 ⌘Q / 应用菜单 | 任意页面 |
| `voice` | 0x3E | **按住语音翻页**（ATVV 收音 → 本机识别，与「语音翻页」开关解耦）；**短按切换「语音翻页」开关** | 当前仅 macOS（Windows 可经 WinRT GATT，尚未接入） |
| `menu` | 0x65 | **短按显隐阅读工具栏；长按打开章节目录**（各书城原生目录 + 本地阅读器） | 仅阅读页 |

- 长按分流为通用机制（`handleButtonHold`，RemoteManager 与 local-reader 同构）：按住 500ms 触发长按（仅一次），松开时长按未触发才执行短按；音量/返回的短按因此从「按下即触发」改为「松开时触发」（tap 间隔内不可感知），长按与短按互斥。
- 本地阅读页按键语义与远程站点一致（`local-reader` 的 `handleRemoteButtonHold`）：音量± 短按翻页/长按缩放，返回 长按恢复 100%（短按宽窄），主页 长按跳本地书架页（`atreader://…/local-shelf`，微信读书书架式网格、深浅色自适应），电源 短按摸鱼（长按不绑定，见上表），**OK/Enter 全屏**（2026-11-08 与站点侧对齐；此前本地键盘把 Enter 误占为宽窄切换，宽窄保留 9 键/菜单「阅读变宽」/遥控返回键三个入口）；音量/返回受「阅读快捷键与遥控器」开关统一门禁。
  - 站点深链回弹守卫（如多看 10 秒内离页劫持回正文）会吞掉回书架导航：主页键长按导航前在 sessionStorage 打 `atreader-home-nav` 标记，守卫据此放行（多看插件 `guardDeepLinkBounce` 消费）。
  - 各站书架 URL（2026-11-06 抓取）：weread `/web/shelf`、番茄 `/bookshelf`、起点 `/shelf/`、七猫 `/shelf`（未登录空壳，待登录态确认）、掌阅 首页即书架；多看 `/pc/boughtlist`（我的书架）、得到 `/bought`、zread `zread.ai/library`（我的书架，用户拍板）。

- 设置页新增「蓝牙遥控」标签页（`src/windows/settings.html`）：SVG 遥控器示意图 + 8 项编号图例（几何审计零越界），含输入监控权限与平台差异说明。

### 菜单键长按打开目录（2026-11-04 设计，2026-11-06 真机收口）

- 交互：短按菜单键在松开时——目录开着则收起目录（长按开 → 单击关循环），否则显隐工具栏；按住 **500ms** 打开目录。
- 注入层 `RemoteManager` 统一处理系统键盘/contextmenu 与自有 HID 的 `menu` press/release，避免双路径重复切换；`reader_toc.ts` 负责各站点入口。站点打开方式分三类（真机逐一验证，勿轻易合并）：
  - **CSS 强制显示**（面板本就在 DOM、关闭态 display:none，注入样式放开即等效替官方脚本「显示目录」）：微信读书 `.readerCatalog`（React onClick 直调优先，未暴露 `__reactProps$` 时自动落回；另补 flex 列布局 + 滚动区 `overflow-y`/手动 scrollTop——站点在 document 捕获期 preventDefault 滚轮、面板 height 由站点 JS 惰性设置）+ 全文遮罩 + 按章节标题后缀匹配定位当前章（`isCatalogTitleMatch`）+ 选章点击自导航（`atreader:toc-chapter-pick` 事件 → chapterManager）；七猫 `.qm-fixed-right-extend`（抽屉靠 CSS :hover 展开，合成事件触发不了 :hover，连同工具栏容器一起放开并翻到工具栏左侧防溢出屏）。
  - **点击路径**：番茄工具栏条目、起点 `#r-menu` 内最深「目录」节点、得到 `button.reader-tool-button.right-button-group-first-button`、多看 `span.j-toc`、掌阅 `[data-role="catalog"]`（原生抽屉已展开则跳过）。入口被「隐藏工具栏」收起时临时撤隐藏样式（`wxrd-hide-toolbar` / `plugin-<id>-toolbar`）再点：起点/得到关闭态宽高由站点 JS 惰性设置（rect 0×0），CSS 强制无效，只能点击。
  - 本地阅读器在 `src/local-reader/index.ts` 单独监听 `remote-hid-button`：长按打开 `#chapterButton` 面板，短按收起；同时拦截遥控菜单键引发的 `contextmenu`（顶层 + 全部同源 iframe——焦点在正文 iframe 时事件派发不到顶层），避免弹 WebKit 默认菜单；目录/样式面板带 45% 黑遮罩（点遮罩/Esc/短按收起），面板近满高（上下 12px）。
  - 合成点击要点：真实点击事件序列（pointerdown → mousedown → pointerup → mouseup → click）+ 坐标/`detail` 字段；`isTrusted` 在实例上 `defineProperty` 伪装为 true（原型 getter 可被实例覆盖）——番茄/起点/得到/多看均吃这套；微信读书防护更深（`isTrusted` 伪装也无效），只有 React 直调或 CSS 强制两条路。
  - 得到原生支持 ←/→ 翻页：插件 `nextPage/prevPage` 合成方向键桥接遥控音量键翻页（`defineProperty` 注入 keyCode，同多看）。
- 已知副作用（2026-10-31 已解决）：监听模式下按音量键，系统音量仍会真实变化——音量以 NX_SYSDEFINED 进入会话级事件流。现在 `media_key_suppressor.rs` 在遥控器音量键按住期间用会话级 CGEventTap 吞掉**全部 NX_SYSDEFINED**（系统事件里的键码与到达顺序不可靠，整类吞掉最稳），松开即恢复；30 秒兜底有效期防止 release 丢失。物理键盘音量键只在遥控器音量键按住的那一瞬间被一并吞掉。
- 抑制器约束：修改事件需要「辅助功能」权限（未授权时只提示、不阻断翻页；已授权时遥控器连接即预启动 tap，避免首次按键漏吞）；tap 跑在专用线程 RunLoop 上（挂主线程 = 主线程一卡整机输入停摆）；系统超时/禁用后立即重新启用；进程退出由系统回收。
- 抑制竞速修复（2026-11-08）：HELD 标志原先由主 RunLoop 上的 HID 报文回调置位，应用刚切前台时主线程排队可达数百毫秒，系统 NX_SYSDEFINED 先到 tap，偶发**首次按音量键漏吞一次系统音量**（再按即正常，因主线程空闲后回调能及时置位）。HID 回调整体迁至专用线程 RunLoop（`hid-remote-report`），标志位微秒级落位稳定赢得竞速；配套把节点打开与设备移除的串行从「同在主线程」改为 nodes 锁互斥（`open_node_locked` 须持锁调用）。若再现首次漏吞，先查启动日志是否出现「主 RunLoop 降级」（专用线程创建失败的兜底路径）。
- 后台 App Nap 失控（2026-11-09）：**后台启动且从未激活过的 app 会被 macOS App Nap 冻结全部线程**——抑制 tap 停摆（NX_SYSDEFINED 旁路直出系统音量）、HID 回调停摆，后台期间音量键完全失控；回前台唤醒后首键还需等 tap 超时重启用，之后才恢复接管（与 2026-11-08 的前台竞速是两个独立病灶）。修复：tap 建立即持有 `NSActivityUserInitiatedAllowingIdleSystemSleep`（0x00FFFFFF）活动断言——只禁 App Nap、不阻止系统空闲睡眠，断言随 tap 同生命周期保持至进程退出。日志标记：「已持有禁用 App Nap 断言（保持遥控事件响应）」。
- 结构性竞速与 30ms 等待窗口（2026-11-09 指纹定案）：nap 断言生效后仍约 1/4~1/5 概率漏吞，指纹日志实测 **NX_SYSDEFINED 稳态先于 HID 报文 0~6ms 到达**（极端卡顿 148~224ms）——系统在内核直接生成事件（快路），HELD 置位要等报文绕到用户态回调（慢路），毫秒级掷硬币，无法靠省延迟根除。用户拍板保守方案：tap 内对未裁决的 NX_SYSDEFINED **最多等 30ms** 让 HELD 追上——仅遥控器在位期间启用（`remote_device_matched/removed` 按节点计数门禁），物理键盘媒体键等满后照常放行，多 ≤30ms 无感延迟；本回调只拦 NX 类事件，等待不阻塞其他输入。排查期的逐键指纹日志（漏吞嫌疑/竞速追上）验收通过后已移除，仅保留「tap 被系统禁用（已重新启用）」与「release 丢失超时兜底」两条异常日志；残留漏吞只可能来自 >30ms 的进程级卡顿。彻底方案（遥控器连接期间整类吞掉，代价是物理键盘媒体键失效）已评估，未采纳。
- 三期：语音键接 ATVV 蓝牙音频流（SayAll 的 `AB5E0001-…` 服务族，IMA/DVI ADPCM → 16kHz PCM → 喂现有 `voice_turner` 的 Speech.framework 识别），遥控器作为语音翻页的输入麦克风；固件仅在按住语音键时发音频，天然 PTT。
- 许可约束：SayAll 为 GPL-3.0-only，只学机制（API 序列、参数、坑位、实测 usage 表），Rust 独立实现，不引入其任何源码。

### 本地阅读页的遥控双链陷阱（2026-11-07 修复）

本地阅读页（`atreader://…/local-reader`）运行**完整的 AppRuntime('local') Manager 栈**，其中 RemoteManager 与 local-reader 自己的遥控监听**同时订阅** `remote-hid-button`——同一按键事件有两个潜在执行者。这不是缺陷而是刻意复用（设置/菜单/缩放/书城切换全走共享栈），但接线时必须意识到双链存在。

- **分工边界（现行规则）**：本地页遥控按钮语义归 `src/local-reader/index.ts` 的 `handleRemoteButtonHold`（菜单/音量/返回/主页/电源）；RemoteManager 的 `handleRemoteHidButton` 入口与菜单信号入口（`handleRemoteMenuSignal`/`Release`）均以 `siteId === 'local'` 守卫整页让路。TV 键由 `BookstoreSwitcherManager` 独立订阅，不受守卫影响。
- **RemoteManager 不能在本地页裁掉**：菜单「上一页/下一页/上一章/下一章」经 MenuManager 发 `READER_COMMAND`，由 RemoteManager 执行 `performPageTurn`/`navigateChapter`，再经 LocalSiteRuntime 桥接到本地阅读器——删了它本地菜单翻页全失灵。
- **事故指纹（2026-11-07）**：返回/主页短按设置被翻转两次（页面变宽又变窄、导航栏收起又展开）；电源短按 `toggle_stealth` 两次等于失效；音量键两条链各调一次 nextPage，同一 tick 内都算出同一目标页，视觉合并成一次——**侥幸掩盖了双链**，让人误判只有部分按键出问题。
- **排查提示**：RemoteManager 的动作日志走 `log.info`（console-only，不落盘），`艾特阅读.log` 只会看到 local-reader 的动作（`key_event`/`system_action`/`remote_action`）。「日志里每键只有一次动作、设置却翻了两次」就是 Manager 栈里存在第二个执行者的指纹。
- **开发守则**：给**本地页**加遥控按键 → 只改 local-reader 的 `handleRemoteButtonHold`；给**站点**加新按键 → RemoteManager 加 case（本地页被守卫自动跳过）；任何「Manager 栈与 local-reader 都可能订阅的输入」（遥控 HID、系统键盘、事件总线）接线前先问一句：**这个输入在这页归谁**。回归测试：`remote_manager.test.ts`「本地阅读页（siteId=local）遥控按钮全部让路给 local-reader」。

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

### Windows 语音可行性更正（2026-11-02）

- 早期「Windows 语音不可得」只适用于音量 ± / 返回等 **HID 键码**（kbdhid 翻译层丢弃）；语音走 ATVV GATT，不经过 HID 栈。
- 平行目录参考实现 `remote-mic-app-windows/crates/sayall-windows/src/ble.rs`（GPL-3.0，只读学机制）已用 WinRT `BluetoothLEDevice` + `GattCharacteristic` 直连同一组 ATVV GUID（`AB5E0001…`），证明 Windows 语音可行。
- 真机坑位：MIC_EXTEND（0x0E）每 **2.5s** 续期（固件免费音频窗口约 5–6s）；静默 **8s** 强制收尾，防「按住说话」粘死；WinRT 异步 GATT 调用必须设界（半死链路可能永不返回）。
- 本项目**尚未接入** Windows 语音；文档不再声称不可行。

### Windows 语音实现骨架（接线层未接，等待有真机的开发者 PR）

**代码位置与状态**

- `src-tauri/src/atvv_core.rs`：跨平台 ATVV 协议/ADPCM/流状态（从 macOS 抽出，单测共用）。
- `src-tauri/src/remote_voice_windows.rs`：WinRT GATT 客户端 + WASAPI 渲染到 VB-CABLE 的实验性骨架，文件级 `allow(dead_code)`。
- 当前**不启动任何会话**、不改变用户行为：唯一入口 `start_ptt()` 固定返回 `WiringPending`；Windows 语音仍按现状走默认麦克风。
- 编译状态：`cargo xwin check --target x86_64-pc-windows-msvc` 通过；aarch64 仅受既有 ring/cargo-xwin `/imsvc` 工具链问题阻挡，需 CI/真机验证。

**已实现（机制参考 remote-mic，独立实现）**

- 已配对 BLE 设备按名称找遥控器 → `BluetoothLEDevice` 连接 → ATVV 服务/特征发现 → 订阅 audio/control → 写能力查询。
- 控制状态机：0x0B 能力即就绪、0x08 开麦、0x04 流开始、0x0A 同步、0x00 结束；流中每 2.5s 写 MIC_EXTEND(0x0E)，静默 8s 强制收尾。
- ADPCM 解码经 `atvv_core`，PCM 由 WASAPI 以 16kHz 单声道 s16 渲染到 `CABLE Input`（共享模式 + autoconvert，冷端点先读混音格式预热）。
- GATT 查询/写入使用 `wait_bounded`（超时 Cancel），避免半死链路永不返回。

**故意未接的最后一层（PR 入口）**

1. `switch_default_recording_device()`：用 `IPolicyConfig::SetDefaultEndpoint` 在 PTT 期间把默认录音设备切到 `CABLE Output`，结束时恢复 console/communications 两套默认；失败/退出兜底。
2. Windows 语音键接线：按住 ≥300ms 调用 `start_ptt`，松开停止并恢复默认设备；短按仍切「语音翻页」开关（与 macOS 对齐）。
3. VB-CABLE 检测与引导：不能随包分发；未安装时提示并提供官方下载指引；设置页可加「恢复默认麦克风」按钮。
4. 关闭 `remote_voice_windows.rs` 的 `allow(dead_code)` 并在 `lib.rs`/`voice_turner` 中正式持有状态。

**PR 验收清单（Windows 真机）**

- [ ] Win10/Win11 + 二代 2 / 2 Pro：日志出现 ATVV 能力 0x0B、流开始、MIC_EXTEND、流结束。
- [ ] PTT 期间 `CABLE Output` 成为默认录音设备，现有 WinRT 识别器能识别「翻页」并翻页；松开后默认设备恢复。
- [ ] 连续长按 >8s：静默收尾不粘死；2.5s 续期不断流。
- [ ] 未安装 VB-CABLE / 改名端点：给出明确错误，不改默认设备、不影响其他应用。
- [ ] 应用退出/异常路径恢复默认设备；提供手动恢复入口。
- [ ] 其他会议/录音软件在 PTT 结束后恢复正常。
- [ ] `cargo xwin check` 双架构 + Windows 真机运行通过。

**已知坑位**

- VB-CABLE 端点名存在 `CABLE Input` / `CABLE In 16 Ch` 等变体，需按名称模糊匹配并处理同设备端点兜底。
- 冷端点首次 Initialize 可能返回 0x8889000A；先 `get_mixformat()` 预热。
- WinRT 异步调用必须有界；GATT 通知在 MTA 线程，需 `RoInitialize(RO_INIT_MULTITHREADED)`。
- 参考实现是 GPL-3.0，只学机制；本项目代码为独立实现。

## 10. 三期：ATVV 语音翻页（2026-10-31 已实现，仅二代 2 / 2 Pro）

小米遥控器的语音走 Android TV 私有 ATVV 服务（GATT），macOS 不认识它——**本项目进程内充当遥控器专属语音客户端**，系统蓝牙栈只搬运字节，语义由 `remote_voice.rs` 与遥控器按协议约定（机制参照 remote-mic/SayAll，GPL-3.0，只学机制不抄代码；ADPCM 按公开 IMA 算法独立实现）。

### 型号兼容性（2026-10-31 真机定案）

- **二代普通版与 Pro（2 / 2 Pro，Pro 即 RC003-MS）均支持**：广播包含 ATVV 服务，按住语音键由遥控器主动发起语音会话。普通版已真机验证；Pro/RC003 依据参考实现（ATVV、高半字节优先），待真机复验。ARN9 固件为低半字节优先，当前未做 2A24 型号自适应，不在 2 / 2 Pro 范围内。
- **一代小米蓝牙语音遥控器不支持**：RTKBee（PID `0x32B8`、固件 18667），Mac 配对下 GATT 只有 `180F` 电池、`180A` 设备信息与 `FEF6`（Wiced Smart 通用框架，无音频寄存器与可用控制点）；语音键只发标准 HID F5；按住时 `FEF6` 通知特征零数据，Wiced Smart 标准读命令无响应。其语音链路只存在于与小米电视的配对协议中，公开资料未覆盖。
- 实现侧边界：连接后发现 ATVV 缺失即置 `unsupported` 并停止重连（避免对不支持的硬件空转），设置页与 README 均标注「仅二代 2 / 2 Pro」。

### 协议规格（真机与参考实现核对，规格注在模块头注释）

- 服务 `AB5E0001-5A21-4F05-BC7D-AF01F617B664`；特征 AB5E0002 下行命令（写，支持 writeWithoutResponse 时优先）、AB5E0003 上行音频（通知）、AB5E0004 上行控制（通知）。
- 建链：种子服务查询（`1812/180F/ATVV`，按名称过滤）或缓存标识直连 → connect → 发现特征 → 订阅 audio/control → 写能力查询 `0A 01 00 00 03 03` → 控制通道 0x0B 能力（codec 0x02=16kHz 才可用，frameSize=120 字节=240 样本=15ms）。**二代固件实测只发 0x0B、不发 0x07**，能力确认即可视为就绪。
- **遥控器主动发起**：按住语音键 → 控制通道 0x08 请求开麦 → 宿主写 `0C 00`（version≥0x0100）→ 0x04 流开始（b3=会话 ID）；松开 → 0x00 流结束 → 宿主写 `0D <sid>`。同步包 0x0A 携带 predictor/stepIndex，丢弃半帧后应用于下一整帧。
- 音频通道是纯 ADPCM 字节流，按 frameSize 累积 → IMA 解码 → 三点平滑 → 送识别器。半字节顺序随芯片/固件不同：二代普通版真机收听验证为**高半字节优先**；参考实现中 RC001/RC003 为高优先、ARN9 为低优先（按 2A24 型号串切换）。未收到 0x04 流开始的音频一律丢弃，避免上一会话解码状态污染。
- **解码坑（2026-11-01 真机）**：步长索引更新必须做有符号 clamp——`0 + (-1)` 若先转 `usize` 会回绕成巨大值再 clamp 到 88，步长瞬间爆炸成满幅噪声，识别器会在噪声上误判「翻页/翻译」。

### 架构与交互（用户拍板的模型）

- `remote_voice.rs`（macOS，约 1050 行）：CoreBluetooth 客户端（`define_class!` 委托 + 主队列回调）+ ATVV 协议解析 + IMA ADPCM 解码 + 帧累积（纯逻辑 6 项单测：编解码往返、能力/控制解析、帧切分、竞态守卫）。**链路生命周期与「语音翻页」开关解耦**：有标识缓存时启动即建链，否则由 HID 连接触发；开关关闭也不拆链。发现顺序：缓存标识直连 → 系统已连外设（`1812/180F/ATVV` 种子服务，按名称过滤）→ 扫描配对广播；连接 8 秒未完成则取消重试。进程级静态状态不进 tauri State。
- CoreBluetooth 两个运行时坑（均已修）：`CBCentralManager/CBPeripheral.delegate` 是 weak 属性，委托对象必须静态持有，否则回调全部静默丢失；`define_class!` 的方法选择器参数个数在类注册时断言，`didUpdateValueForCharacteristic` 必须写全 `…:error:`，否则遥控器一连上即 abort。
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
- [ ] 一代遥控器：连接后日志出现「该遥控器不提供 ATVV 语音服务」且不再重连；按住语音键不触发语音翻页（设置页已标注仅支持二代 2 / 2 Pro）。
