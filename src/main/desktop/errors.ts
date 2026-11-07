const messages: Record<string, string> = {
  DESKTOP_CONTROL_NOTICE_UNAVAILABLE: '桌面控制提示条尚未确认加载并显示，不能开始或恢复控制。请检查 ProfilePilot 窗口后再明确交还控制。',
  DESKTOP_USER_IN_CONTROL: '桌面控制已暂停或控制权已变化。请用 desktop status 检查原因；获准继续并明确交还控制后，重新观察再操作。',
  DESKTOP_SESSION_ENDED: '当前桌面会话已结束或不再有效。请检查 desktop status；新任务应使用新的会话名。',
  DESKTOP_BUSY: '上一次桌面操作尚未结束，请先检查状态和已有回执。',
  DESKTOP_WINDOW_CHANGED: '目标窗口已变化，请重新读取 desktop windows 并确认目标。',
  DESKTOP_INPUT_OBSERVER_UNAVAILABLE: '输入观察器尚未就绪，不能开始或恢复桌面控制。请检查 ProfilePilot 的输入观察组件。',
  DESKTOP_INPUT_OBSERVER_INSTANCE_BUSY: '另一个 ProfilePilot 输入观察组件已占用当前 Windows 会话的观察锁。请核查其他 App 实例，确认原组件退出后再明确恢复控制。',
  DESKTOP_INPUT_OBSERVER_ACCESS_UNAVAILABLE: '无法访问当前 Windows 会话的输入观察锁。请核查 ProfilePilot 实例的权限与锁访问条件；本次未启用桌面控制。',
  DESKTOP_INPUT_OBSERVER_STARTUP_UNAVAILABLE: '无法建立当前 Windows 会话的输入观察锁。请检查错误详情中的 Windows 错误码；本次未启用桌面控制。',
  DESKTOP_INPUT_OBSERVER_PENDING: '正在确认输入观察器；本次未发送输入，请等待状态就绪后重新观察。',
  DESKTOP_FRESH_OBSERVATION_REQUIRED: '旧观察已不能用于继续操作，请先重新观察或截图。',
  DESKTOP_CONTROL_OCCUPIED: '这个窗口对应的浏览器或 Electron 应用已有控制会话，桌面操作已阻止。请先核查原入口的控制权；用户接管仍算占用。',
  DESKTOP_CONTROL_STATE_UNKNOWN: '无法确认这个窗口在其他控制入口的占用状态，桌面操作已阻止。请核查浏览器和 Electron 连接状态后再尝试。',
  DESKTOP_FOCUS_REQUIRED: 'Windows 未确认目标窗口的前台状态，尚未发送本次键盘或鼠标输入。请先激活目标窗口，再重新观察。',
  DESKTOP_WINDOW_OCCLUDED: '目标位置被其他窗口遮挡，尚未发送本次点击。请检查窗口位置并重新截图。',
  DESKTOP_OBSERVATION_STALE: '观察版本已失效，请重新观察目标窗口后再操作。',
  DESKTOP_ELEMENT_CHANGED: '这个控件的内容、状态或位置已变化，请重新观察后确认操作。',
  DESKTOP_ELEMENT_UNAVAILABLE: '控件不可操作或其状态无法读取，请检查 enabled、offscreen 和 stateGaps 后重新观察。',
  DESKTOP_INPUT_CONFLICT: '检测到已有按键、鼠标捕获或窗口拖动，尚未发送本次输入。请等待用户结束操作后重新观察。',
  DESKTOP_INPUT_STATE_UNKNOWN: '无法确认当前按键或鼠标捕获条件，尚未发送本次输入。请用 desktop doctor 检查诊断，不要强行继续。',
  DESKTOP_INPUT_STATE_CHANGED: '输入条件已发生变化，请核查窗口和控制状态。',
  DESKTOP_DPI_UNAVAILABLE: '无法建立物理像素坐标环境，已阻止鼠标输入。请检查 Windows 版本和桌面驱动。',
  DESKTOP_DISPLAY_UNSUPPORTED: '目标点不在受支持的显示器区域内，请检查显示器布局并重新截图。',
  DESKTOP_DISPLAY_CHANGED: '显示器范围已变化，请重新截图确认目标位置。',
  DESKTOP_POINTER_CHANGED: '未能确认鼠标停留在目标位置，已停止后续输入。请检查控制状态和窗口结果。',
  DESKTOP_OUTCOME_UNKNOWN: '操作可能已部分生效，控制已暂停。请先核查窗口结果和回执，不要重复输入。',
  DESKTOP_READ_INTERRUPTED: '只读请求中断，这次请求没有发送输入。请检查控制状态后重新观察；新驱动仍须等待旧驱动退出。',
  DESKTOP_RESPONSE_TOO_LARGE: '画面和控件信息超过传输上限。请用 screenshot --image-only，或单独 observe 读取控件。',
  DESKTOP_RESPONSE_SERIALIZATION_FAILED: '无法编码这次读取结果，请检查窗口状态或改用单独的截图与控件读取。',
  DESKTOP_DESKTOP_LOCKED: '当前桌面不可交互，控制已暂停。请等待用户解锁并明确交还控制。',
  DESKTOP_DRIVER_STOP_UNCONFIRMED: '尚未确认旧桌面驱动退出，已阻止新的操作。请检查控制状态。',
  DESKTOP_KEY_UNSUPPORTED: '这个按键名称不受支持，尚未发送输入。请查看 desktop --help。',
  DESKTOP_ACTION_UNSUPPORTED: '控件不支持所请求的操作，请使用最新观察列出的 actions。'
};

export const desktopErrorMessage = (code: string): string => messages[code] || code;

const pauseMessages: Record<string, string> = {
  user_takeover: '控制已交还给你。需要继续时，可以交还控制。',
  physical_input: '检测到键盘或鼠标操作，控制已暂停。需要继续时，可以交还控制。',
  external_input: '检测到来源未确认的模拟输入，控制已暂停。请先检查窗口状态。',
  control_occupied: '浏览器或 Electron 入口已占用这个窗口，请先检查原控制会话。',
  control_state_unknown: '无法确认其他入口的占用状态，请先检查浏览器和 Electron 连接。',
  outcome_unknown: '操作可能已部分生效。请先核查窗口结果，不要重复输入。',
  desktop_locked: '当前桌面不可交互。解锁后，再决定是否交还控制。',
  driver_stop_unconfirmed: '旧桌面驱动尚未确认退出，请先检查组件状态。',
  notice_unavailable: '桌面控制提示条不可用，控制已暂停。请检查应用状态。',
  instance_in_use: '另一个输入观察组件正在运行，确认它退出后再交还控制。',
  instance_access_denied: '无法访问输入观察锁，请检查其他实例和权限状态。',
  instance_gate_failed: '输入观察组件未能启动，请查看命令返回的错误详情。',
  helper_exited: '输入观察组件已退出，请检查组件后再交还控制。',
  disconnected: '输入观察连接中断，请检查组件后再交还控制。'
};
export const desktopPauseMessage = (reason?: string): string => pauseMessages[reason || '']
  || '无法继续确认输入观察状态。请检查组件和窗口后再交还控制。';
