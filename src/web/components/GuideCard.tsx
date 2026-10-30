import type { GuideAction } from '@shared/types';
import { GUARDRAIL_COPY } from '@shared/types';

interface Props {
  action: GuideAction | null;
  loading: boolean;
  started: boolean;
  examples: string[];
  onExample: (text: string) => void;
  onSpeak: () => void;
  onPrefill: () => void;
  onRescue: () => void;
}

export function GuideCard({ action, loading, started, examples, onExample, onSpeak, onPrefill, onRescue }: Props) {
  if (!started) {
    return (
      <section className="card card-welcome">
        <h2>说一句话，办成一件事</h2>
        <p className="muted">
          老人不需要知道「在哪个 App 的第几层菜单」。说出要办的事，Agent 会读屏、拆步骤、一步步指到具体按钮上。
        </p>
        <div className="examples">
          {examples.map((text) => (
            <button key={text} className="example" onClick={() => onExample(text)} type="button">
              「{text}」
            </button>
          ))}
        </div>
      </section>
    );
  }

  if (!action) {
    return (
      <section className="card">
        <div className="card-head">
          <span className="card-title">正在读取屏幕…</span>
        </div>
      </section>
    );
  }

  const guardrail = action.guardrail ? GUARDRAIL_COPY[action.guardrail] : null;

  return (
    <section className={`card card-guide ${loading ? 'is-loading' : ''}`}>
      <div className="card-head">
        <span className="step-chip">{action.stepLabel}</span>
        <span className={`source-chip source-${action.source}`}>{action.source === 'llm' ? '模型生成' : '规则兜底'}</span>
        {action.progress.total > 0 && (
          <div className="progress">
            <div className="progress-bar" style={{ width: `${(action.progress.index / action.progress.total) * 100}%` }} />
          </div>
        )}
      </div>

      <p className="instruction">{action.instruction}</p>

      <div className="guide-actions">
        <button className="btn-soft" onClick={onSpeak} type="button">
          再听一遍
        </button>
        {action.prefill && action.fieldId && (
          <button className="btn-soft btn-soft-accent" onClick={onPrefill} type="button">
            自动填：{action.prefill.value.length > 12 ? `${action.prefill.value.slice(0, 6)}…` : action.prefill.value}
          </button>
        )}
        <button className="btn-soft" onClick={onRescue} type="button">
          我卡住了
        </button>
      </div>

      {guardrail && (
        <div className="guardrail">
          <div className="guardrail-head">
            <span className="guardrail-dot" />
            {guardrail.title}
          </div>
          <p>{guardrail.body}</p>
        </div>
      )}

      <details className="reason">
        <summary>AI 为什么这么判断</summary>
        <p className="reason-text">{action.reason}</p>
        <div className="reason-meta">
          <span>置信度 {action.confidence.toFixed(2)}</span>
          <span>响应 {action.latencyMs} ms</span>
          <span>{action.kind === 'back' ? '纠偏' : action.kind === 'human-confirm' ? '护栏拦截' : '继续引导'}</span>
        </div>
      </details>
    </section>
  );
}
