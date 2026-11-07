# 闲鱼网站适配

闲鱼能力接在现有网站适配器上，CLI、扩展连接、Gateway 和内置 Agent 共用参数与解析。使用当前选定的 Profile 和已持有控制权的任务会话。搜索调用页面已有 MTOP SDK；详情优先读取当前商品页已经加载的状态，必要时读取可见 DOM。不会导出 Cookie、创建另一浏览器身份或接管其他任务。

## 搜索与详情

先用 `ppilot browser sites xianyu` 获取当前输入 schema。通过既有 `site --params-file` 或内置 Agent 的 `site_read` 调用：

```json
{"operation":"xianyu.search","params":{"query":"DDR5 32GB","maxPrice":500,"personalOnly":true,"sort":"latest","limit":20,"criteria":{"excludeRepaired":true,"memory":{"generation":"DDR5","totalGB":32,"pieces":2}}}}
```

```json
{"operation":"xianyu.detail","params":{"id":"从搜索结果获取的数字ID"}}
```

`xianyu.search` 支持综合、最新、价格升降序、新降价排序，价格范围、个人闲置、包邮、全新和省市区条件。地区使用网站实际选项名称：`xianyu.regions` 列出省份，传 `parentId` 获取下一级；`region` 为 `{province, city?, area?}`，区县必须同时提供城市。未知参数直接拒绝。

检查 `effective.filters`、`sortVerified`、`pagination` 和 `completeness`。请求参数和确认生效是两回事：价格通过服务端金额范围及返回商品交叉核对，个人闲置检查服务端标志，包邮和全新检查返回标签。地区先按网站地区列表解析层级，再核对商品显示的下级位置：选择省份时通常显示城市，选择城市时通常显示区县。不存在的地区组合直接报错；无法核实的条件仍标为 `partial`。价格排序和发布时间排序的校验范围仅为当前返回页，新降价顺序缺少可靠的时间证据时不宣称已验证。

价格保留网站原始显示文本。遇到“99.99万”等缩写时，数值字段使用同一商品响应中的精确金额，避免把缩写当作精确价格；起售价和区间价不会按这个规则强行转为单一金额。成色与维修判断也使用商品标签和详情属性，但仍只代表卖家声明。

每页最多 30 条；`pagination.next` 包含完整的下一组参数，可能先返回当前页的剩余记录。翻页保留商品 ID 去重。列表有效为空、登录失效、要求验证、超时和结构变化分别报告；不将失败包装成空列表，不将搜索遗漏解释为下架。详情状态仅根据网站明确提供的“在线 / 已下架 / 卖掉了”映射。

搜索缓存位于当前页面，按控制会话与查询参数隔离，最多 12 组、15 秒；`refresh` 请求新数据。超时请求可能仍在网站 SDK 内运行，60 秒内不会重放。所有轮询均重新检查控制权，接管或断线会中止整个操作。

## 商品对比

`criteria` 支持必须包含词、排除词、排除维修及内存的代际、总容量、条数和台式机／笔记本规格。结果保留判断原文，区分“不符合”“待确认”“符合卖家描述”。缺失信息不补成已知；无拆无修始终是卖家声明，不能证明实物状况。订金、起售价、单件标价、包装盒及多个规格会产生待确认项。

一次搜索、详情核对、对比和持久快照：

```text
ppilot browser --session TASK xianyu scan --params-file scan.json --store history.json --output report.json --html report.html
```

`scan.json`：

```json
{
  "search": {
    "query": "DDR5 32GB",
    "maxPrice": 500,
    "criteria": {
      "excludeRepaired": true,
      "memory": {"generation":"DDR5","totalGB":32,"pieces":2}
    }
  },
  "maxPages": 2,
  "detailLimit": 5
}
```

先读列表，跳过已经明确不符合的候选，仅进入有限个详情。遇到拦截停止后续读取并保留已取得的结果。Gateway 在 `xianyu` 之前加既有 `--cdp PORT`。该命令不会 claim 或 resume。

详情读完会按最新标价重新核对预算；超预算、明确已售、下架或删除的商品不会继续标为符合。仅单个商品已删除时保留这一依据并继续核对其他候选，登录、验证和连接错误仍会停止整个扫描。价格范围指挂牌价，不含另付运费。

`xianyu compare --input report.json --params-file criteria.json --html comparison.html` 可离线重新比较已有结果，保留原扫描报告的预算，并更新商品与对比表中的判断。报告明确标注没有重新读取网站。

## 价格历史与现有监控项目

