# esp32s3-bringup 设计文档

日期：2026-10-28　作者：Johnny Zong（与 Claude 讨论整理）

## 1. 目的与背景

用户在 Velloc Code（本地已装，v1.155.2.4）里做 ESP32-S3 开发。今天第一次插板时，花了很多来回才弄清：
板子没被识别（插错口/线）→ CP2102N 缺驱动（错误码 28）→ 装驱动 → esptool 读芯片 → 抓启动日志。

目标是做一个和已有 `esp8266-bringup` 同类的插件，但针对 ESP32-S3，并且**在 Velloc 里有一个常驻面板**：
插上板子，面板自动显示"在线"；认识的板子直接显示芯片信息，新板子点一下"检测"再显示；以后再加串口监视器。

## 2. 目标 / 非目标 / 反目标

**目标**
- 第一阶段（本次交付）：自动发现板子 + 只读检测 + 在 Velloc 面板和状态栏显示结果。
- 第二阶段（后续）：面板内串口监视器 + "复位并抓启动日志" + 日志关键行解读。
- skill / 命令 / Python 脚本在 Claude Code 里同样能用（只是没有面板）。

**非目标**
- 不备份、不刷固件、不写 Flash、不改 eFuse、不写 NVS。**全程只读**（用户已确认）。
- 不支持 ESP32-S3 以外芯片的专门逻辑（脚本识别到别的 ESP 芯片时如实显示即可，不报错）。

**反目标（即使能跑也算失败）**
- 面板反复复位板子：后台轮询绝不能打开串口，只能看 USB 设备列表。
- 抢占用户正在用的串口（例如 idf.py monitor 开着时去打开 COM 口导致对方断开或报错）。
- 板子明明有问题却显示"正常"；或缺驱动时只显示"未连接"而不说原因。

## 3. 用户确认的决定

- 主要在 Velloc 里用；Claude Code 兼容是附带的。
- 面板需要两样：自动在线 + 芯片信息（先做）；串口监视器（后做）。
- 全程只读，检测时复位一次板子是可接受的唯一副作用。

## 4. 已知事实（来自本机侦察）

**硬件（今天实测）**
- 板子 UART 口是 CP2102N（VID `10C4` PID `EA60`），驱动装好后为 COM4。
- esptool v5.6.0（`C:\Users\johnny.zong\AppData\Local\Programs\Python\Python313\python.exe -m esptool`）
  `chip-id` / `flash-id` 输出：ESP32-S3 (QFN56) rev v0.2，Embedded PSRAM 8MB (AP_3v3)，40MHz 晶振，
  MAC 74:4d:bd:9d:b5:44，Flash 厂商 c8 设备 4018，16MB，quad，3.3V。
- 启动日志 115200 波特，单一波特率（不像 ESP8266 有 74880 阶段）。打开串口时 DTR/RTS 都不拉，
  然后 RTS 脉冲即可普通复位。
- Windows 上 `python` 会解析到 Microsoft Store 占位（退出码 49），必须用真实 Python 的完整路径。
- 缺驱动时设备状态 Error、`ConfigManagerErrorCode` 28，且不出现在串口列表里。

