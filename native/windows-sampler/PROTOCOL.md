# Windows sampler v1

这是独立、只读、短生命周期的 Windows 严格准入采样器。没有 UIA、窗口控制、输入、hook、常驻进程或自动提权。普通列表仍使用原有 Windows 采样与缓存；macOS 路径不变。Windows 构建与安装资源包含 `ProfilePilot.WindowsSampler.exe`。

`node scripts/build-windows-sampler.mjs --check` 仅在独立临时目录编译，stdout 返回一条构建 JSON，包含 `executable`、`output`、源码/编译器/产物 SHA-256。默认无参数行为相同；没有 `--run`。原生 OS 验证必须由独立验收入口显式启动。

`--production` 编译到 `dist/native`；缓存同时核对源代码、编译器、Framework 引用及实际 EXE 内容摘要。非 Windows 平台直接跳过，不下载 SDK。构建身份包含该 EXE 和桌面协议资源，运行时副本校验内容；这不等于运行中防篡改或代码签名验证。

## 请求和回复

子进程不接受命令行参数。父进程向 stdin 写入一个 UTF-8 JSON 文档，然后关闭 stdin。允许无末尾换行或一个 LF/CRLF；不接受 BOM、第二行、重复键（包括转义后的同名键）、非法 UTF-8 或不配对的代理项。

```json
{"version":1,"requestId":"1cec77a4-1582-4ab7-a1d8-c972c6cda96b","operation":"snapshot","params":{}}
```

```json
{"version":1,"requestId":"1cec77a4-1582-4ab7-a1d8-c972c6cda96b","operation":"fileLocks","params":{"paths":["C:\\OwnedFixture\\file.txt"]}}
```

所有字段严格按操作校验，无额外字段。requestId 为非零、规范小写 UUID。paths 只接受唯一、绝对 Windows 路径，不读取配置或补充其他路径；空数组合法。

成功回复恰一个 JSON 行，以 LF 结束，exit code 为 0：

```json
{"version":1,"requestId":"...","operation":"snapshot","ok":true,"result":{"processes":[],"complete":true,"timings":{"totalMs":1,"enumerateMs":0,"pinMs":0,"cimMs":1}}}
```

上例仅说明 envelope；真实 snapshot 若没有可用的非零 PID 行，会失败。已知失败为 exit code 2：

```json
{"version":1,"requestId":"...","operation":"fileLocks","ok":false,"error":{"code":"WINDOWS_SAMPLER_RM_LIST_FAILED","stage":"rm_list","win32Error":5}}
```

请求无法识别时，`requestId` / `operation` 可为 null。错误不包含异常原文、命令行、进程名或路径。可选错误字段仅为 `pid`、`win32Error`、`cleanupFailed:true`、`cleanupWin32Error`。清理失败保留先前错误；无先前错误时返回 `WINDOWS_SAMPLER_CLEANUP_FAILED`。stderr 不用于传递协议。

限制：请求（含末尾换行）最多 256 KiB；回复（含 LF）最多 32 MiB；PID 枚举/CIM 行和 fileLocks **总输出行**分别最多 16,384；每个 RM list 最多 16,384；paths 最多 256；命令行/路径最多 32,768 个 UTF-16 单元；名称最多 512。超限返回失败，不能截断后声称 complete。序列化失败也只返回小型错误回复。

## snapshot

每行包含：

- `pid`、`parentPid`：UInt32，目标 pid 非零且唯一。
- `name`、`executablePath`（可 null）、`commandLine`、`commandLineAvailable`、`startedAt`（可 null）。startedAt 是 CIM 的展示时间，**不作为身份**。无命令行时只保留 image/name 展示 fallback，availability 为 false。
- `creationFileTime`：规范正十进制 UInt64 字符串，或 null；禁止通过 Number/Date/CIM 时间恢复。
- `identityStatus`：`confirmed` / `unavailable`。
- unavailable 时有 `identityReason`：`not_pinned`、`open_failed`、`birth_failed`、`exited`、`wait_failed`；可有 `identityWin32Error`。confirmed 不包含这两个字段。

顺序为原生枚举 PID → 对所有可读 PID 打开 `QUERY_LIMITED_INFORMATION | SYNCHRONIZE` 句柄并读取 GetProcessTimes 原始 FILETIME → 保持句柄进行完整 CIM 查询 → 检查原句柄存活 → finally 关闭所有句柄。CIM 新出现的 PID 为 not_pinned；读取失败不尝试在 CIM 后重新打开 PID 或借用 CIM 时间。图片路径缺失时仅允许读取同一个已固定句柄。

