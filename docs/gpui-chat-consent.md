# 聊天交还 GPUI 控制

用户在当前聊天明确说“交还控制，继续调试”后，Agent 可以直接调用 ProfilePilot CLI 的正式管理接口，无需再要求用户切回应用点击交还。

1. 读取 `ppilot gpui status --json`，确认原目标、会话及暂停原因，取得该会话的 `pauseId`。
2. 执行 `ppilot gpui return-control --session TASK --pause-id UUID`。
3. 检查返回状态；只有恢复为 active 且 inputGuard 为 active 后，才重新 snapshot 并继续操作。

授权由调用方依据当前对话负责确认，和用户授权后的其他 CLI 管理操作一样。pauseId 是本次暂停的版本标识，不是授权凭证；不需要公钥、签名服务或 Codex 专用接口。此接口复用已有的目标检查、占用检查、输入观察器及活动状态准备流程。

每次接管、暂停和服务重启都会生成新 pauseId；恢复开始时旧 ID 即失效。旧 ID、跨会话 ID、重复/并发兑换返回 GPUI_STALE_CONTROL。暂停前的请求未结束时返回 GPUI_BUSY，必须核查在途结果。恢复失败仍保持暂停，不能盲目重试。

用户再次接管后，必须再次明确交还。不得自动刷新 pauseId 循环恢复，也不得把过去的一次许可当作以后所有接管的许可。原 `resume` 命令保留“检查已经恢复”的行为；`complete/release` 仍不直接释放暂停会话。

Windows 和 macOS 使用相同 CLI 参数和服务逻辑，恢复后分别沿用各自的输入观察器。Windows 可运行 `node scripts/e2e/run-gpui-embedded-preview.mjs --consent` 验证隔离目标的恢复、重复请求拒绝及再次接管；该验收不操作用户已有会话。macOS 未经过真机验收。
