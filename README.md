# dsh-auto-reasoning

自动思考程度（Auto Reasoning Effort）—— 按任务复杂度把本次请求的 `reasoningEffort`
投影到**该模型自己的合法档位阶梯**上。会话级哨兵 `auto`，覆盖子代理。

- 仓库：<https://github.com/Yum-wu/dsh-auto-reasoning>
- 独立仓，不归 `DeepSeekHarness` 本仓收录（该仓 `.gitignore` 忽略 `plugins/`）
- 零构建、零运行时依赖、纯 ESM
- 改代码前必读 [AGENTS.md](AGENTS.md) —— 里面全是「改错了会静默降级」的硬事实

## 安装与接线

```powershell
# 1. profile 依赖（link 指向本仓）
#    ~/.dsh/profiles/web/package.json
#      "dependencies": { "dsh-auto-reasoning": "link:C:/…/plugins/dsh-auto-reasoning" }
#      "dsh": { "profile": { "bundles": [ …, "dsh-auto-reasoning" ] } }

# 2. node_modules junction
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-auto-reasoning" `
  -Target "<本仓路径>\plugins\dsh-auto-reasoning"

# 3. 声明行 —— ~/.dsh/profiles/web/cordis.patch.yml
#    - id: plugin-auto-reasoning
#      name: 'dsh-auto-reasoning'
#      config:
#        enabled: true
#        decisionCap: 50

# 4. 让默认模型走 auto（agent-default-model 的 reasoningEffort 必须是 auto）
```

**改完需重启 DSH 才生效。** 重启走桌面「服务管理台」，
**不要用 `~/.dsh/restart-dsh.ps1`** —— agent 会杀掉自己的宿主进程，工具结果永远回不来。

⚠ **插件没加载时 `'auto'` 会裸奔**：`dsh-llm` 的 `resolveCallWithInfo` 抛
`UNSUPPORTED_REASONING_EFFORT`，**整个 LLM 通道全挂，不是降级**。
回滚就是把 `reasoningEffort` 改回具体档位（如 `max`）。

## 怎么验证生效

客户端胶囊挂 `conversation.composer.dock`（输入框底栏），显示 `Auto (high) · 8/10`。
宿主侧只读路由：

```
GET /api/auto-reasoning.effort?sessionId=<sid>
→ {"enabled":true,"seen":N,"takenOver":N,"lastIncoming":"…","lastOutgoing":"…",
   "lastTakeoverVia":"sentinel|echo|orphan","lastSkipReason":"…","decision":{…}}
