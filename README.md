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

L1 规则（`scoreTaskComplexity`）→ L2 Jev SystemOne 语义判定（`queryJevReasoningEffort`，3.5s 超时 + 5min LRU）→ L3 规则兜底。
网络失败 / `DISABLE_JEV_REMOTE=1` / `NODE_ENV=test` 走纯规则。

## 客户端

`lib/client.js` 挂 `conversation.composer.dock`，3s 轮询只读路由 `/api/auto-reasoning.effort`。
路由鉴权由宿主施加，插件不碰凭据。

## 测试

```powershell
node --test plugins/dsh-auto-reasoning/test/*.test.js   # 13 例
```