complete 表示 CIM 枚举行的收集完整；不表示每行身份都可读，也不表示整个 OS 原子快照。无关 System/受保护进程不可读会保留 unavailable 行，不能被误报为进程不存在。消费者对实际需要的文件/祖先关联另行严格拒绝 unavailable 身份。helper 不执行该产品映射。

原生 snapshot 仅返回进程行。TCP 继续由 Node 侧并行读取 IPv4 和 IPv6；两个地址族须分别证明完整，不能用单栈空结果证明端口无人监听。

## fileLocks

result 为 `{rows:[{path,pid,creationFileTime}],complete:true,timings:{totalMs}}`。path 精确回显输入；某路径无人占用时没有该路径的行。只有全部输入路径都查询成功且 RM 会话已清理，才返回 complete。

每个路径使用单独 RM 会话；ERROR_MORE_DATA 仅在该会话内最多读取 4 次，每次丢弃部分结果。同一 PID + 相同 birth 在单个文件中去重；同 PID + 不同 birth（包括跨文件）返回 `WINDOWS_SAMPLER_IDENTITY_CONFLICT`，不能压成 PID。创建身份保留 RM_UNIQUE_PROCESS.ProcessStartTime 的原始 FILETIME。

## 失败阶段和生命周期

阶段枚举：`protocol`、`process_enumeration`、`process_pin`、`process_cim`、`process_identity`、`process_close`、`rm_start`、`rm_register`、`rm_list`、`rm_end`、`serialize`。

错误 code 统一使用 `WINDOWS_SAMPLER_*` 命名，与生产 `windows_rm_pid_join` 重试分类独立。循环有固定 8 秒合作预算，CIM 枚举也配置剩余等待预算；**同步 provider / Win32 调用不保证硬超时**。父客户端执行原始绝对截止时间（含排队），终止后仅实际 `close` 释放采样屏障，不可把取消请求或 kill 返回当作退出证明。客户端和 helper 不自动重试；外层发现流程原有的单次整轮重采仅适用于缺失 PID，不适用于创建身份或祖先错配。

`Main` 的第一步启动独立后台线程，以单调时钟设置 10 秒自终止阈值，覆盖 stdin 读取、provider 调用和 stdout 写入；正常结束取消该线程。到期仅以 `GetCurrentProcess()` 的自身伪句柄调用 `TerminateProcess(..., 2)`，不接受外部 PID/句柄，不争抢第二个协议帧。自终止成功不会返回；异常返回时只回退到失败的 `Environment.Exit(2)`。这层兜底避免依赖可能持锁的 provider 执行 DLL detach，依据 [ExitProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-exitprocess) 与 [TerminateProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess) 的官方契约；没有声称已复现 CLR 退出死锁。

10 秒从进入 `Main` 计时，CLR 启动、OS 调度、进程挂起和待完成/取消 I/O 均可能延后实际退出，不是 spawn 到 close 的实时硬上限；强制退出不保证 provider finally 已运行。没有即时 parent-watch：父进程退出不会刷新 helper 的原截止时间。正常 `Dispose` 之后的 CLR 退出阶段不在此 watchdog 覆盖范围内。父客户端仍须等待实际 `close`，不能把触发自终止当成退出证明。

严格 RM 请求按 256 路径及 256 KiB 双限额分批，整轮共享原 context/deadline，全部批次最多 4096 个唯一路径、16384 行。跨批同 PID/不同 FILETIME 拒绝；每个 RM 身份与原 process snapshot 的 confirmed raw FILETIME 精确匹配，不把 CIM 的微秒/JS 毫秒显示时间补成精确身份。祖先提升要求同快照可确认且父出生不晚于子；未知关联失败关闭。context 不进入公开 discovery 或 lastKnown。

原协议/身份纯测试仅编译 `model.cs`、`protocol.cs` 和假 provider：`node --test tests/windows-sampler-prototype.test.js`，不链接 `windows.cs`、`program.cs` 或 System.Management。生命周期纯测试为 `tests/windows-sampler-watchdog.test.js`；`node scripts/verify-windows-sampler-watchdog.mjs --check` 只编译，显式 `--run` 才验证自有 stdin 阻塞、模拟 provider 阻塞及正常取消超过原期限。这不是实际 WMI 卡死或父进程死亡验收。

依据：微软 [RM_UNIQUE_PROCESS](https://learn.microsoft.com/en-us/windows/win32/api/restartmanager/ns-restartmanager-rm_unique_process) 明确 birth 来自 GetProcessTimes；[进程对象与 PID 复用](https://devblogs.microsoft.com/oldnewthing/20110107-00/?p=11803/) 说明持有句柄期间对象/PID 仍存在。初版 Medium 独立采样证据为 `.tools/desktop-verification/pp-windows-sampler-uGYc1o/report.json`；该结果不代表后续 watchdog 或整个 App 的端到端验收。