```

`takenOver: 0` 且 `lastIncoming` 是具体档位 → 哨兵没进来。查两处：

1. `agent-default-model` 的 `reasoningEffort` 是不是 `auto`；
2. **该会话有没有手选过档位** —— 宿主 `dsh-agent/lib/index.js:181-192` 的后置拾取器
   会无条件剥掉继承档、只认 UI 的 `selection.current`（持久化在 session request header）。
   **改配置对已有会话永远无效**，必须新建会话。

## 为什么它是独立插件（2026-10-05）

此前 auto 逻辑寄居在 `dsh-plugin-codemode` 的 `src/index.ts` 里，但它：

- 挂的是平台钩子 `agent/request`（`{ global: true, prepend: true }`）
- 读 `agent/session` + `session/event`
- 调 `ctx.llm.resolveModelInfo()` 取档位阶梯
- 注册宿主 `/api` 路由给 UI 胶囊

**零行是 codemode 的沙箱 / tool-bridge / truncator**，只是借宿。而 codemode 之外没有
第二处能改写档位的位置 —— 它必须待在 `agent/request` 上，这个归属没错，错的是**插件身份**。

不搬进 `dsh-jev-preset`：jev 是纯提示词插件（全目录无运行时 `ctx.on()` 注册），
塞不进去。

### 迁移已完成（2026-10-05）

- `dsh-plugin-codemode` 侧已清空：`autoReasoning` 配置项、`./client` 导出、`dsh.client`
  声明、`GET /api/codemode.auto-effort`、`src/{auto-reasoning,jev-client}.ts`、
  570 行的 auto 集成测试，全部删除（该插件 `node --test` 现在 10/10）。
- 本插件的声明行由 **dsh-jev-preset 的 bundle** 顺带 insert（同一个 insert 组里的第二条），
  所以**装 JEV preset 就带上 auto 档位**，与 codemode 无关。
- ⚠ 迁移期要改 profile 的 `cordis.patch.yml`：**删掉 `autoReasoning: true`**。
  该键已不在 codemode 的 `CodeModeConfig` 里，而 cordis 按整条 entry 校验配置 ——
  留着未知键会让整条 `plugin-codemode` 不激活，表现为「codemode 工具凭空消失」。

## ⚠ effort 是**软引导**，本插件设定的是倾向，不是「决定思考深度」

这是最容易误解的一点，写在最前面。两家官方文档口径一致（2026-10-05 实测抓取）：

> **Anthropic**：「Claude's thinking is **adaptive**: the model evaluates each request and
> **decides for itself** whether to think and how much」；effort "acts as **soft guidance**"；
> "**No level guarantees a thinking block on every request**"
>
> **OpenAI**：「The models also reason **adaptively across reasoning efforts**, using fewer
> tokens for simpler tasks and thinking harder for complex tasks」

也就是说：**本插件选出档位之后，模型仍会逐请求自己决定要不要想、想多少。**
可验证的是「映射落在该模型声明的合法档位内」，**不是**「模型真的想了多少」。

> 由此也能解释一个曾让我误判的实测现象：同一模型上 `high` 的推理长度反而低于 `medium`、
> `xhigh` 只有 `minimal` 同级 —— **这不是映射 bug，是软引导的正常表现**。
> 别再用「推理长度是否随档位单调」去验证映射。

## 校准闭环（2026-10-05 新增，2026-10-06 补上留出集）

criteria 改过多次而**此前毫无验证手段** —— 每次都是拍脑袋，无法回答「改完是变好还是变坏」。
依 Anthropic 官方要求（"treat it like any other prompt change: **measure before you ship**"）补上：

```bash
npm run bench          # 在线，真实 SystemOne 路径，打印对齐率、分档召回、判定来源、留出集
npm run bench:offline  # 离线，只测规则兜底引擎，不打网络
```

### 1. 训练分 ≠ 泛化分

2026-10-06 我把规则兜底引擎的离线对齐率从 64.7% 调到 **100%**（34/34）。
**但那是照着这 34 条的失败清单改正则改出来的 —— 是训练分。**

于是补了一批**留出集**（`HELDOUT_SAMPLES`，措辞与训练集不重合，先标注后运行）：

| 规则兜底引擎（离线） | 训练集（34 条，已污染） | **留出集（22 条，未参与调参）** |
|---|---|---|
| 对齐率 | 100% | **36.4%** |

**差 64 个百分点。** 结论：关键词表**根本不能泛化** —— 它记住的是措辞，不是任务难度。
换一种说法问同一件事，它就判不出来了。

这也直接回答了「离线兜底引擎该给多少门禁」：**训练集上的 60% 门禁衡量的是记忆，
不是能力**。所以留出集**不做硬门禁、只做棘轮**（`HELDOUT_BASELINE`，只禁变差不求变好）——
拿它当硬门禁，下一步必然是照着它的失败清单调参，然后它就变成第二个训练集。
完整纪律写在 `HELDOUT_SAMPLES` 的注释里。

### 2. 真实 prompt 分布：合成样本集都不算数

训练集和留出集**都是我自己写的**，所以它们回答不了「真实用量长什么样」。
2026-10-06 补上真实数据源：**本机 846 个真实会话档**（`~/.dsh/sessions`），
抽出 981 条去重后的真实用户 prompt。

先量命中率（规则引擎靠关键词匹配，命中率是它的天花板）：

| | 训练集 34 条 | 留出集 22 条 | **真实 prompt 981 条** |
|---|---|---|---|
| 关键词命中率 | 100% | **0%** | **69.1%** |

留出集 0% 是因为它被**故意**写成与训练集不重合的措辞；真实用量的措辞介于两者之间。

再抽 120 条用 **SystemOne 打标**（它是真实 L2 路径，在线对齐率 94.1%），比三个策略：

| 策略 | 与 SystemOne 一致 | vs「省略字段」的 McNemar |
|---|---|---|
| 省略字段（恒定 high，本模型默认档） | 33.3% | — |
| **规则引擎（默认 medium，改前）** | **35.0%** | **χ²=0.03 → 不显著** |
| 恒定 low（众数基线） | 41.7% | — |
| **规则引擎（默认 low，改后）** | **50.8%** | **χ²=8.16 → 显著** |

**两条硬结论**：

1. **改默认档之前，这个兜底引擎相对「什么都不做」没有可证的价值**（χ²=0.03）。
   「+12.5pp」是点估计，配对检验一算就不显著 —— 差点又用一个噪声数字下结论。
2. **默认档从 `medium` 改成 `low` 是本次唯一被证明有效的改动**（+15.8pp，χ²=8.16）。

为什么是 `low`：未命中批（占真实 prompt **32.5%**）的 SystemOne 标签是
low/medium/high = 28/9/2 —— **众数 low 占 71.8%**，而默认 medium 只对 23.1%。
这批 prompt 的**长度中位只有 17 字符**（命中批是 1091），几乎全是短对话式追问
（「那就写吧」「1a,并验证」）。它们不含开发词汇所以永远命不中，
但**本来就不需要深推理** —— **长度本身就是最强的信号**。

⚠ **仍未证明**：改后 vs「恒定 low」的 χ²=1.89（不显著）——
**关键词匹配本身的增量价值在 n=120 上没测出来**。保留它是因为没证据说它有害、
且长 prompt 命中率 92%；但不要声称它「已被证明有效」。

⚠ 局限：SystemOne 不是真值（它自己也有 ~6% 偏差），所以上表是**与 L2 的一致率**，
不是绝对正确率。

### 当前基线（2026-10-06）

| | 离线规则兜底（训练集） | **离线规则兜底（留出集）** | 在线 SystemOne |
|---|---|---|---|
| 对齐率 | 100% | **36.4%** | **94.1%**（9 轮里 8 轮；另 1 轮 91.2%） |
| 门禁 | 60% | 棘轮 36.4%−5pp | **85%** |
| `low` 召回 | 83% | — | **100%** |
| `max` 召回 | 33% | — | 44% ~ 56% |

**关于在线那一列的抖动**：`npm run bench:variance` 连跑 9 轮，得到
**8 轮 94.1% + 1 轮 91.2%，且 0 个样本出现过档位翻转** —— 即 SystemOne **基本稳定，
但偶尔会有一条样本抖动**。34 条门禁样本里 1 条 = 2.9pp，这直接决定了阈值该定多少（见下）。

**在线阈值 2026-10-06 由 90% 下调到 85%**：90% 需要 ≥31/34，而实测最低**正好是** 31/34
（91.2%）—— **余量为零**，再抖一条就掉到 88.2% 误报。而会喊狼来了的门禁比稍松的门禁更糟，
它训练人忽略红灯。85% 需要 ≥29/34，买到 2 条余量；真实退化掉得远不止这点
（坏掉的 criteria 实测只有 64.7%），检测力不受影响。

**在线与离线用不同阈值是刻意的**：在线走语义判定，才是真实路径；离线是关键词表兜底，
职责是「网络挂时链路不断」而非「精确分类」。

**基准会打印「判定来源」**：`SystemOne 主通道` / `SystemOne 备用通道` / `★规则兜底引擎`。
**这个必须看** —— 主通道 429 时链路会**静默降级**到规则引擎，此时若不看来源，
会把规则引擎的 36% 当成在线成绩。若整轮都没打到 SystemOne，基准会打三条 `★` 告警。

**门禁**：`test/alignment-gate.test.js` 把对齐率挂进 `npm test`，低于阈值即红。
另有四道护栏：每档样本量不足 5 条时失败；日常工具型任务被判到 medium 以上时失败；
留出集低于棘轮时失败；留出集与训练集出现重复 prompt 时失败。

标了 `debatable: true` 的样本**不计门禁** —— 那是「我们和模型的分歧，且选择相信模型」。
删掉等于藏起分歧，改标注等于用结果拟合期望，两者都会让指标失去它唯一的作用。

**已知短板**：`xhigh` 召回 0/6。SystemOne 倾向直接给 `high` 或 `max`，中间这档很难命中。
**当前样本量不足以判断这是 criteria 的问题还是档位本身的特性 —— 先补样本，不要调参。**

## 与旧实现的差异：子代理现在也 auto

宿主 `dsh-subagent/lib/index.js` 的 `resolveChildAgentOptions()`（L442–451）：

```js
...parentReasoningEffort !== void 0 ? { reasoningEffort: parentReasoningEffort } : {},
...requested,
if ((resolved.provider !== parentProvider || resolved.model !== parentModel)
    && requested?.reasoningEffort === void 0) delete resolved.reasoningEffort;   // L450