**Velloc mod 运行时（从已装的 nebius mod 源码反推，没有官方文档）**
- 参考源码：`%USERPROFILE%\.velloc\plugins\cache\velloc\nebius\1.2.1\`（`hooks\sandbox.js`、`hooks\tavily.js`、
  `hooks\setup.js`、`hooks\sandbox\view.js`、`hooks\sandbox\texts.js`、`locales\*.json`）。
- 插件就是 Claude 格式插件（`.claude-plugin/plugin.json`），另加 `hooks/hooks.json`：`{ "modules": ["./xxx.js"] }`。
  模块 `export function register(on)`；`on(event, [filter], async ($, e, next) => ...)`。
- 用到的事件：`session.start`、`command.run`、`ui.render`（filter `{ component: 'Pane' }`，用 `e.requestId` 区分面板）、`ui.close`。
- `$` 上可用：`$.ui.open({id,title,focus})`、`$.ui.resolve(e)`（拿到 `Box/Text/Button/Select` 组件）、
  `$.ui.status(...)`、`$.state.get/set({plugin,key}, value)`（面板视图状态）、`$.store.get/set`、
  `$.command.register({name,description,argumentHint})`、`$.process.run(argv, {timeoutMs})` →
  `{exitCode, stdout}`、`$.clock.every(ms, fn)`、`$.fs.read/exists/write`、`$.env.get`、
  `$.plugin.root/name/locale`、`$.session.id()`。
- 组件属性：`Text({size,weight,color:'green'|'red'|'yellow',dimColor,mono,wrap,children})`、
  `Box({flexDirection,gap,paddingX,alignItems,justifyContent,children})`、`Button({key,label,variant,plain,onPress})`。
- 文字国际化：`locales/en.json`、`locales/zh.json`，nebius 的 `texts.js` 加载器可照抄思路。
- mod 签名为 "Velloc mods ABI 0.2"，接口可能变化。
- Velloc 已启用插件列表：`%USERPROFILE%\.velloc\enabled-plugins.json`；esp8266-bringup 安装在
  `%USERPROFILE%\.velloc\plugins\esp8266-bringup\`（与源码目录 `J:\2_MY_WORK\ESP32\esp8266-bringup\` 内容相同）。

## 5. 方案

### 5.1 目录（与 esp8266-bringup 并排）

```
J:\2_MY_WORK\ESP32\esp32s3-bringup\
  .claude-plugin\plugin.json, marketplace.json
  skills\esp32s3-bringup\SKILL.md      流程、日志解读、S3 板子坑
  commands\bringup.md, log.md          Claude Code / Velloc 里的斜杠命令（给模型用）
  scripts\esp32_bringup.py             硬件操作 CLI（pyserial + esptool）
  hooks\hooks.json, panel.js, view.js  Velloc mod：轮询、面板、状态栏
  locales\en.json, zh.json
  tests\                               脚本纯函数和 view 纯函数的单测
  README.md, LICENSE(MIT)
