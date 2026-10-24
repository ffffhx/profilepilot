# Chrome Web Store 发布材料

状态：发布材料准备中；本文件不代表已上传、已审核或已发布。以开发者后台的实际状态为准。正式 item ID、公钥、公开隐私页和最终运行截图仍须核对。

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

单一用途：将用户选择的 Chrome Profile 连接到本机 ProfilePilot 浏览器服务，让用户授权的 Agent 读取和操作网页，并让用户查看连接状态、暂停或接管浏览器任务。

详细说明：

ProfilePilot 浏览器连接将你当前的 Chrome Profile 连接到电脑上的 ProfilePilot 浏览器服务，让你授权的 Agent 沿用已有页面和登录状态完成网页任务。

- 读取网页内容、获取截图、填写表单和操作页面。
- 按请求查询浏览历史、处理任务下载和获取网页调试信息。
- 在扩展弹窗或侧边栏查看连接状态和受控标签页，通过任务标签组识别任务状态。
- 通过 ProfilePilot 暂停、停止或接管任务；支持站点范围限制。

使用前需要安装 ProfilePilot CLI 或桌面应用，并将扩展与同一台电脑上的浏览器服务配对。CLI 会自动启动独立浏览器服务，外部 Agent 使用 CLI 时不要求桌面窗口一直打开。使用桌面内置 AI 任务时，需要配置模型服务。

扩展通过本机回环地址连接浏览器服务。任务所需的页面内容、截图和结果可能经桌面应用或外部 Agent 发送到用户选用的模型服务；具体数据使用见隐私说明。扩展不能绕过 Chrome 内部页面、浏览器安全页面和系统对话框的限制。

项目与安装说明：https://github.com/ffffhx/profilepilot

支持与问题反馈：https://github.com/ffffhx/profilepilot/issues

## 权限理由

| 权限 | 用途 |
| --- | --- |
| debugger | 官方调试传输用于观察、截图、输入、网络/控制台/性能和 frame 操作。 |
| tabs | 选择当前 Profile 的现有普通页和任务页。 |
| tabGroups | 将任务使用的标签页分组，并用组名与颜色显示运行、暂停、等待或完成状态。 |
| storage | 本机配对、站点偏好和连接恢复。 |
| alarms | MV3 worker 挂起后恢复本机连接。 |
| history | 按用户请求搜索当前 Profile 浏览记录。 |
| downloads | 跟踪任务下载、完成确认与本地后续处理。 |
| sidePanel | 在浏览器侧边栏显示连接状态、当前受控标签页和配对入口。 |
| contextMenus | 选中文字和当前页的任务入口。 |
| scripting | 安装/启动时恢复合法本机邀请页入口；在已授权的任务页面临时移开阻断调试的其他扩展 iframe，交还控制后恢复。 |
| http/https 全站 | 用户指定网页、跨域上下文与任务下载；对应默认完整访问。 |

management.getSelf 仅识别自身安装类型，不请求 management 权限。

远程代码说明草稿：扩展的 service worker、弹窗与侧边栏脚本随 ZIP 打包，不从 CDN 下载扩展脚本。扩展接收已配对的本机浏览器服务发送的浏览器任务命令，并可通过 chrome.debugger 的 CDP Runtime.evaluate 等方法在授权网页中执行由本机应用或外部 Agent 提供的脚本。外部 Agent 可能使用模型生成这些脚本。该路径需要在后台如实披露，不能仅因传输地址是 localhost 就直接勾选“不使用远程代码”。[MV3 规则](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)列出 Debugger API 的有条件例外；具体用法仍须符合 API 用途、用户数据政策并可供审核。

数据申报应覆盖实际读取或传递的网页内容、网页浏览记录、用户操作和其中可能包含的个人信息。读取发生在本机、没有发布者遥测服务器，都不等于“不处理用户数据”。按最终功能逐项核对后台的数据类别，并与公开隐私页保持一致。

## 审核材料

- 将[隐私说明](native-extension-privacy.md)部署到真实 HTTPS URL，按实际情况披露页面、历史、截图、用户输入和调试内容。
- 已备 16/32/48/128 PNG 图标；还需 440×280 宣传图和至少一张 1280×800 或 640×400 的实际功能截图。截图展示当前真实扩展界面与虚构测试页面，并去除令牌、个人资料。测试 pairing 截图不自动等于合格商店截图。
- 审核步骤：安装 ProfilePilot CLI 或桌面应用 → 选择测试 Profile → 安装扩展 → 配对本机浏览器服务 → 在无私人数据的测试网页上执行读取/操作 → 暂停与交还 → 测试自建历史/下载 → 重启服务及 Chrome 后检查重连。外部 CLI 路径不要求模型账号；提供可复现命令和实际可下载的兼容版本。
- 分别记录 Windows、macOS 的实际安装与连接验证。未在 macOS 真机执行时，明确标记尚未验证。
- Public、Unlisted、Private 都须审核，不能用私有分发回避披露。[官方发布流程](https://developer.chrome.com/docs/webstore/publish/)
- 代码更新后提升 manifest version，运行回归与真实生命周期脚本，记录 ZIP 哈希及 OS/Chrome 版本。商店 ID 未确认前，当前 ZIP 用于创建草稿，不作为最终商店版兼容性验证结论。
