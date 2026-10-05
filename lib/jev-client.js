/**
 * Jev 1.13 SystemOne 语义决策客户端（零外部依赖，Node 18+ 原生 fetch）。
 *
 * 架构：
 *  - 主通道：OpenCode Zen 免费通道（opencode.ai/zen/v1/systemone, jev-1.13-free）
 *  - 备用通道：OpenRouter 官方通道（openrouter.ai/api/v1/systemone, typesafe/jev-1.13）
 *             单次计费 ≈ $0.000014。主通道遭遇 429 限流或网络异常时自动平滑切换！
 *             （与 tools/jev_suite/core/client.py 的双通道设计完全对齐）
 */

import { execSync } from 'node:child_process';

export const DEFAULT_ENDPOINT = 'https://opencode.ai/zen/v1/systemone';
export const DEFAULT_MODEL = 'jev-1.13-free';
export const FALLBACK_ENDPOINT = 'https://openrouter.ai/api/v1/systemone';
export const FALLBACK_MODEL = 'typesafe/jev-1.13';
export const DEFAULT_TIMEOUT_MS = 3500;

let cachedFallbackKey = null;

/**
 * 从 `reg query` 的输出里抽出值。抽成独立函数是为了可单测（不真的执行 reg）。
 * @returns {string} 未命中返回空串
 */
export function parseRegQueryValue(output) {
  const m = String(output ?? '').match(/OPENROUTER_API_KEY\s+REG_\w+\s+(.+)/);
  return m && m[1] ? m[1].trim() : '';
}

/**
 * 备用通道密钥的**纯**解析逻辑（无副作用，便于单测覆盖四条分支）。
 *
 * 顺序：`JEV_FALLBACK_API_KEY` → `OPENROUTER_API_KEY` → Windows 注册表。
 * 显式专用变量排在通用变量之前，因为专用变量是「就想覆盖这一个通道」的意图表达。
 *
 * @param {{env?: object, platform?: string, readRegistry?: () => string}} [deps]
 */
export function pickFallbackKey(deps = {}) {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const readRegistry = deps.readRegistry;

  if (env.JEV_FALLBACK_API_KEY) return env.JEV_FALLBACK_API_KEY;
  if (env.OPENROUTER_API_KEY) return env.OPENROUTER_API_KEY;

  // Windows 用户级环境变量可能晚于 DSH 进程启动才写入，此时 process.env 是旧快照。
  // 读注册表拿实时值 —— 这也是本机唯一能绕开「DSH 子进程环境被 scrub」的路径
  // （见 ~/.dsh/AGENTS.md 该条）。非 Windows 无此机制，直接放弃。
  if (platform === 'win32' && typeof readRegistry === 'function') {
    try {
      return parseRegQueryValue(readRegistry());
    } catch {
      return '';
    }
  }
  return '';
}

/** 真实注册表读取（带超时，避免阻塞宿主事件循环）。 */
function readUserEnvRegistry() {
  return execSync('reg query HKCU\\Environment /v OPENROUTER_API_KEY', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2000,
  });
}

/**
 * 获取备用通道的 API Key（进程内缓存，只探测一次）。
 * @returns {string} 未配置返回空串 —— 调用方据此**静默禁用**备用通道，不报错。
 */
export function resolveFallbackApiKey() {
  if (cachedFallbackKey === null) {
    cachedFallbackKey = pickFallbackKey({ readRegistry: readUserEnvRegistry });
  }
  return cachedFallbackKey;
}

/** 仅供测试：清掉进程内缓存，让 pickFallbackKey 重新探测。 */
export function __resetFallbackKeyCache() {
  cachedFallbackKey = null;
}

