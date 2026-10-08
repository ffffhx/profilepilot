# Chrome Web Store 发布材料

状态：代码与打包准备；未上传、未审核、未发布。账号、真实 item/公钥、隐私公开 URL、商店截图及发布决定仍需发布者完成。

## 打包与身份

```sh
node scripts/prepare-native-extension-icons.mjs
node scripts/package-native-extension.mjs --check
node scripts/package-native-extension.mjs --out artifacts/native-extension-release
```

校验 MV3/版本、manifest 资源、HTML 引用、JS 语法、文件名大小写、16/32/48/128 PNG 和 key/后端 ID 一致性。ZIP 固定时间戳、可重现，manifest 位于根目录；输出 SHA256 和 validation.json。工具不读取账号、不上传、不签名，published 始终 false。

当前开发 ID 为 gmdaabnoocjlpimglalnbegfdaklfnaj。不能假定现有 key 能指定商店 ID；官方流程是先建草稿 item，取 Dashboard 公钥，加入开发 manifest 并对齐应用固定 ID，再核对二者。[官方 key 流程](https://developer.chrome.com/docs/extensions/reference/manifest/key)

取得真实 item ID 后可用 `--store-id <ID>` 检查一致性；仅是发布者声明，不是远程归属验证。ID 不同须协调 manifest、NATIVE_EXTENSION_ID、安装测试和配对迁移，重新构建应用与扩展，不能只改链接。发布后配置 PROFILEPILOT_EXTENSION_STORE_URL 为真实官方 `/detail/<可选名称>/<ID>` 地址，不能含查询参数。

## 商店文案

名称：ProfilePilot 浏览器连接。

简短说明：连接当前 Chrome Profile，操作现有或新建页面，提供侧边任务、调试、历史和下载。

单一用途：作为本机 ProfilePilot 桌面应用与当前 Chrome Profile 的任务连接，帮助用户通过本机代理工具观察操作网页、获取任务上下文与处理结果。

详细说明：安装扩展并连接本机 ProfilePilot 后，可从当前网页或侧边栏发起任务，沿用已有登录状态。支持页面读取、截图、表单交互、调试、按请求检索历史及处理下载。默认完整访问，支持站点限制和随时停止/接管。需要安装并运行桌面应用，模型服务由用户配置。不能绕过 Chrome 内部页或系统对话框限制。

## 权限理由

| 权限 | 用途 |
| --- | --- |
| debugger | 官方调试传输用于观察、截图、输入、网络/控制台/性能和 frame 操作。 |
| tabs | 选择当前 Profile 的现有普通页和任务页。 |
| storage | 本机配对、站点偏好和连接恢复。 |
| alarms | MV3 worker 挂起后恢复本机连接。 |
| history | 按用户请求搜索当前 Profile 浏览记录。 |
| downloads | 跟踪任务下载、完成确认与本地后续处理。 |
| sidePanel | 当前页任务与消息侧边入口。 |
| contextMenus | 选中文字和当前页的任务入口。 |
| scripting | 安装/启动时恢复合法本机邀请页入口。 |
| http/https 全站 | 用户指定网页、跨域上下文与任务下载；对应默认完整访问。 |

management.getSelf 仅识别自身安装类型，不请求 management 权限。扩展不下载并执行远程模块；模型输出由应用转换成操作。发布者须按最终代码回答商店远程代码与数据使用问题，不能机械勾选“不处理数据”。

## 审核材料

- 将[隐私说明](native-extension-privacy.md)部署到真实 HTTPS URL，按实际情况披露页面、历史、截图、用户输入和调试内容。
- 已备 PNG 图标。商店截图需使用最终运行版本和虚构测试页面，展示首次连接、侧边任务、停止/接管和可选范围；检查尺寸并去除令牌、个人资料。测试 pairing 截图不自动等于合格商店截图。
- 审核步骤：运行桌面应用 → 选择测试 Profile → 安装扩展 → 首次连接 → 测试网页任务 → 停止/交还 → 自建历史/下载 → 应用及 Chrome 重启重连。无需发布者私人账号数据。
- Public、Unlisted、Private 都须审核，不能用私有分发回避披露。[官方发布流程](https://developer.chrome.com/docs/webstore/publish/)
- 发布前提升 manifest version，运行回归与真实生命周期脚本，记录 ZIP 哈希及 OS/Chrome 版本。本任务不上传、发布或触发工作流。
