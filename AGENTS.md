# AGENTS.md — dsh-auto-reasoning

> 全局规则见 `~/.dsh/AGENTS.md`;本文件只写本插件特有、且**改错了会静默降级**的那些。
> 证据、数据表、实测过程、厂商原文**全在 `README.md`** —— 本文件会被自动注入,不重复 README。

## 这是什么

DSH 插件（Cordis bundle）。把模型配置里的 `reasoningEffort: auto` 哨兵，换算成
**该模型自己的合法档位**。零构建、零依赖、纯 ESM。

## 红线

### 1. effort 是**软引导**,本插件不是「决定思考深度」

- 本插件做的是**设定倾向(posture)**;模型仍逐请求自己决定要不要想、想多少。
- **不要**在 README / UI / 日志里声称「本插件决定了思考深度」—— 那是误导。
- **不要**用「推理长度是否随档位单调」验证映射对不对。实测 `high` 反而低于 `medium`、
  `xhigh` 只有 `minimal` 同级 —— **不是 bug,是软引导的表现**。
- 能验证的只有「映射落在 `resolveModelInfo` 声明的合法档位内」。

### 2. 唯一挂载点是 `agent/request`,且必须 `{ global: true, prepend: true }`

- `llm/stream` 的 options 是 `deepFreeze` 的,且 cordis 的 `next()` 不吃实参 ⇒ **换挂载点 = 功能失效**。
- 缺 `global` ⇒ 只管主会话(子代理是独立 agent 作用域);缺 `prepend` ⇒ 排不到 `dsh-agent`
  自己的模型选择监听之前,成不了最外层。
- **绝不能把 `'auto'` 原样交回宿主** —— `dsh-llm` 的 `resolveCallWithInfo` 会抛
  `UNSUPPORTED_REASONING_EFFORT`,**整个 LLM 通道全挂,不是降级**。
  拿不到合法档位时**剥掉该字段**回落模型默认档。

### 3. 提示词取数有时序硬约束

`agent/request` 触发那一刻,本轮用户消息**还没**写进会话日志 ⇒ `deriveMessages` /
`snapshotEvents` / `user/message` 三条路都取不到,唯一早于该时刻的入口是
`agent/inbox/spliced`。**取数优先级见 README,顺序是逐条实测定的,别重排。**

- **只认 `message.source.kind === 'user'`。** DSH 把 AGENTS.md / runtime-context /
  skill-catalog 也当 user 消息注入,**且排在真实提示词之后**。只看 `role === 'user'`
  会取到技能目录,评分恒为 2,表现为「Auto 永远是 low」。

### 4. `shouldTakeOver` 四条判据缺一不可

`sentinel`(会话首次请求,seed 来自 AgentOptions)/ `echo`(incoming === 本会话上次我写的档位,
是我的回音 ⇒ 每轮重新评估)/ `orphan` / `forced`。

- 缺 `orphan` —— 宿主 `dsh-subagent` 在「路由变了且未显式指定档位」时执行
  `delete resolved.reasoningEffort`,把父会话的 `auto` 哨兵一并删掉。
  **删掉它 = 换模型的子代理彻底脱离 auto。**
- 缺 `forced` —— 用户点了 UI 胶囊的「强制接管」却静默不生效,表现为「按钮点了没用」。
- `forced` **必须同时**满足三条,缺一都是安全缺陷:
  ① **默认关闭**,只由用户点击授权(内存态、有上限、重启即失效);
  ② **只认显式 `=== true`**,不接受 truthy —— 这是破坏用户显式选择的操作,宁可漏开不可误开;
  ③ **按 `sessionId` 隔离**,不做全局开关。
- 用户**手选**的档位默认一律不接管(会持久化进 request header,进来时是具体档位)。

### 5. 退出去向必须显式

`skipped: no-ladder | error | no-prompt` 三条都进决策对象并显示在 UI 胶囊上。
静默回落是排障灾难 ——「auto 没生效」时分不清是插件没挂、模型没档、还是决策崩了。

## 校准闭环(criteria)

```powershell
npm run bench          # 在线,真实 SystemOne 路径,打印对齐率 / 分档召回 / 判定来源
npm run bench:offline  # 离线,只测规则兜底引擎,不打网络
```

- **验收顺序固定:`bench:real` → `bench:offline` → `bench`(在线) → 确认不是网络抖动 → 才提交。**
  手写样本集只能回答「改了会不会变坏」,**回答不了「真实分布上哪个更好」**。
