// 自动思考深度客户端实时胶囊
//
// 挂到 DSH Web 的 conversation.composer.dock 插槽（输入框底栏，与影子盘状态条同级）。
// 档位由宿主侧 agent/request 瀑布决策，客户端只轮询只读路由 /api/auto-reasoning.effort。
//
// 会话隔离：决策在宿主侧按 sessionId 归档，这里把当前会话 id 作为查询参数带上，
// 否则多会话会共享同一条「最近一次」记录。
// 会话 id 取自对话根节点的 data-conversation-session 属性 —— 该属性由
// @deepseek-ai/dsh-client-ui-conversation 渲染，是客户端唯一可见的会话身份来源。
window.__ModuleLoader__.load({
  id: "dsh-auto-reasoning",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require("react");

    const T = {
      ink2: 'var(--dsw-alias-label-secondary)',
      green: 'var(--dsw-alias-state-success-primary)',
      amber: 'var(--dsw-alias-state-warn-primary)',
      red: 'var(--dsw-alias-state-error-primary)',
      purple: '#a855f7',
      blue: '#3b82f6',
    };

    const EFFORT_COLORS = [
      [/^(max|xhigh)$/, T.purple],
      [/^high$/, T.red],
      [/^medium$/, T.amber],
      [/^(low|minimal)$/, T.green],
    ];

    const colorFor = (level) => {
      const l = String(level || '').toLowerCase();
      for (const [re, c] of EFFORT_COLORS) if (re.test(l)) return c;
      return T.blue;
    };

    /** 当前会话 id；DOM 上没有（hero 态 / 加载中）时返回空串。 */
    const currentSessionId = () => {
      try {
        const el = document.querySelector('[data-conversation-session]');
        return el ? el.getAttribute('data-conversation-session') || '' : '';
      } catch {
        return '';
      }
    };

    const VIA_LABEL = {
      sentinel: '会话首次',
      echo: '每轮重评',
      orphan: '子代理接管',
    };

    const SKIP_LABEL = {
      'no-ladder': '模型无档位 · 回落默认',
      error: '决策异常 · 回落默认',
      'no-prompt': '取不到提示词 · 按 routine 评分',
    };

    const AutoEffortPill = () => {
      const [level, setLevel] = React.useState(null);
      const [score, setScore] = React.useState(null);
      const [detail, setDetail] = React.useState('');

      React.useEffect(() => {
        let cancelled = false;

        const poll = async () => {
          try {
            const sid = currentSessionId();
            const url = '/api/auto-reasoning.effort' + (sid ? '?sessionId=' + encodeURIComponent(sid) : '');
            const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
            if (!res.ok) return;
            const data = await res.json();
            if (cancelled || !data) return;

            const d = data.decision;
            if (d) {
              setLevel(d.effort);
              setScore(d.score);
              const via = VIA_LABEL[d.via] ? ` · ${VIA_LABEL[d.via]}` : '';
              if (d.skipped && !d.effort) {
                // 插件接管了，但没能产出档位：显式说出来，别让它看起来像「插件没挂」
                setDetail(`${d.model} · ${SKIP_LABEL[d.skipped] || d.skipped} · ${d.skippedDetail || ''}${via}`);
                return;
              }
              setDetail(
                `${d.model} · ${d.reason} · src=${d.source || '?'} · 阶梯 ${Array.isArray(d.ladder) ? d.ladder.join('/') : '-'}${via} · 会话 ${d.sessionId}` +
                  (d.skipped ? ` · ⚠ ${SKIP_LABEL[d.skipped] || d.skipped}` : '')
              );
              return;
            }
            setLevel(null);
            setScore(null);
            setDetail(
              data.enabled
                ? `已见 agent/request ${data.seen} 次 · 接管 ${data.takenOver || 0} 次 · 本会话尚无决策`
                : '插件未启用',
            );
          } catch {}
        };

        poll();
        const timer = setInterval(poll, 3000);
        return () => { cancelled = true; clearInterval(timer); };
      }, []);

      const color = colorFor(level);
      const label = level ? `Auto (${level})` : 'auto · 待接管';
      const text = label + (score == null ? '' : ` · ${score}/10`);

      return React.createElement(
        'div',
        {
          title: detail,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '2px 8px',
            borderRadius: 999,
            border: `1px solid ${color}44`,
            background: `color-mix(in srgb, ${color} 10%, transparent)`,
            marginRight: 8,
            maxWidth: 260,
          },
        },
        [
          React.createElement('span', {
            key: 'dot',
            style: {
              width: 6,
              height: 6,
              borderRadius: 999,
              background: color,
              flexShrink: 0,
              boxShadow: `0 0 6px ${color}`,
            },
          }),
          React.createElement(
            'span',
            {
              key: 'label',
              style: {
                fontSize: 11,
                fontWeight: 700,
                color,
                fontFamily: 'monospace',
                letterSpacing: '0.02em',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              },
            },
            text
          ),
        ]
      );
    };

    function apply(ctx) {
      const slots = ctx.get("slots");
      if (!slots) return;

      slots.inject('conversation.composer.dock', () =>
        slots.register(
          { name: 'conversation.composer.dock', id: 'auto-reasoning-pill', order: 5 },
          () => React.createElement(AutoEffortPill, null)
        )
      );
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