/**
 * SystemOne 的分档 criteria —— 2026-10-05 按两家官方文档重写。
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

/** FNV-1a 32 位哈希 —— 把任意长度的 prompt 压成定长键。 */
export function hashPrompt(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${(h >>> 0).toString(36)}-${text.length.toString(36)}`;
}

/** 构造缓存键：完整 prompt 参与哈希，不做长度截断。 */
export function buildCacheKey(endpoint, model, prompt) {
  return `${endpoint}:${model}:${hashPrompt(prompt)}`;
}

/**
 * 单次 HTTP 请求单个 SystemOne 通道
 */
async function callSystemOneChannel({ endpoint, model, key, state, timeoutMs }) {
  const payload = JSON.stringify({
    model,
    state: state.slice(0, 1500),
    questions: {
      effort: {
        type: 'choice',
        instructions: '根据任务内容判断解决该问题所需的思考推理深度与计算复杂度',
        criteria: EFFORT_CRITERIA,
      },
    },
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'User-Agent': 'dsh-auto-reasoning/0.1.0',
  };
  if (key) {
    headers['Authorization'] = `Bearer ${key}`;
  }

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: payload,
      signal: controller.signal,
    });
    if (!resp.ok) return null;

    const data = await resp.json();
    const ans = data?.answers?.effort;
    if (!ans || typeof ans.choice !== 'string') return null;

    return {
      choice: ans.choice,
      confidence: typeof ans.confidence === 'number' ? ans.confidence : 1.0,
      probabilities: ans.probabilities,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 调用 Jev SystemOne 判断任务所需的思考强度（支持主备双通道无缝切换）。
 * @returns {Promise<null | {tier: string, confidence: number, reason: string, probabilities?: object, source: string}>}
 */
export async function queryJevReasoningEffort(prompt, options = {}) {
  const trimmed = String(prompt ?? '').trim();
  if (!trimmed) return null;

  const primaryEndpoint = options.endpoint || process.env.JEV_ENDPOINT || DEFAULT_ENDPOINT;
  const primaryModel = options.model || process.env.JEV_MODEL || DEFAULT_MODEL;
  const primaryKey = options.apiKey || process.env.JEV_API_KEY || '';
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  const fallbackEndpoint = options.fallbackEndpoint || process.env.JEV_FALLBACK_ENDPOINT || FALLBACK_ENDPOINT;
  const fallbackModel = options.fallbackModel || process.env.JEV_FALLBACK_MODEL || FALLBACK_MODEL;
  const fallbackKey = options.fallbackApiKey || resolveFallbackApiKey();

  // 查缓存（以统一的 systemone 逻辑键做命中，避免通道切换时缓存失效）
  // 缓存键取**主通道的配置身份**，而不是实际应答的那个通道：
  //   · 同一份配置 + 同一 prompt，无论这次是主通道还是备用通道答的，都该命中同一条 ——
  //     两个通道都是 Jev 1.13 SystemOne，语义等价，按通道分键会让备用通道每次都 miss；
  //   · 但配置被显式改过（指向别的 Jev 部署 / 别的 criteria）时必须分键，否则会串味。
  const cacheKey = buildCacheKey(primaryEndpoint, primaryModel, trimmed);
  const cached = decisionCache.get(cacheKey);
  if (cached) {
    if (Date.now() < cached.expiresAt) return { ...cached.result };
    decisionCache.delete(cacheKey);
  }

  // 构造尝试序列
  const channels = [
    { endpoint: primaryEndpoint, model: primaryModel, key: primaryKey, isFallback: false },
  ];
  if (fallbackKey && fallbackEndpoint && fallbackEndpoint !== primaryEndpoint) {
    channels.push({ endpoint: fallbackEndpoint, model: fallbackModel, key: fallbackKey, isFallback: true });
  }

  for (const ch of channels) {
    const ans = await callSystemOneChannel({
      endpoint: ch.endpoint,
      model: ch.model,
      key: ch.key,
      state: trimmed,
      timeoutMs,
    });

    if (ans) {
      const tier = ans.choice;
      const result = {
        tier,
        confidence: ans.confidence,
        reason: `jev1.3_choice_${tier}${ch.isFallback ? '_fallback' : ''}`,
        probabilities: ans.probabilities,
        source: ch.isFallback ? 'jev-model-fallback' : 'jev-model',
      };

      if (decisionCache.size >= MAX_CACHE_SIZE) {
        const oldest = decisionCache.keys().next().value;
        if (oldest !== undefined) decisionCache.delete(oldest);
      }
      decisionCache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
      return result;
    }
  }

  return null;
}