```

### 5.2 Python 脚本 `esp32_bringup.py`

子命令都支持 `--json`（给 mod 解析）和人类可读输出（给模型/用户），`--port` 默认 `$ESP_PORT`。

- `ports`：列出 USB 串口，**不打开端口**。字段：port、vid、pid、芯片桥类型（CP210x / CH340 / FTDI / Espressif 原生 USB）、序列号。
  另外在 Windows 上报告**缺驱动的 ESP 相关设备**（按 VID 过滤、状态非 OK，带错误码）。
- `probe --port COMx`：调 esptool 读芯片（等价 `chip-id` + `flash-id`），解析出 chip、revision、
  features、PSRAM、crystal、MAC、flash 厂商/型号/大小/类型/电压。会复位板子一次。
  失败时给出分类原因：端口被占用 / 无 bootloader 响应 / 其他。
- `log --port COMx --seconds N`（第二阶段需要，但第一阶段 skill 也会用）：复位并抓 115200 日志，
  同时给出结构化摘要：rst 原因、boot 模式、PSRAM 自检、项目名、IDF 版本、警告/错误行、是否 panic/反复重启。
- 只读：脚本里不得出现 write-flash / erase / efuse / write-mem 等调用。

### 5.3 Velloc mod（第一阶段）

- `session.start`：注册 `/esp32` 命令，启动轮询，设置状态栏。
- 轮询：`$.clock.every(约 2 秒)` 运行 `esp32_bringup.py ports --json`。只比较设备列表，**不碰串口**。
- 状态机（**用户决定：面板从不自动打开串口**；按 USB 序列号记住每块板，记录存 `$.store`）：
  - 插上 → 只凭 USB 信息立即显示"在线"、COM 口、桥接芯片。不碰串口。
  - 认识的板（序列号在记录里）→ 直接显示上次检测到的芯片信息，并标注检测时间，不复位。
  - 新板 → 显示"未检测"和"检测"按钮；用户点按钮才运行 `probe --json`（会复位一次）→ 结果写入记录。
  - "重新检测"按钮随时可点，覆盖记录。
  - 拔掉 → "未连接"（记录保留）。
  - 没有序列号的设备（部分 CH340）只能按端口显示，不使用记录，每次都要手动检测。
  - 缺驱动设备 → 红字"缺驱动（错误码 28）"+ 安装指引（设备管理器 → 更新驱动 → 自动搜索 / Windows 可选更新）。
- 面板内容：标题行"ESP32-S3 · COM4 · ● 在线"（颜色区分）；芯片信息表（型号/版本、核心/频率、Flash、PSRAM、晶振、MAC）；
  "重新检测"按钮；错误/提示区。多块板同时插着时逐块列出。
- 状态栏：一行简短状态，例如 "ESP32-S3 · COM4 · 正常" / "ESP · 未连接"。
- `/esp32` 打开并聚焦面板。插上新板时自动打开面板但不抢键盘焦点（nebius 的做法）。
- Python 路径：按 `$ESP_PYTHON` → 常见安装位置（`%LOCALAPPDATA%\Programs\Python\Python3*\python.exe`）→ `py -3` 顺序查找；
  找不到或缺 pyserial/esptool 时面板显示原因和安装命令，不崩。

### 5.4 "正常"的判定（第一阶段）

probe 成功且：识别出芯片型号、读到 MAC、读到 Flash 大小，即为"正常"。
PSRAM 只报告 esptool 的 features 中写的内容，不做自检（真自检需要跑固件，第一阶段不做）。

### 5.5 第二阶段（串口监视器）只定方向

面板里滚动显示串口输出、"复位并抓启动日志"按钮、日志着色和关键行解读。具体设计等第一阶段跑通、
确认 `$.process.run` 能否流式输出后再定。

## 6. 约束

- Windows 11，PowerShell 5.1；Python 3.13（完整路径见上）；esptool 5.6.0；pyserial 已装。
- mod 运行在 Velloc 的 worker 里：hook 有时间预算，worker 闲置会退出，不要依赖内存状态长期存活
  （视图状态放 `$.state`，需要跨会话的放 `$.store`）。
- 不打开别人占用的串口；probe 遇到端口占用要明确报"被占用"而不是"板子坏了"。

## 6.1 审阅后补充（Claude 的决定，标注为 Claude's call）

- **先做两个验证（spike），再写正式代码**（Claude's call）：
  1. 带 `hooks/hooks.json` 的本地插件能否被 Velloc 加载（esp8266-bringup 没有 hooks，不能证明这一点；
     nebius 是走 marketplace 安装的）。不行则改用本地 marketplace 方式安装。
  2. `$.clock.every` 在面板关闭、会话空闲时是否还会触发；worker 退出后是否会被重新拉起。
- **后台轮询的退路**（Claude's call）：如果空闲时不能轮询，就退为"面板打开时轮询 + `session.start` 时扫一次 +
  `/esp32` 时扫一次"。只列 USB 设备这一步不碰串口，任何时候都安全。
- **状态栏是可选项**（Claude's call）：nebius 只用过 `$.ui.status(undefined)` 清空，设置文字的格式没见过成功用例。
  spike 时顺手试；不行就不做，不影响第一阶段验收。
- **"已检测过"的记录放 `$.store`**，以 USB 序列号为键，跨会话、跨 worker 重启共享（Claude's call）。
  因为面板从不自动检测，多个会话或 worker 重启都不会重复复位板子，所以不需要加锁。
- **原生 USB 口（303A）**：复位时会断开再重连，这属于预期行为。因为不自动检测，不会出现循环复位（Claude's call）。

## 7. 留给实现者的事

- mod 模块拆分、轮询间隔具体值、文案、面板的具体排版。
- 测试方式：Python 部分用 pytest 测解析函数（用今天实测的 esptool 输出和启动日志做样本）；
  view 部分测纯函数输出的组件树；最后在 Velloc 里用真板 COM4 手动验收（插拔、缺驱动场景可通过设备管理器禁用设备模拟）。
- 安装到 Velloc 的具体方式（复制目录到 `~/.velloc/plugins/` 并加入 `enabled-plugins.json`，
  或 Velloc 自带的安装命令）——参照 esp8266-bringup 当时的装法。
