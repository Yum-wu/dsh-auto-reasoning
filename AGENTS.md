# AGENTS.md — dsh-auto-reasoning

> 全局规则见 `~/.dsh/AGENTS.md`;本文件只写本插件特有、且**改错了会静默降级**的那些。

## 这是什么

DSH 插件（Cordis bundle）。把模型配置里的 `reasoningEffort: auto` 哨兵，换算成
**该模型自己的合法档位**。零构建、零依赖、纯 ESM。

## ⚠ 第一条要知道的：effort 是**软引导**，本插件不是「决定思考深度」

两家官方文档口径一致（2026-10-05 实测抓取，非记忆）：

| 厂商 | 原文 |
|---|---|
| Anthropic | "Claude's thinking is **adaptive**: the model evaluates each request and **decides for itself** whether to think and how much"；effort "acts as **soft guidance**"；"**No level guarantees a thinking block on every request**" |
| OpenAI | "The models also reason **adaptively across reasoning efforts**, using fewer tokens for simpler tasks and thinking harder for complex tasks" |

**推论（这条最容易让人踩坑）**：本插件做的是**设定倾向（posture）**，最终思考多少仍由模型
逐请求自己决定。因此：

- **不要**在 README / UI / 日志里声称「本插件决定了思考深度」，那是误导；
- **不要**用「推理长度是否随档位单调」验证映射对不对。2026-10-05 实测：`high` 的推理长度
  反而低于 `medium`、`xhigh` 只有 `minimal` 同级 —— **不是 bug，是软引导的表现**。
  能验证的是「映射是否落在该模型声明的合法档位内」（`resolveModelInfo` 取的阶梯）。

## 改 criteria 之前必须知道的事

**criteria 改过多次而此前毫无验证手段。** 2026-10-05 依 Anthropic 官方
（"measure before you ship"）补了校准闭环：

```powershell
npm run bench          # 在线，真实 SystemOne 路径，打印对齐率与分档召回
npm run bench:offline  # 离线，只测规则兜底引擎，不打网络（CI 无网时用）
```

- 样本集在 `benchmarks/effort-alignment.mjs`，**扩样本优先于调参**：
  当前 37 条、`xhigh` 仅 6 条 —— 样本不足时调参就是在过拟合。
- 对齐率门禁 **在线 85% / 离线 60%**，已挂进 `npm test`（`test/alignment-gate.test.js`）。
  （在线阈值 2026-10-06 由 90% 下调，理由见下面「训练分 ≠ 泛化分」一节。）
- 标了 `debatable: true` 的样本**不计门禁** —— 那是「我们和模型的分歧，且选择相信模型」。
  删掉等于藏起分歧，改标注等于用结果拟合期望，两者都会让这个指标失去它唯一的作用。

改完 criteria 的正确流程：**先 `bench` 看改后 → 再 `bench:offline` 对照 → 确认不是网络抖动 → 才提交**。

## ⚠ 训练分 ≠ 泛化分（2026-10-06 血的教训，改这个文件前必读）

2026-10-06 我把规则兜底引擎的离线对齐率从 64.7% 调到 **100%（34/34）** —— 看起来很漂亮。
**但那是照着这 34 条的失败清单改正则改出来的。它是训练分。**

补了一批**留出集**（`HELDOUT_SAMPLES`，措辞与训练集不重合，先标注后运行）之后：

| 规则兜底引擎（离线） | 训练集 34 条 | **留出集 22 条** |
|---|---|---|
| 对齐率 | 100% | **36.4%** |

**差 64 个百分点。关键词表根本不能泛化** —— 它记住的是措辞，不是任务难度。

三条必须遵守的纪律：

1. **不要再用训练集数字论证质量。** 训练集 100% 只证明「这 34 条我没忘」。
2. **不要照着留出集的失败清单改正则。** 那会把留出集变成第二个训练集。
   留出集只做**棘轮**（`HELDOUT_BASELINE`，只禁变差不求变好），不做硬门禁 —— 理由同上。
   真要改，就改 SAMPLES 那边的判定逻辑，或**重写一批新的留出样本**并更新基线。
3. **`bench` 的「判定来源」必须看。** 主通道 429 时链路会**静默降级到规则引擎**，
   基准若不看来源，会把 36% 的规则引擎成绩当成在线成绩（我据此误判过一次）。
   整轮没打到 SystemOne 时基准会打 `★` 告警。

