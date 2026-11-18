# Chrome Web Store 提交包

这是准备材料，不代表已提交审核。当前 ZIP 为 0.2.18，开发 ID 为 gmdaabnoocjlpimglalnbegfdaklfnaj。必须先取得真实商店 item ID 和公钥，再核对开发扩展与应用端固定 ID，不能把开发 ID 自动视为商店 ID。

## 已备文件

- `store/description.zh-CN.txt`：名称、简述、单一用途和详细说明。
- `store/permissions.zh-CN.json`：与当前 manifest 逐项对应的十项权限及 host 权限理由。
- `store/privacy.zh-CN.md`：当前隐私说明副本。
- `store/icon-128.png`、`store/promo-small.png`（440×280）、`store/promo-marquee.png`（1400×560）。宣传图仅呈现品牌，不作为功能截图。
- `store/profilepilot-extension-0.2.18.zip`、SHA256、`validation.json`：可重现的扩展包和静态校验记录。

SHA256：`a137a269ae301c2f30f7c7da291174c58e2971c94534a016bb42293249576ec1`。

商店至少要求一张功能截图，尺寸为 1280×800 或 640×400；当前没有把图解或旧配对截图冒充最终运行截图。准备好兼容下载版和正式 ID 后，在无私人数据的测试页拍摄连接与受控标签页状态、人工接管状态。[图片要求](https://developer.chrome.com/docs/webstore/images)；简述上限 132 字符，manifest 必须位于 ZIP 根目录。[扩展准备要求](https://developer.chrome.com/docs/webstore/prepare)

## 审核人员操作说明

1. 从项目 Release 安装与扩展兼容的桌面版本，记录实际版本和下载链接。当前公开资产尚待更新，不填写虚构版本号。
2. 选择一个无私人数据的测试 Chrome Profile，加载这份扩展，并按“配套工具”的浏览器连接引导配对。CLI 和 Skill 从同一入口安装；外部 CLI 检查不需要配置模型账号。
3. 运行 `ppilot browser status`，从返回中取得实际 Profile ID，再运行 `ppilot browser --profile <实际ID> tabs`。占位符必须替换，不能复制默认 ID 当成已发现目标。
4. 运行 `ppilot browser --profile <实际ID> --session store-review --new-tab claim`，再运行 `ppilot browser --session store-review open https://example.com`。
5. 运行 `ppilot browser --session store-review observe`，核对页面标题、内容与扩展中的受控标签页。运行 `ppilot browser --session store-review screenshot --output review.png` 保存结果。
6. 运行 `ppilot browser --session store-review handoff`，核对后续动作被拒绝。由审核人员明确交还后，运行同一会话的 `resume`，重新 `observe`。不通过另一个会话绕过暂停。
7. 运行 `ppilot browser --session store-review complete`，核对控制权释放。使用自己创建的测试历史与下载文件补验 history / downloads；不要读取私人历史或下载资料。
8. 关闭并重新启动 Chrome、浏览器服务，核对配对保留、重连和任务状态。分别记录 Windows、macOS 结果。

## 隐私和数据申报

拟用公开地址：https://ffffhx.github.io/profilepilot/site/extension-privacy.html 。本地页面已备；2026-11-15 直接 HTTP 核验返回 404。需要随官网部署后再确认公网 HTTPS 可访问且内容与本包一致，不能将此地址作为已经上线的隐私页提交。

扩展代码随 ZIP 分发；通过已配对本机服务接收命令，CDP Runtime.evaluate 可执行来自本机应用或外部 Agent 的网页脚本。不要因为传输地址是 localhost 就直接申报“不使用远程代码”。后台需如实说明 Debugger API 路径，并依据 [MV3 政策](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements) 的有条件例外逐项核对。

数据声明必须覆盖实际处理的网页内容、浏览记录、用户操作及可能涉及的个人信息。没有发布者遥测服务器不等于不处理用户数据。完整身份迁移、权限和审核说明见 [商店准备文档](../native-extension-store.md)。

## 提交前仍需完成

开发者账号与费用由账号持有人处理；建立草稿并核对 item ID / key；从新下载包完成 Windows / macOS 连接测试；拍摄最终真实截图；验证公开隐私地址；按实际后台问题填写数据申报。以上条件满足后才提交，当前没有代为购买、上传或发布。
