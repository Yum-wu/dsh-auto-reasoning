/**
 * Jev 1.13 SystemOne 语义决策客户端（零外部依赖，Node 18+ 原生 fetch）。
 *
 * 从 dsh-plugin-codemode/src/jev-client.ts 原样迁出，仅改 User-Agent 与默认 endpoint 环境变量名。
 */

export const DEFAULT_ENDPOINT = 'https://opencode.ai/zen/v1/systemone';
export const DEFAULT_MODEL = 'jev-1.13-free';
export const DEFAULT_TIMEOUT_MS = 3500;

/** 内存 LRU 决策缓存：相同/高频任务 0ms 命中，避免每轮都打网络。 */
const decisionCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_SIZE = 100;

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

  const cacheKey = `${endpoint}:${model}:${trimmed.slice(0, 300)}`;
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
        criteria: {
          low: '简单问答、文件查看、语法查询、日志检索、打招呼',
          medium: '常规业务代码开发、Bug修改、简单功能实现、单测编写',
          high: '算法实现与调优、数学公式推导、复杂重构、架构设计、深度故障根因排查',
          max: '高危并发、分布式死锁、资金风控底层状态机、爆仓清算',
        },
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
