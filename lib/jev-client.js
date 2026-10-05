/**
 * Jev 1.13 SystemOne 语义决策客户端（零外部依赖，Node 18+ 原生 fetch）。
 *
 * 从 dsh-plugin-codemode/src/jev-client.ts 原样迁出，仅改 User-Agent 与默认 endpoint 环境变量名。
 */

export const DEFAULT_ENDPOINT = 'https://opencode.ai/zen/v1/systemone';
export const DEFAULT_MODEL = 'jev-1.13-free';
export const DEFAULT_TIMEOUT_MS = 3500;

/**
* SystemOne 的分档 criteria —— 2026-10-05 按两家官方文档重写。
*
* 旧版是我自己写的中文描述，漏了整整一类工作（tool-use / planning / search），
* 导致"读文件、跑工具、迭代验证"这类日常会话被抬到 medium，纯烧 token。
*
* 依据（2026-10-05 实测抓取的官方文档，非记忆）：
*  · OpenAI `reasoning.effort` 的 Best for 表：
*      low    = tool-use、planning、search、多步决策；数据分析、起草、执行导向编码
*      medium = 规划 / 复杂推理 / 判断；多数工作负载的默认
*      high   = 困难调试、深度规划；agentic coding、long-horizon research
*      xhigh  = 深度研究、异步长跑 agentic；security / code review
*      max    = 最复杂任务
*  · Anthropic「Steering thinking」的档位表：
*      low = 最小化思考，简单任务跳过；xhigh = suited to extended exploration；
*      max = 最愿意思考且【对思考长度无约束】
*
* 两家的共同点，务必记住：**effort 是软引导（soft guidance），不是硬开关。**
* Anthropic 原文 "acts as soft guidance"、"No level guarantees a thinking block on
* every request"；OpenAI "models reason adaptively across reasoning efforts"。
* 本插件做的是**设定倾向**，最终思考多少仍由模型自己逐请求决定 ——
* 这也解释了为何实测中某些档位的推理长度并不单调。
*/
export const EFFORT_CRITERIA = {
 low: '简单问答、文件查看、语法查询、日志检索；以及以工具调用为主的工作：跑命令、读写文件、搜索、常规规划、多步执行，以及执行导向的编码与起草',
 medium: '需要规划与判断的常规开发：实现功能、修 bug、写单元测试、数据分析；质量与可靠性比延迟更重要时',
 high: '困难调试、复杂算法实现与调优、数学公式推导、架构级重构、深度故障根因排查；agentic 编码与长程研究',
 xhigh: '深度研究与需要长时间运行的 agentic 任务；安全与代码审查；只有在实测评估显示有明确收益时才用这一档',
 max: '最复杂的任务：高危并发、分布式死锁、资金风控底层状态机、爆仓清算；以及跨模块算法重新设计、边界条件系统性重划这类需要跨文件推导与验证的创造性深度工作',
};

/** 内存 LRU 决策缓存：相同/高频任务 0ms 命中，避免每轮都打网络。 */
const decisionCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_SIZE = 100;

/**
 * FNV-1a 32 位哈希 —— 把任意长度的 prompt 压成定长键。
 *
 * 2026-10-05 修的缺陷：原键是 `${endpoint}:${model}:${prompt.slice(0, 300)}`，
 * **只看前 300 字符**。两个真实不同的任务只要开头 300 字相同（长会话里引用历史、
 * 模板化提问、系统注入都可能造成），就共用同一条缓存决策 —— 而这条决策恰恰是
 * **思考档位**：把「排查资金死锁」当成「今天天气」来定档，代价是实打实的
 * token 与判断质量，且**完全静默**，没有任何征兆。
 *
 * 改用全文哈希后，只有 prompt **完全相同**才命中缓存，语义正确。
 */
export function hashPrompt(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // 把长度一并混入：不同长度而低位碰撞的两条文本不会被误判为同一条
  return `${(h >>> 0).toString(36)}-${text.length.toString(36)}`;
}

/** 构造缓存键：完整 prompt 参与哈希，不做长度截断。 */
export function buildCacheKey(endpoint, model, prompt) {
  return `${endpoint}:${model}:${hashPrompt(prompt)}`;
}

/**
 * 调用 Jev SystemOne 判断任务所需的思考强度。
 * @returns {Promise<null | {tier: string, confidence: number, reason: string, probabilities?: object, source: string}>}
 */
export async function queryJevReasoningEffort(prompt, options = {}) {
  const trimmed = String(prompt ?? '').trim();
  if (!trimmed) return null;

  const endpoint = options.endpoint || process.env.JEV_ENDPOINT || DEFAULT_ENDPOINT;
  const model = options.model || process.env.JEV_MODEL || DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  const cacheKey = buildCacheKey(endpoint, model, trimmed);
  const cached = decisionCache.get(cacheKey);
  if (cached) {
    if (Date.now() < cached.expiresAt) return { ...cached.result };
    decisionCache.delete(cacheKey);
  }


const payload = JSON.stringify({
    model,
    state: trimmed.slice(0, 1500),
    questions: {
      effort: {
        type: 'choice',
        instructions: '根据任务内容判断解决该问题所需的思考推理深度与计算复杂度',
        criteria: EFFORT_CRITERIA,
      },
    },
  });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let resp;
    try {
      resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'User-Agent': 'dsh-auto-reasoning/0.1.0',
        },
        body: payload,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) return null;

    const data = await resp.json();
    const ans = data?.answers?.effort;
    if (!ans || typeof ans.choice !== 'string') return null;

    const tier = ans.choice;
    const result = {
      tier,
      confidence: typeof ans.confidence === 'number' ? ans.confidence : 1.0,
      reason: `jev1.3_choice_${tier}`,
      probabilities: ans.probabilities,
      source: 'jev-model',
    };

    if (decisionCache.size >= MAX_CACHE_SIZE) {
      const oldest = decisionCache.keys().next().value;
      if (oldest !== undefined) decisionCache.delete(oldest);
    }
    decisionCache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  } catch {
    return null;
  }
}
