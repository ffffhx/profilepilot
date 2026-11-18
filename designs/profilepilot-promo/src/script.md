# ProfilePilot · 15 秒风格样片

1920 × 1080，30 fps，中文字幕、原创器乐节奏，无旁白。

观点：多个 Agent 使用不同 Profile／应用，各自处理任务；同一目标被占用时停止并提示。
观众：已有编程 Agent 的开发者。明亮的任务工作台，任务从入口分流到独立轨道，峰值在 4–11 秒。每个机制画面标记“功能示意”；不是性能测试或任务完成实录。

## hook · 0–4 秒
完整标题第一帧可读，三条路径逐渐分开。并行范围来自 docs/promotion-plan.md“多 Agent 分别管理自己的目标”，已由产品持有者确认。

## parallel · 4–11 秒
资料 Profile、测试 Profile、独立 Electron 应用分别接收 Agent 的任务。依据：src/main/native-control/service.ts、src/main/browser-gateway-control.ts、tests/native-control-lifecycle.test.js，及推广方案中已核对的范围。同一 Profile 一个控制会话；不展示同 Profile 多标签同时控制、共享鼠标并发或同手机并发。进度粒子只表示流程，没有定量时间或速度含义。

## end · 11–15 秒
真实 Logo、短邀请与仓库入口 github.com/ffffhx/profilepilot。以仓库最新安装说明为准，不声称扩展已上架。

## SOURCES 与素材
Logo：public/assets/profilepilot-icon-512.png，原样使用。
颜色：public/design-system.css 的白底、深蓝、品牌蓝与绿色。
中文字体：设备系统字体；不依赖在线字体。
任务轨道与控制标记：解释机制的原创图示，不冒充产品界面。仓库旧截图不用于此样片。
