# esp32s3-bringup 第二阶段设计：串口监视器 + 烧录

日期：2026-10-28　作者：Johnny Zong（与 Claude 讨论整理）
前置：第一阶段已交付并验收（`docs/design.md`、`docs/plans/2026-10-28-phase1.md`、`docs/spike-notes.md`）。

## 1. 目的

用户要在 Velloc 面板里**实时看板子的状态和运行 log**：程序是否正常运行、Wi-Fi 状态。
开发者（以及以后用 Arduino 开发的用户）要能在不关监视器的情况下烧录固件。

## 2. 目标 / 非目标 / 反目标

**目标**
- 面板内串口监视器：实时滚动 log + 顶部状态摘要（运行状态、重启次数、运行时长、Wi-Fi）。
- 确认是 ESP 的板子插上后**自动开始监视**（用户决定："最好自动打开"）。
- 用本插件烧录合并好的单个 `.bin`（从 0x0 写入）；烧录时监视器自动让出串口，烧完自动恢复并显示新固件启动日志。
- 第一阶段的"检测"在监视器开着时自动暂停/恢复监视。

**非目标**
- 不支持多文件烧录（bootloader/分区表/app 分开的 `flasher_args.json`）——用户选了"合成"。
- 不支持外部工具（终端 idf.py、VS Code ESP-IDF、Arduino IDE）烧录时自动让出串口：这些程序本插件看不见。只提供面板"暂停"按钮和占用提示。
- 不做向板子发送数据（串口输入）、不做 log 搜索/过滤 UI。
- 不改 eFuse、不加密、不做 OTA。

**反目标**
- 自动开始监视时复位了板子（打开串口必须先把 DTR/RTS 设为 False）。
- 自动占用了不是 ESP 的串口设备。
- 烧录选错文件把板子刷成砖：烧录前必须校验镜像。
- 监视器进程变成孤儿一直占着串口，导致检测/烧录/外部工具永远"端口被占用"。
- 面板卡顿：log 刷新不得阻塞 Velloc。

## 3. 用户确认的决定

- 只要实时显示板子状态和运行 log。
- 监视器开着时会烧录 → 先用本插件的 py 烧录，烧录时自动让出串口。
- 固件格式：合并好的单个 `.bin`（Arduino `xxx.ino.merged.bin`、`idf.py merge-bin` 产物）。
- 插上自动开始监视。
- **AI 可以烧录，但必须先问用户**：skill 里写成"核对文件、端口、大小，征得用户同意后才执行"；
  脚本 `flash` 没有 `--yes` 就拒绝执行（只打印将要做什么）。第一阶段 SKILL/README/commands 里
  "不得写 Flash"的说法改为"除 `flash` 外全部只读，`flash` 需用户同意"。
- **只支持 Windows**，与第一阶段一致。

## 4. 已知事实与限制

- Velloc `$.process.run(argv, {timeoutMs})` 等进程结束才返回 `{exitCode, stdout}`，没有流式输出 →
  监视必须是一个**独立的后台进程**，面板轮询它的输出。
- `$.clock.every` 在会话空闲时持续触发（spike：65 分钟不断）。Velloc 不热加载 mod，改代码要重启。
- 未知（需 spike 验证，见 6.1）：`$.process.run` 返回或超时后，它启动的分离子进程能否存活；
  `$.fs.read` 能否读插件目录以外的文件。
- 当前板子：CP2102N（COM4），115200 波特，启动日志单一波特率。ESP-IDF 日志格式 `I/W/E (ms) tag: msg`。
- esptool 5.6.0 已装：`esptool --port COMx --baud 460800 write-flash 0x0 file.bin`（5.x 用短横线命令名）。
  合并镜像第一个字节是 0xE9（ESP 镜像魔数）。

## 5. 方案

### 5.1 后台监视进程 `esp32_bringup.py monitor ...`