重复执行同一 `scan --store` 即可记录新采样。第一次建立基线，后续输出 `first_seen`（首次发现）、`price_drop`、`price_rise`；仅网站提供的发布时间晚于上次扫描且不晚于本次采样时，首次发现才标为 `new_listing`（新上架）。规格或标价口径改变时输出 `listing_changed`。相同采样与相同价格不会重复产生提醒，过期结果不会倒退扫描基线。搜索失败不会更新基线，没出现的旧商品仍保留。每个 Profile、搜索条件分别保存；Gateway 还按会话隔离，避免逻辑端口被其他 Profile 复用后混入历史。

```text
ppilot browser xianyu history --store history.json --item 商品ID
```

已有 `ai-goofish-monitor` 继续负责原来的持续任务和调度。其 `xianyu-monitor/scripts/goofish.py history` 可只读导出 `price_snapshots`；本项目接收该导出：

```text
ppilot browser xianyu import --store history.json --input goofish-history.json
```

导入保留采样时间、挂牌商品 ID 和价格，去重后与实时扫描分开存储，不向原 SQLite 写入，也不对导入数据产生新上架提醒。金额只接受中国市场 CNY 挂牌价；不把成交价混入，也不把不同挂牌商品直接合并成同一条市场价格曲线。

历史时间包含时区时统一为 UTC；没有时区或只有日期时保留原值，并用 `timeBasis` 标明 `source-local` / `date-only`。不按运行机器的时区猜测。相同商品混合不同时间口径时不推断最新记录，避免 Windows、macOS 或不同系统时区得到不同结果。

`scan` 每次运行一轮。持续执行可使用已有任务调度，但每轮仍须使用合法、可用的浏览器会话；控制权改变时停止。浏览器之外的通知推送继续由原监控项目处理。

## 验证

```text
npm run check
node node_modules/typescript/bin/tsc
node --test tests/xianyu-adapters.test.js tests/xianyu-history.test.js tests/xianyu-cli.test.js tests/xianyu-verification.test.mjs tests/site-adapters.test.js tests/site-adapter-integration.test.js tests/browser-cli.test.js
```

`tests/fixtures/xianyu/search.json` 基于 2026-10-25 的真实响应结构，商品 ID 和用户字段已清理。离线测试不能证明当前网站一直可用；需要用当前已登录会话执行真实搜索、筛选、翻页和详情验证。

浏览器明确交还后，可用现有已持有控制权的扩展会话运行：

```text
node scripts/verify-xianyu.mjs --session TASK --query "DDR5 32GB" --max-price 5000
```

脚本通过实际服务读取通用页面、搜索、价格与个人筛选、排序、第二页、地区和最多五个详情，保存响应、检查结果和 HTML。控制权变化或网站拦截时停止，不恢复会话。比较只记录单次已加载页面的读取耗时、输出字节和共同商品的标题/价格核对，不宣称模型 token、整体任务效率或成功率已经改善。不同字段覆盖及通用读取的截断上限会写入报告。

Windows 和 macOS 共用 TypeScript 实现；JSON 文件支持 UTF-8 BOM，文件路径通过 Node API 处理，无 Bash、硬编码 Windows 目录或跨平台 shell 拼接。平台实测结果应分别记录，不能把 Windows 通过当作 macOS 已验证。

### 2026-10-25 本地验收记录

Windows、默认 Chrome Profile、扩展 0.2.15。完整构建、54 项相关测试及插件打包检查通过。正式 `ppilot` CLI 连续扫描两轮，每轮 2 页、60 个去重候选、5 个详情；首次建立基线，第二轮记录新的采样及一条 `first_seen`，未将其误报成新上架。已有监控的 29 条历史成功导入，重复导入新增 0 条。

实际网站验证通过：30 件列表商品的标题／价格与页面完整卡片一致，价格和个人闲置组合筛选、价格升降序、最新排序、包邮、全新、省／市／区层级、翻页和五个完整详情。低预算响应夹杂的一条超范围或无法解析标价的记录被本地过滤，并保留 `partial` 说明。新降价查询返回真实降价标签，但精确顺序缺少足够证据，仍标为未完全验证。

单次页面准备完成后的测量：通用 `read` 输出 65,890 字节、76 ms；结构化搜索输出 29,598 字节、679 ms，包含 30 件商品，输出量减少 55.1%。详情耗时 813–1,746 ms。页面准备耗时 3,410 ms，另外记录；通用控件的长标签被截断时，用一次独立 DOM 卡片读取核对，不计入上述两种读取。两者字段及是否刷新网络数据不同，这不是模型 token、全流程耗时或成功率对比，不能宣称适配器更快。

本机原始验收材料位于忽略目录 `artifacts/xianyu/verified-current-build/`、`extra-filters/`、`live-report.json`、`live-followup.json` 与 `report-preview.png`。最后一项展示的是实际生成的 HTML 报告。macOS 已检查路径、编码和时区差异，尚未做实机浏览器验证。