**默认档策略**（2026-10-06 由 `low` 改为 `medium`）：未命中任何特征时给 `medium`。
依据是 OpenAI 官方把 `medium` 定义为 "the default for most workloads"，`low` 是
「明确知道任务简单」才用的档。「正则没匹配上」只说明**我们不知道**，不等于任务简单。
这是刻意的**非对称**取舍：复杂任务被低估要重做（代价高、用户可见），
简单任务被高估只多花一点 token（代价低、静默）。

**SystemOne 基本稳定，但偶尔抖一条样本**：连跑 9 轮实测 **8 轮 94.1% + 1 轮 91.2%，
0 个样本出现过档位翻转**。34 条门禁样本里 1 条 = 2.9pp。

⚠ 正因如此，**在线门禁 2026-10-06 由 90% 下调到 85%**：90% 需要 ≥31/34，
而实测最低**正好是** 31/34 —— **余量为零**。会喊狼来了的门禁比稍松的门禁更糟。
85% 需要 ≥29/34，买到 2 条余量；真实退化掉得远不止这点（坏掉的 criteria 只有 64.7%）。
复现：

```powershell
npm run bench:variance   # 连跑 6 轮，并列出「判定不稳定」的样本
```

## SystemOne 是**双通道**的，别只测主通道

主通道 `opencode.ai/zen/v1/systemone`（`jev-1.13-free`）是**免费**的，代价是**限流**。
2026-10-06 实测抓到的真实现场：

```http
HTTP/1.1 429 Too Many Requests
retry-after: 15192
{"type":"error","error":{"type":"FreeUsageLimitError",...}}
```

**`retry-after: 15192` 秒 ≈ 4.2 小时。** 也就是说免费通道一旦耗尽，会有大半天完全不可用 ——
只挂主通道等于半天没有语义决策。

备用通道 `openrouter.ai/api/v1/systemone`（`typesafe/jev-1.13`）**按次计费 ≈ $0.000014**，
主通道非 200 / 超时 / 网络异常时自动接上。与 `tools/jev_suite/core/client.py`
的 `FALLBACK_ENDPOINT` / `FALLBACK_MODEL` 是同一套设计，改动时两边要对齐。

**密钥从哪来**（`pickFallbackKey`，顺序不可调）：
`JEV_FALLBACK_API_KEY` → `OPENROUTER_API_KEY` → **Windows 读注册表** `HKCU\Environment`。

> 为什么需要读注册表：DSH 子进程的环境会被 scrub（见 `~/.dsh/AGENTS.md`），
> 而用户级环境变量也可能晚于 DSH 进程启动才写入，此时 `process.env` 是旧快照。
> 注册表是唯一能拿到实时值的路径。**非 Windows 没有这个机制，探测不到就静默禁用备用通道。**

**缓存键取「主通道配置身份」而不是实际应答的通道**（`buildCacheKey(primaryEndpoint, primaryModel, …)`）：
两个通道语义等价（都是 Jev 1.13），按通道分键会让备用通道每次必 miss；
但配置被显式改过时必须分键，否则串味。

**没有 key 时静默禁用备用通道，不报错、不阻断** —— 这是刻意的降级，不是故障。

## 不可动的架构事实（改之前先读）

**1. 唯一挂载点是 `agent/request`。**
`llm/stream` 的 options 是 `deepFreeze` 的，且 cordis 的 `next()` 不吃实参，改不动。
`agent/request` 的返回值直接喂给 `llm.prepareCall`。换挂载点 = 功能失效。

**2. 必须 `{ global: true, prepend: true }`。**
- `global` —— 子代理是独立 agent 作用域，不加就只管主会话；
- `prepend` —— 要排在 `dsh-agent` 自己的模型选择监听之前成为最外层。

**3. 绝不能把 `'auto'` 原样交回宿主。**
`dsh-llm` 的 `resolveCallWithInfo` 会抛 `UNSUPPORTED_REASONING_EFFORT`。
拿不到合法档位时**剥掉该字段**回落模型默认档，不能退回哨兵。

**4. 提示词取数的时序是硬约束。**
`dsh-agent-loop/lib/index.js`：L906 `inbox.claim()` → L1050 `prepareRequest()` →
**L1179 `agent/request`（本插件挂载点）** → L1061 `session.append("user/message")`。
即：在本插件触发那一刻，用户消息**还没写进会话日志**。
`deriveMessages` / `snapshotEvents` / `user/message` 三条路都取不到。
唯一早于该时刻的入口是用户提交时的 `agent/inbox/spliced` 事件。
**取数优先级见 README，顺序是逐条实测定的，别重排。**

**5. 只认 `message.source.kind === 'user'`。**
DSH 把 AGENTS.md / runtime-context / skill-catalog 也当 user 消息注入，
且排在真实提示词之后。只看 `role === 'user'` 会取到技能目录，评分恒为 2，
表现为「Auto 永远是 low」。

