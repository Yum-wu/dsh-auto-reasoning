# AGENTS.md — dsh-auto-reasoning

> 全局规则见 `~/.dsh/AGENTS.md`;本文件只写本插件特有、且**改错了会静默降级**的那些。

## 这是什么

DSH 插件（Cordis bundle）。把模型配置里的 `reasoningEffort: auto` 哨兵，换算成
**该模型自己的合法档位**。零构建、零依赖、纯 ESM。

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

三条接管判据（`sentinel` / `echo` / `orphan`）缺一不可，尤其第三条：
宿主 `dsh-subagent/lib/index.js:450` 在「路由变了且未显式指定档位」时执行
`delete resolved.reasoningEffort`，把父会话的 `auto` 哨兵一并删掉。
**删掉 `orphan` 分支 = 换模型的子代理彻底脱离 auto。**

用户**手选**的档位一律不接管（会持久化进 request header，进来时是具体档位）。
显式档位是调用方的明确意图，不要覆盖。

## 退出去向必须显式

`skipped: no-ladder | error | no-prompt` 三条都进决策对象并显示在 UI 胶囊上。
静默回落是排障灾难 ——「auto 没生效」时分不清是插件没挂、模型没档、还是决策崩了。

## 测试

```powershell
node --test test/*.test.js
```

18 例，覆盖哨兵合法性、三条接管判据、阶梯投影（降级 / xhigh / max / 空阶梯 / 单档）、
取数三条路与脏输入、三条退出去向。

改行为先改测试。测试是本插件唯一的回归防线（宿主不提供）。

## 边界

- **档位阶梯运行时现取**（`ctx.llm.resolveModelInfo`），**禁止硬编码任何模型的档位**。
  各模型真实档位由网关 `http://127.0.0.1:10100/v1/models` 的 `reasoning_efforts` 字段声明，
  那是 profile 配置方的事，不是本插件的。
- **不搬进 `dsh-jev-preset`**：那是纯提示词插件，无运行时 `ctx.on()` 注册能力，挂不上这个钩子。
- 客户端胶囊（`lib/client.js`）走宿主 `/api` 通道，**鉴权由宿主施加，插件不碰凭据**。