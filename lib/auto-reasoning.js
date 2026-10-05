/**
 * 自动思考程度双阶决策引擎（L1 规则 + L2 Jev SystemOne 语义 + L3 规则兜底）。
 *
 * 从 dsh-plugin-codemode/src/auto-reasoning.ts 原样迁出（TS → JS，行为零改动）。
 */

import { queryJevReasoningEffort } from './jev-client.js';

/** 确定性复杂度评分（1-10）。 */
export function scoreTaskComplexity(prompt) {
  const p = String(prompt ?? '').toLowerCase();

  // 1. 最高危特征 (9) -> 并发/死锁/资金风控/底层状态机
  if (
    /(并发|竞态|死锁|race condition|deadlock|状态机|state machine|资金安全|风控|清算|爆仓|liquidation|杠杆|leverage|逆向合约|inverse contract)/i.test(p)
  ) {
    return { score: 9, reason: 'concurrency_or_risk_critical' };
  }

  // 2. 深度推导特征 (7) -> 算法/推导/重构/排障/回测/滑点
  if (
    /(算法|algorithm|优化|optimize|推导|证明|数学|formula|重构|refactor|memory leak|内存泄漏|core dump|崩溃|crash|perf|性能调优|回测|backtest|vwap|almgren|滑点|slippage|波动率|volatility|方差|covariance)/i.test(p)
  ) {
    return { score: 7, reason: 'algorithmic_or_deep_refactor' };
  }

  // 3. 常规开发特征 (5)
  if (
    /(测试|test|编写|实现|implement|bug|修复|fix|审查|review|函数|function|脚本|script|组件|component|配置|config)/i.test(p)
  ) {
    return { score: 5, reason: 'standard_development_task' };
  }

  // 4. 低危日常 (2)
  return { score: 2, reason: 'routine_lookup_or_query' };
}

const TIER_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * 按模型实际支持的阶梯投影出合法档位。
 * 阶梯顺序由调用方从 `llm.resolveModelInfo()` 取，不假设固定排列。
 */
export function projectEffortOntoLadder(score, availableEfforts = ['low', 'medium', 'high']) {
  if (!Array.isArray(availableEfforts) || availableEfforts.length === 0) {
    return { target: 'medium', tier: 'medium' };
  }
  if (availableEfforts.length === 1) {
    return { target: availableEfforts[0], tier: availableEfforts[0] };
  }

  let desiredTier = 'medium';
  if (score <= 1) desiredTier = 'minimal';
  else if (score <= 3) desiredTier = 'low';
  else if (score <= 6) desiredTier = 'medium';
  else if (score <= 8) desiredTier = 'high';
  else desiredTier = 'max';

  // 从高到低找第一个可用的近似档，保证「想要 high 就绝不给 medium」。
  const wantIndex = TIER_ORDER.indexOf(desiredTier);
  for (let i = wantIndex; i >= 0; i--) {
    if (availableEfforts.includes(TIER_ORDER[i])) {
      return { target: TIER_ORDER[i], tier: TIER_ORDER[i] };
    }
  }
  // 阶梯里没有一条标准档（模型自造档位名）→ 按位置插值。
  const ratio = Math.max(0, Math.min(1, (score - 1) / 9));
  const index = Math.min(availableEfforts.length - 1, Math.max(0, Math.floor(ratio * availableEfforts.length)));
  const matched = availableEfforts[index];
  return { target: matched, tier: matched };
}

/** SystemOne 返回的 tier → 复杂度分值。 */
function tierToScore(tier) {
  switch (tier) {
    case 'max':
      return 10;
    case 'xhigh':
      return 9;
    case 'high':
      return 8;
    case 'medium':
      return 5;
    case 'low':
      return 2;
    case 'minimal':
      return 1;
    default:
      return 5;
  }
}

/** 同步决策链路（纯规则，供单测与网络禁用时使用）。 */
export function decideReasoningEffort(prompt, availableEfforts = ['low', 'medium', 'high']) {
  const { score, reason } = scoreTaskComplexity(prompt);
  const { target, tier } = projectEffortOntoLadder(score, availableEfforts);
  return { score, tier, reason, matchedEffort: target, source: 'rule' };
}

/** 异步决策链路：优先 SystemOne 语义，超时/异常无缝回落规则引擎。 */
export async function decideReasoningEffortAsync(prompt, availableEfforts = ['low', 'medium', 'high'], jevOptions) {
  const trimmed = String(prompt ?? '').trim();
  if (!trimmed || trimmed.length < 4) {
    return decideReasoningEffort(prompt, availableEfforts);
  }
  if (process.env.NODE_ENV === 'test' || process.env.DISABLE_JEV_REMOTE === '1') {
    return decideReasoningEffort(prompt, availableEfforts);
  }

  try {
    const jevRes = await queryJevReasoningEffort(trimmed, jevOptions);
    if (jevRes && jevRes.tier) {
      const score = tierToScore(jevRes.tier);
      const { target, tier } = projectEffortOntoLadder(score, availableEfforts);
      return {
        score,
        tier,
        reason: jevRes.reason,
        matchedEffort: target,
        source: 'jev-model',
        confidence: jevRes.confidence,
      };
    }
  } catch {
    // 静默降级
  }

  return decideReasoningEffort(prompt, availableEfforts);
}