- `monitor start --port COMx [--baud 115200]`：启动一个**分离**的后台进程（Windows：`DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`，用 `pythonw.exe` 或 `CREATE_NO_WINDOW` 避免弹窗），立即返回 JSON（pid、port、log 文件路径）。同一端口已有监视进程则直接返回它的信息。
- 后台进程：先设 `dtr=False, rts=False` 再打开串口；持续读，按行写入 log 文件（每行加主机时间戳）；
  维护一个**状态文件**（JSON）：`{pid, port, baud, state: running|paused|stopped|error, error, log, startedAt, lines}`。
- 控制：通过**控制文件**（请求 pause/resume/stop），后台进程每 ~200 ms 检查一次。
  - `pause`：关闭串口，状态改为 paused（释放端口）；`resume`：重新打开。
  - `monitor pause/resume/stop --port COMx`：写控制文件，**等待**状态文件确认（最多 3 秒），然后返回。
  - 串口掉了（拔线、原生 USB 复位重新枚举）：状态 `waiting`，每秒尝试重开，同一端口重新出现就继续。
- `monitor status --port COMx --json`：读状态文件 + log 末尾 N 行 + 实时摘要（见 5.3）。
- `monitor list --json`：列出所有监视进程（用于启动时接管已有进程、清理孤儿）。
- 孤儿防护：后台进程每隔几秒检查一个"心跳"文件（面板每次轮询都更新）；超过 N 分钟没有心跳就自行退出
  （N 留给实现者，建议 10 分钟），保证 Velloc 退出后不会长期占用端口。
