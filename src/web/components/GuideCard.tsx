import type { GuideAction } from '@shared/types';
import { GUARDRAIL_COPY } from '@shared/types';
import type { QuickTask } from '../zero';

interface Props {
  action: GuideAction | null;
  loading: boolean;
  started: boolean;
  examples: string[];
  /** 可以直接问的问题，与办事示例并列——让老人知道「问也行」 */
  questions?: string[];
  /** 常办事项大按钮：起手页不做输入框，只做「点一件」 */
  tasks?: QuickTask[];
  onExample: (text: string) => void;
  /** 起手页那个最大的按钮：按一下开始说话 */
  onMic?: () => void;
  onSpeak: () => void;
  onPrefill: () => void;
  onRescue: () => void;
}

function MicGlyph() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="2.5" width="6" height="11" rx="3" fill="currentColor" />
      <path d="M5.5 11.5a6.5 6.5 0 0013 0" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <path d="M12 18v3.2M8.6 21.4h6.8" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

export function GuideCard({
  action,
  loading,
  started,
  examples,
  questions = [],
  tasks = [],
  onExample,
  onMic,
  onSpeak,
  onPrefill,
  onRescue,
}: Props) {
  /*
   * 起手页。
   *
   * 这一屏是「零学习成本」的正面战场，所以它必须违反所有政务 App 的惯例：
   * 没有搜索框、没有九宫格、没有说明段落，只有一条路——按最大的那个按钮说话。
   *
   * 曾经这里是「一段介绍 + 三句示例」。介绍是写给评委看的，老人不会读；
   * 示例是句子，老人认不出自己属于哪一句。现在换成「事」本身：
   * 「低保复核 · 11月20日到期」老人一眼就知道是不是自己的事。
   */
  if (!started) {
    return (
      <section className="card card-welcome">
        <h2>您不用学，我带着您办</h2>
        <p className="welcome-sub">按一下，说要办什么，剩下的我一步一步指给您看。</p>

        <button className="welcome-mic" onClick={onMic} type="button">
          <MicGlyph />
          <span className="welcome-mic-text">按这里说话</span>
        </button>

        {tasks.length > 0 && (
          <>
            <p className="welcome-or">不方便说话？点一件您要办的事</p>
            <div className="welcome-tasks">
              {tasks.map((task) => (
                <button key={task.label} className="welcome-task" onClick={() => onExample(task.utterance)} type="button">
                  <span className="welcome-task-label">{task.label}</span>
                  <span className="welcome-task-hint">{task.hint}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {/* 说明文字不是给老人看的，收起来给评委看，别占老人的视界 */}
        <details className="welcome-why">
          <summary>它凭什么能带得动我</summary>
          <p className="muted">
            老人不需要知道「在哪个 App 的第几层菜单」。说出要办的事，Agent 会读屏、拆步骤、把下一步做成一个固定位置的大按钮；
            不清楚的政策也能直接问，问完想办一句话就能接着办。
          </p>
          <div className="examples">
            {examples.map((text) => (
              <button key={text} className="example" onClick={() => onExample(text)} type="button">
                「{text}」
              </button>
            ))}
          </div>
          {questions.length > 0 && (
            <>
              <p className="examples-label">或者直接问一句</p>
              <div className="examples">
                {questions.map((text) => (
                  <button key={text} className="example example-question" onClick={() => onExample(text)} type="button">
                    「{text}」
                  </button>
                ))}
              </div>
            </>
          )}
        </details>
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
    <section className={`card card-guide ${loading ? 'is-loading' : ''}`} aria-live="polite" aria-busy={loading}>
      <div className="card-head">
        <span className="step-chip">{action.stepLabel}</span>
        <span className={`source-chip source-${action.source}`}>{action.source === 'llm' ? '模型生成' : '规则兜底'}</span>
        {action.progress.total > 0 && (
          <div
            className="progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={action.progress.total}
            aria-valuenow={action.progress.index}
            aria-label="办理进度"
          >
            <div className="progress-bar" style={{ width: `${(action.progress.index / action.progress.total) * 100}%` }} />
          </div>
        )}
      </div>

      <p className="instruction">{action.instruction}</p>

      <div className="guide-actions" role="group" aria-label="可用操作">
        {action.speak ? (
          <button className="btn-soft" onClick={onSpeak} type="button" aria-label="再听一遍这条指引">
            再听一遍
          </button>
        ) : (
          <span className="text-mode" role="note">
            纯文字模式
          </span>
        )}
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
