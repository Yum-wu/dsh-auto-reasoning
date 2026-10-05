/**
 * 自动思考程度双阶决策引擎（L1 规则 + L2 Jev SystemOne 语义 + L3 规则兜底）。
 *
 * 从 dsh-plugin-codemode/src/auto-reasoning.ts 原样迁出（TS → JS，行为零改动）。
 */

import { queryJevReasoningEffort } from './jev-client.js';

/** 确定性复杂度评分（1-10）。 */
export function scoreTaskComplexity(prompt) {
  const p = String(prompt ?? '').toLowerCase();

  // 1. 最高危特征 (9-10 -> max) -> 资金安全/并发死锁/跨模块彻底重构
  if (
    /(分布式死锁|死锁|爆仓|清算|资金安全|风控|底层状态机|状态机卡死|逆向合约|杠杆|重新设计整个|覆盖所有越权)/i.test(p) ||
    (/(重新设计|重构|算法).*(状态机|并发边界|鉴权|认证)/i.test(p))
  ) {
    return { score: 9, reason: 'concurrency_or_risk_critical' };
  }

  // 2. 深度审查、技术债、系统性调研、安全漏洞、长程迁移 (8 -> xhigh)
  if (
    /(安全审查|code review|安全审计|越权|注入|技术债|迁移方案|系统性调研|选型建议|架构级|性能剖析|内存持续增长)/i.test(p)
  ) {
    return { score: 8, reason: 'deep_research_or_audit' };
  }

  // 3. 算法、数学推导、深层性能、重构 (7 -> high)
  if (
    /(算法|algorithm|优化.*(算法|边界|插件)|推导|证明|数学|formula|重构|refactor|memory leak|内存泄漏|core dump|崩溃|crash|perf|性能调优|回测|backtest|vwap|almgren|滑点|slippage|波动率|volatility|方差|covariance|竞态|时序|异步.*顺序)/i.test(p)
  ) {
    return { score: 7, reason: 'algorithmic_or_deep_refactor' };
  }

  // 4. 先行低危工具执行过滤：跑命令、看一眼、查签名、grep、列出文件 (2 -> low)
  // 避免 "跑一下 npm test" / "看函数签名" 因包含 "test" / "函数" 被误抬到 medium
  if (
    /(跑一下|npm test|git status|grep|搜索.*清单|列出|看一眼|看一下|签名|哪一行|错别字|问内容|只是问|只回数字)/i.test(p)
  ) {
    return { score: 2, reason: 'tool_execution_or_quick_lookup' };
  }

  // 5. 常规开发特征 (5 -> medium)
  if (
    /(测试|test|编写|实现|implement|bug|修复|fix|审查|review|函数|function|脚本|script|组件|component|配置|config|校验|schema|csv|导出|分页|接口|开发|添加)/i.test(p)
  ) {
    return { score: 5, reason: 'standard_development_task' };
  }

  // 6. 默认日常 (2 -> low)
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
