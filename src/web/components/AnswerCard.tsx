import type { AnswerPayload } from '@shared/types';

interface Props {
  answer: AnswerPayload;
  /** 这件事能直接办时的事项标题 */
  taskTitle?: string;
  onStartTask?: () => void;
  onAskMore: () => void;
  onClose: () => void;
}

/**
 * 回答卡片。
 *
 * 与引导卡片并列，不互相顶替：老人问一句「高龄津贴要什么条件」，先得到答案；
 * 想去办，点一下「直接带着我办」就切换到引导通道——问答与办理由此连成一条路，
 * 而不是问完还得从头说一遍。
 */
export function AnswerCard({ answer, taskTitle, onStartTask, onAskMore, onClose }: Props) {
  return (
    <section className="card card-answer" aria-live="polite">
      <div className="card-head">
        <span className="answer-chip">政策问答</span>
        <span className={`source-chip source-${answer.source}`}>{answer.source === 'llm' ? '模型作答' : '知识库'}</span>
        <button className="link-btn answer-close" onClick={onClose} type="button" aria-label="收起回答">
          收起
        </button>
      </div>

      <p className="answer-text">{answer.text}</p>

      {answer.points.length > 0 && (
        <ul className="answer-points">
          {answer.points.map((point, index) => (
            <li key={`${point}-${index}`}>{point}</li>
          ))}
        </ul>
      )}

      <p className="answer-note">以上是通用说明，具体条件和金额以当地窗口公布为准。</p>

      <div className="guide-actions" role="group" aria-label="问答操作">
        {answer.relatedTaskId && onStartTask && (
          <button className="btn-soft btn-soft-accent" onClick={onStartTask} type="button">
            直接带着我办{taskTitle ? `：${taskTitle.length > 10 ? `${taskTitle.slice(0, 10)}…` : taskTitle}` : ''}
          </button>
        )}
        <button className="btn-soft" onClick={onAskMore} type="button">
          接着问
        </button>
      </div>
    </section>
  );
}