```

| 派发方式 | 子代理 incoming | 旧 codemode | 本插件 |
|---|---|---|---|
| 同模型、不带 effort | 继承父 = `'auto'` | ✅ | ✅ `sentinel` |
| **换模型、不带 effort** | 被 L450 删成 `undefined` | ❌ 放行 | ✅ **`orphan`** |
| 换模型 + 显式 `'high'` | `'high'` | ❌ 钉死 | ❌ 钉死（用户显式意图，不该覆盖） |

第三行是有意不接管：显式档位是调用方的明确意图。

## 接管判据（`shouldTakeOver`）

| via | 条件 | 含义 |
|---|---|---|
| `forced` | 用户点了强制接管 | 无视一切 UI 选择 |
| `sentinel` | `incoming === 'auto'` | 会话首次请求，seed 来自 AgentOptions |
| `echo` | `incoming === 本会话上次我写的档位` | 是我的回音 → 每轮重新评估 |
| `orphan` | `incoming === undefined` | 换模型子代理丢了继承档位 |

**用户手选的档位一律不接管** —— 它会持久化进 request header，进来时是具体档位，
不命中上述任何一条（除非恰好等于我上次写的，此时由宿主
`dsh-agent` 的后置拾取器重新覆盖用户选择，用户意图始终优先）。

## 强制接管（点胶囊切换）

胶囊可点击，在两个模式间切换：

| 模式 | 胶囊显示 | 行为 |
|---|---|---|
| **跟随 UI**（默认） | `Auto (high) · 8/10` | 只在 `sentinel` / `echo` / `orphan` 时接管。**用户手选优先，永不覆盖** |
| **强制接管**（点击开启） | `⚡强制接管 (high) · 8/10`（加粗描边） | 该会话**所有**请求的档位都由插件决定，连 UI 手选也覆盖 |

再点一次切回。三条安全约束（详见 [AGENTS.md](AGENTS.md)）：

- **默认关闭**，只由点击授权；内存态、有上限、**重启即失效** —— 不会留下「静默接管」的暗状态；
- **只认显式 `true`**，不接受 truthy 值；
- **按 `sessionId` 隔离**，不做全局开关。

```
GET  /api/auto-reasoning.effort?sessionId=…   →  …, "forced": true, "forcedSessions": […]
POST /api/auto-reasoning.force  { "sessionId": "…", "forced": true }  →  { ok: true, forced: true }
```

**为什么技术上压得过 UI 手选**：本插件以 `prepend: true` 挂 `agent/request`，是最外层，
拿到的 `resolved` 已被内层 `dsh-agent/lib/index.js:181-192` 的后置拾取器用 UI selection 覆盖过
（实测：旧会话里插件报 `lastIncoming: max`，那正是内层写入的值，不是 `AgentOptions` 里的 `auto`）。
所以改写返回值里的 `reasoningEffort` 就能直接压过它。

写路由**不碰任何凭据** —— 宿主鉴权在路由匹配之前（实测：无 cookie POST → 401，
有 cookie 但路由未注册 → 404）。

## 兜底

拿不到合法档位 / 决策异常 → **剥掉** `reasoningEffort` 交回宿主，让模型用自己默认档。
绝**不**把 `'auto'` 原样传下去（会在 `dsh-llm` 的 `resolveCallWithInfo` 抛
`UNSUPPORTED_REASONING_EFFORT`）。

## 提示词取数（时序敏感）

`agent/request` 触发时，本轮用户消息**还没**写进会话日志（`dsh-agent-loop` L1179 挂载，
L1061 才 `session.append("user/message")`）。按优先级：

1. `agent/inbox/spliced` 缓存 —— 用户提交那一刻写入，唯一早于本请求的源（WeakMap 按会话对象 + Map 按 id 双索引）
2. `agent.inbox`（`nextTurn` / `nextStep`）
3. `agent.frozenMessages`
4. `session.snapshotEvents()`
5. `session.deriveMessages()`（历史兜底，真实宿主里恒空）

取数只认 `message.source.kind === 'user'` —— DSH 把 AGENTS.md / runtime-context /
skill-catalog 也当 user 消息注入且排在真实提示词之后，只看 role 会取到技能目录，
评分恒为 2（表现为「Auto 永远是 low」）。

## 决策链路

- **L1 特征过滤**（`scoreTaskComplexity`，0ms 极速响应）
- **L2 语义决策**（优先 SystemOne 主备双通道无缝容灾，3.5s 超时 + 5min LRU）：
  - **主通道**：OpenCode Zen 免费通道（`https://opencode.ai/zen/v1/systemone`，`jev-1.13-free`）
  - **备用通道**：OpenRouter 官方通道（`https://openrouter.ai/api/v1/systemone`，`typesafe/jev-1.13`，单次 ≈ $0.000014）
    （当主通道遭遇 429 限流或网络异常时自动平滑切换，对齐 `tools/jev_suite/core/client.py` 架构设计）
- **L3 离线规则兜底**（两路远程均不可用时兜底，确保链路不断）
  ⚠ **不要用训练集数字衡量它**：训练集 100%、**留出集只有 36.4%** —— 关键词表记的是措辞，
  不是任务难度。详见上面「训练分 ≠ 泛化分」。

## 客户端

`lib/client.js` 挂 `conversation.composer.dock`，3s 轮询只读路由 `/api/auto-reasoning.effort`。
路由鉴权由宿主施加，插件不碰凭据。支持点击切换「强制接管」与单档模型可观测性显示。

## 测试

```powershell
node --test test/*.test.js   # 48 例（含双通道密钥解析、默认档策略、留出集棘轮）
npm run bench                # 37 条训练集 + 22 条留出集，打印判定来源
npm run bench:offline        # 同上但不打网络
npm run bench:variance       # 连跑 6 轮量化判定方差（每轮约 1 分钟）
```
