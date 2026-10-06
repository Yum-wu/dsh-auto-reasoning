# dsh-auto-reasoning

> **English** | [简体中文](README.zh-CN.md)

**Auto Reasoning Effort for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).**  
Dynamically project each request's `reasoningEffort` onto the **target model's valid effort ladder** based on task complexity. Provides session-level sentinel `auto`, covering both top-level requests and delegated subagents.

- **Repository**: <https://github.com/Yum-wu/dsh-auto-reasoning>
- **Independent Repo**: Zero build steps, zero runtime dependencies, pure ESM.
- Before modifying code, read [AGENTS.md](AGENTS.md) — containing hard operational facts regarding silent fallback behaviors.

---

## Installation & Wiring

```powershell
# 1. Profile dependency (link pointing to this repo)
#    ~/.dsh/profiles/web/package.json
#      "dependencies": { "dsh-auto-reasoning": "link:C:/…/plugins/dsh-auto-reasoning" }
#      "dsh": { "profile": { "bundles": [ …, "dsh-auto-reasoning" ] } }

# 2. node_modules junction
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-auto-reasoning" `
  -Target "<Path to repo>\plugins\dsh-auto-reasoning"

# 3. Declaration line — ~/.dsh/profiles/web/cordis.patch.yml
#    - id: plugin-auto-reasoning
#      name: 'dsh-auto-reasoning'
#      config:
#        enabled: true
#        decisionCap: 50

# 4. Configure default model to use auto (agent-default-model reasoningEffort must be auto)
```

**Restart DSH to apply changes.** Always restart via Desktop "Service Console" (WMI launcher), **do not use `~/.dsh/restart-dsh.ps1`** directly in agent sessions (killing host process terminates tool returns).

> ⚠️ **Unloaded Plugin Behavior**: If the plugin is not loaded when `reasoningEffort: 'auto'` is used, `dsh-llm`'s `resolveCallWithInfo` throws `UNSUPPORTED_REASONING_EFFORT`, failing the entire LLM pipeline rather than silently falling back. Rollback by setting `reasoningEffort` back to a concrete tier (e.g. `max`).

---

## Verifying Active Operation

The client UI capsule docks in `conversation.composer.dock` (bottom composer bar), displaying e.g. `Auto (high) · 8/10`.  
Host read-only endpoint:

```
GET /api/auto-reasoning.effort?sessionId=<sid>
→ {"enabled":true,"seen":N,"takenOver":N,"lastIncoming":"…","lastOutgoing":"…",
   "lastTakeoverVia":"sentinel|echo|orphan","lastSkipReason":"…","decision":{…}}
```

If `takenOver: 0` and `lastIncoming` is a fixed tier, the sentinel was not intercepted. Verify:
1. `agent-default-model` has `reasoningEffort: auto`.
2. Whether the current session had a manually selected tier in the UI — the host post-picker (`dsh-agent/lib/index.js:181-192`) preserves UI selections persisted in session request headers. Changing config requires creating a new session.

---

## Architecture & Takeover Rules (`shouldTakeOver`)

| Via Mode | Condition | Meaning |
|---|---|---|
| `forced` | User explicitly enabled forced takeover | Overrides all UI manual selections |
| `sentinel` | `incoming === 'auto'` | Initial turn in session seeded from AgentOptions |
| `echo` | `incoming === last written effort` | Echo of our previous decision → re-evaluate per turn |
| `orphan` | `incoming === undefined` | Child subagent switched models and lost inherited effort |

**Subagent Awareness**: Automatically intercepts child subagents even when changing target models where host runtime strips inherited reasoning efforts (`orphan` mode).

---

## Soft Guidance Principle

Effort parameter serves as **soft guidance**, not absolute reasoning token length dictation:
- **Anthropic**: *"Claude's thinking is adaptive: the model evaluates each request and decides for itself whether to think and how much; effort acts as soft guidance; No level guarantees a thinking block on every request."*
- **OpenAI**: *"The models also reason adaptively across reasoning efforts, using fewer tokens for simpler tasks and thinking harder for complex tasks."*

Our testable contract verifies that mapped effort levels strictly fall within each model's declared legal spectrum (`off / minimal / low / medium / high / xhigh / max`), avoiding schema rejection.

---

## Testing & Calibration

```powershell
node --test test/*.test.js   # 48 test cases (dual-channel key resolution, default policies, ratchet bounds)
npm run bench                # Online benchmark (37 training + 22 held-out samples)
npm run bench:offline        # Offline rule engine fallback test
npm run bench:variance       # 6-run variance quantification
```

## License

MIT License.