- **不要再用训练集数字论证质量** —— 规则兜底引擎训练集 100%、**留出集只有 36.4%**(差 64pp)。
- **不要照着留出集的失败清单改正则** —— 那会把留出集变成第二个训练集。留出集只做
  **棘轮**(`HELDOUT_BASELINE`,只禁变差不求变好),**不做硬门禁**。
- **`bench` 的「判定来源」必须看** —— 主通道 429 时链路会**静默降级到规则引擎**,
  不看来源会把规则引擎成绩当成在线成绩(据此误判过一次)。整轮没打到 SystemOne 时打 `★` 告警。
- 标了 `debatable: true` 的样本**不计门禁** —— 删掉等于藏起分歧,改标注等于用结果拟合期望。
- **扩样本优先于调参**(`xhigh` 召回 0/6;样本不足时调参就是在过拟合)。
- 门禁:在线 **85%** / 离线 **60%**,挂在 `test/alignment-gate.test.js`。
- 未命中的 prompt 默认给 **`low`**(依据见 README;默认 `medium` 已被配对检验否掉),
  **但高危/开发分支不被默认档吃掉** —— 有测试守。
- **不要声称关键词匹配「已被证明有效」** —— 它相对「恒定 low」的 χ²=1.89 **不显著**
  (点估计 +9.1pp)。保留它只是因为没证据说它有害、且长 prompt 命中率 92%。

## SystemOne 是**双通道**的,别只测主通道

- **主通道免费 ⇒ 限流。** 实测 429 带 `retry-after: 15192`(≈**4.2 小时**)——
  只挂主通道等于大半天没有语义决策。**备用通道必须自动接上。**
- **密钥顺序不可调**(`pickFallbackKey`):`JEV_FALLBACK_API_KEY` → `OPENROUTER_API_KEY`
  → **Windows 注册表** `HKCU\Environment`。读注册表是因为 DSH 子进程的环境会被 scrub
  (见 `Desktop\DeepSeekHarness\AGENTS.md` 的「本机运维硬规则」),且用户级环境变量可能
  晚于 DSH 进程启动才写入,此时 `process.env` 是旧快照。
- **缓存键取「主通道配置身份」而不是实际应答的通道**
  (`buildCacheKey(primaryEndpoint, primaryModel, …)`):两通道语义等价,按通道分键会让
  备用通道每次必 miss;但配置被显式改过时**必须分键**,否则串味。
- **没有 key 时静默禁用备用通道,不报错、不阻断** —— 这是刻意的降级,不是故障。
- 与 `tools/jev_suite/core/client.py` 的 `FALLBACK_ENDPOINT` / `FALLBACK_MODEL` 是同一套设计,
  **改动时两边要对齐**。

## 改 criteria / 挖真实 prompt 时的两个坑

`benchmarks/real-prompts.mjs`(`npm run bench:real`)读 `~/.dsh/sessions` 下的会话档:

1. **只认 `source.kind === 'user'`**,否则会把注入的 AGENTS.md 当成用户提问;
2. 会话档是**多帧 zstd 拼接** —— Node 的 `zstdDecompressSync` 只解第一帧、流式 API 报
   `Unknown frame descriptor`,**必须按魔数 `28 B5 2F FD` 手工切帧**。

## 边界

- **档位阶梯运行时现取**(`ctx.llm.resolveModelInfo`),**禁止硬编码任何模型的档位** ——
  各模型真实档位由网关 `/v1/models` 的 `reasoning_efforts` 字段声明,那是 profile 配置方的事。
- **不搬进 `dsh-jev-preset`**:那是纯提示词插件,无运行时 `ctx.on()` 注册能力,挂不上这个钩子。
- 客户端胶囊(`lib/client.js`)走宿主 `/api` 通道,**鉴权由宿主 middleware 在路由匹配之前施加**。
- **凭据边界要说清**:本插件**只读**备用通道密钥(env / 注册表),**从不写入、从不转发、从不落盘**。
  上面那条「不碰凭据」指的是**客户端路由的鉴权**,与「读取备用通道密钥」是两件事,不要混为一谈。
- 日志里**禁止**打印密钥本身 —— 连前缀都不要(`resolveFallbackApiKey` 的返回值只参与拼 header)。

## 测试

```powershell
node --test test/*.test.js                          # 含双通道密钥解析 / 默认档策略 / 留出集棘轮
DISABLE_JEV_REMOTE=1 node --test test/*.test.js     # 无网环境,退化为离线规则引擎
```

`npm test` 会打网络跑真实 SystemOne 判定(这是门禁有意义的前提)。

**改行为先改测试。** 测试是本插件唯一的回归防线(宿主不提供)。