- 数据目录：`%LOCALAPPDATA%\esp32s3-bringup\`：`monitors\<port>.json`（状态）、`monitors\<port>.ctl`（控制）、
  `logs\<序列号或端口>\YYYYMMDD-HHMMSS.log`。单个 log 文件超过一定大小轮转，总量有上限（具体值留给实现者）。

### 5.2 烧录 `esp32_bringup.py flash --port COMx FILE.bin`

- 校验：文件存在、第一个字节 `0xE9`、大小不超过 probe 记录的 Flash 大小（有记录时）；不通过就拒绝，返回 reason。
- 有监视进程 → `pause` 并等确认；然后 `esptool --port COMx --baud 460800 write-flash 0x0 FILE`（esptool 默认会校验写入），
  之后硬复位；最后 `resume`（若之前在监视）。无论成功失败都要 resume。
- 输出 JSON：`{ok, port, file, bytes, seconds, reason?, detail?}`；失败分类沿用 `busy / no_response / error`，加 `bad_image`。
- 这是插件里**唯一写 Flash 的路径**。SKILL.md 和 README 写清楚；脚本里其他命令保持只读。
- 面板按钮"烧录…"：让用户输入/粘贴 `.bin` 路径（Velloc 组件里没见过文件选择器，见 6.1），显示文件名和大小，
  **二次确认**后执行，执行中显示进度状态，结束显示结果。

### 5.3 状态摘要（从 log 实时推出）

- 运行状态：`正常运行` / `刚重启（原因）` / `崩溃`（Guru Meditation、abort、`rst:` 为看门狗或 panic 类）。
- 重启次数（本次监视期间 `ESP-ROM:` 次数）、最近一次复位原因、本次运行时长（最后一次启动横幅到现在）。
- Wi-Fi：ESP-IDF 标准日志 —— `wifi:connected with <ssid>`、`sta ip: x.x.x.x` / `got ip:x.x.x.x`、
  `wifi:disconnected ... reason:N`（附 reason 含义）；通用 `RSSI[:= ]\s*(-?\d+)`（原样显示；正数在 SKILL 里说明不是真实 RSSI）。
  Arduino 默认不打印 Wi-Fi 日志，识别不到时显示"未知"。
- 计数：本次监视的错误行、警告行数。
- 摘要解析是纯函数，复用并扩展第一阶段 `summarize_boot`。

### 5.4 自动开始的规则（用户决定 + Claude 的收窄）

- 用户决定：插上自动开始监视。
- Claude's call：只对**确认是 ESP** 的端口自动开始 —— 有检测记录的板子（第一阶段 `$.store` 里的 `boards`）
  或 VID `303A`（ESP 原生 USB）。其他 CP210x/CH340/FTDI 设备显示"开始监视"按钮，不自动占用。
- Claude's call：用户手动"停止"后，这个端口在拔掉之前不再自动开始。
- 检测（probe）、烧录都会先暂停监视再恢复；检测成功后的新板也随即自动开始监视。

### 5.5 面板

在第一阶段每块板的卡片下面加监视区：
- 摘要行（5.3）+ 按钮：开始/停止、暂停/继续、复位并看启动日志（RTS 脉冲，复位前暂停、复位后恢复）、清屏、烧录…、打开 log 文件夹（若 Velloc 支持，否则显示路径）。
- 滚动日志：最近 ~200 行，`E (` 红、`W (` 黄、Wi-Fi 行高亮，`Guru Meditation` 等整行红色加粗。
- 刷新：监视中的板子每 1 秒取一次状态（`monitor status`），面板关着时降到每 5 秒（只为更新摘要和心跳）。

## 6. 约束与风险

- 所有路径同第一阶段（Python 完整路径、Node 22、`unittest`、`node --test "tests/*.test.js"`）。
- 每秒启动一次 Python 读状态有开销；若 6.1 证明 `$.fs.read` 能直接读数据目录里的状态和 log 文件，就改用直接读文件。

### 6.1 先做的 spike

1. 用 `$.process.run` 启动分离的后台 Python 进程，`run` 返回后它是否还活着、是否弹出控制台窗口；`timeoutMs` 到期时是否会被杀。
2. `$.fs.read` 能否读 `%LOCALAPPDATA%\esp32s3-bringup\` 下的文件。
3. Velloc 面板组件有没有文本输入框（输入 bin 路径）或文件选择器；有没有"打开文件夹"一类的能力。
4. Velloc 关闭后后台进程的去留（验证心跳自退）。

结论写进 `docs/spike-notes.md` 第二节。spike 1 若失败（子进程随 run 一起被杀），停下来和用户重新讨论方案。

## 6.2 审阅后补充（Claude's call）

- **暂停/恢复放在脚本层**：`probe`、`log`、`flash` 自己检查同端口的监视进程，先 pause 等确认、做完再 resume。
  面板和模型（skill / `/bringup` / `/log`）因此都能在监视开着时正常工作。
- **烧录作为分离的后台任务并显示真实百分比**：16MB 的 merged.bin 在 460800 波特要几分钟，远超 `process.run`
  可靠的阻塞时长；所以 `flash` 启动分离任务，解析 esptool 的 `(NN %)` 进度写入状态文件，面板轮询显示百分比。
  复用监视进程的状态文件/孤儿防护机制。spike 增加一项：`timeoutMs` 到期时子进程是否被杀。
- **启动横幅不丢**：复位由监视进程自己做（RTS 脉冲后立刻读），烧录用 `--after no-reset`，再由监视进程复位。
- **端口被占用时不抢**：监视进程只在端口**消失后重新出现**时自动重开；端口存在但被别的程序占用时进入
  `busy` 状态并停止重试，面板显示"被其他程序占用"和"重试"按钮，避免在 `idf.py flash monitor` /
  Arduino IDE 上传的间隙里抢走端口。
- **路径输入**：nebius 已在用 `Input({value, placeholder, onInput, onSubmit})`，烧录用文本框输入 `.bin` 路径；
  `Link({href,label})` 能否打开本地文件夹留给 spike。

## 7. 留给实现者

文件拆分（建议监视进程逻辑单独成 `scripts/monitor.py` 或保留在同一脚本内由实现者定）、轮询间隔细节、
log 轮转阈值、心跳超时、文案、Wi-Fi reason 码表的范围、测试方式（解析与状态机用 unittest/node:test；
后台进程用一个虚拟串口或可注入的读取源测试，真板验收：自动开始、烧录 Arduino merged.bin 和当前固件的回烧）。