## 改 `shouldTakeOver` 时的红线

四条接管判据（`sentinel` / `echo` / `orphan` / `forced`）缺一不可：

- 缺 `orphan` —— 宿主 `dsh-subagent/lib/index.js:450` 在「路由变了且未显式指定档位」时执行
  `delete resolved.reasoningEffort`，把父会话的 `auto` 哨兵一并删掉。
  **删掉它 = 换模型的子代理彻底脱离 auto。**
- 缺 `forced` —— 用户点了 UI 胶囊的「强制接管」却静默不生效，表现为「按钮点了没用」。

用户**手选**的档位默认一律不接管（会持久化进 request header，进来时是具体档位）。
`forced` 是唯一例外，且**必须**同时满足三条，缺一都是安全缺陷：

1. **默认关闭**，只由用户点击授权（内存态、有上限、重启即失效）；
2. **只认显式 `=== true`**，不接受 truthy —— 这是破坏用户显式选择的操作，宁可漏开不可误开；
3. **按 sessionId 隔离**，不做全局开关。

## 「强制接管」为什么技术上做得到（本插件跑在最外层）

本插件以 `prepend: true` 挂 `agent/request`，是**最外层**，拿到的 `resolved` 已被内层
`dsh-agent/lib/index.js:181-192` 的后置拾取器用 UI selection 覆盖过。

**这不是推理，是实测**：旧会话里插件报 `lastIncoming: max` —— 那个 `max` 正是内层写入的，
不是 `AgentOptions` 里的 `auto`（若本插件跑在内层，看到的应该是 `auto`）。
所以 `forced` 下改写返回值里的 `reasoningEffort`，能直接压过 UI 手选。

## 写路由的鉴权边界

`POST /api/auto-reasoning.force` **不碰任何凭据**，鉴权由宿主施加。
依据是实测，不是读代码猜的：

| 探测 | 结果 |
|---|---|
| 无 cookie POST `/api/auto-reasoning.force` | **401** |
| 有 cookie POST 同一路径（路由未注册时） | 404 |

即宿主把鉴权放在**路由匹配之前**（统一 middleware）。
⚠ 若哪天宿主改成路由内鉴权，这个写路由会裸奔 —— 改动前重跑上面那两条探测。

## 退出去向必须显式

`skipped: no-ladder | error | no-prompt` 三条都进决策对象并显示在 UI 胶囊上。
静默回落是排障灾难 ——「auto 没生效」时分不清是插件没挂、模型没档、还是决策崩了。

## 测试

```powershell
node --test test/*.test.js
```

46 例，覆盖哨兵合法性、四条接管判据（含严格模式的 truthy 拒绝与 handpicked 让位）、
阶梯投影（降级 / xhigh / max / 空阶梯 / 单档）、取数三条路与脏输入、三条退出去向、
缓存键防串味、备用密钥解析四条分支（专用变量优先 / 注册表 / 非 Windows 放弃 / 读取抛错降级）、
默认档策略（未命中给 medium 且高危分支不被默认档吃掉）、
criteria 覆盖度，以及**档位对齐率门禁**（含样本量下限、日常工具型底线、
留出集棘轮、留出集与训练集不得重复）。

`npm test` 会打网络跑真实 SystemOne 判定（这是门禁有意义的前提）；
无网环境用 `DISABLE_JEV_REMOTE=1 node --test test/*.test.js` 退化为离线规则引擎。

改行为先改测试。测试是本插件唯一的回归防线（宿主不提供）。

## 边界

- **档位阶梯运行时现取**（`ctx.llm.resolveModelInfo`），**禁止硬编码任何模型的档位**。
  各模型真实档位由网关 `http://127.0.0.1:10100/v1/models` 的 `reasoning_efforts` 字段声明，
  那是 profile 配置方的事，不是本插件的。
- **不搬进 `dsh-jev-preset`**：那是纯提示词插件，无运行时 `ctx.on()` 注册能力，挂不上这个钩子。
- 客户端胶囊（`lib/client.js`）走宿主 `/api` 通道，**鉴权由宿主施加，插件不碰凭据**。
- **凭据边界要说清**：本插件**只读**备用通道密钥（env / 注册表），**从不写入、从不转发、从不落盘**。
  上面那条「不碰凭据」指的是**客户端路由的鉴权**（由宿主 middleware 负责），
  与「读取备用通道密钥」是两件事，不要混为一谈。
  日志里**禁止**打印密钥本身 —— 连前缀都不要（`resolveFallbackApiKey` 的返回值只参与拼 header）。