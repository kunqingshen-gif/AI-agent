import type { FeedbackVerdict, SessionMetrics } from '@shared/types';
import type { ClockPort, TelemetryPort } from '../ports';
import type { SessionState } from './session-store';

/**
 * 反馈与指标。
 *
 * 单独一块的理由：它是产品唯一能从「用户嘴上」拿到的质量信号，
 * 读写的东西（会话计数器、分档计数、埋点）与引导逻辑完全不同。
 * 放在 AssistService 里时，每加一个问题都要在 1400 行里翻半天。
 */
export class MetricsService {
  /**
   * 反馈分档计数（进程内）。
   *
   * 为什么不从埋点 JSONL 重算：埋点按 type 计数，不区分 verdict。
   * 这里单独记一份，代价是一个对象，换来 `/api/metrics` 能直接回答
   * 「有多少人说它错了」——这是目前唯一能进答辩材料的质量指标。
   */
  private readonly tally: Record<FeedbackVerdict, number> = { worked: 0, failed: 0, wrong: 0 };

  constructor(
    private readonly clock: ClockPort,
    private readonly telemetry: TelemetryPort,
  ) {}

  /** 一次会话的实时计数器（不含分档反馈） */
  of(session: SessionState): SessionMetrics {
    return {
      stepsGuided: session.stepsGuided,
      wrongTurns: session.wrongTurns,
      guardrailsTriggered: session.guardrailsTriggered,
      handoffs: session.handoffs,
      elapsedMs: this.clock.now() - session.startedAt,
      completed: session.finished,
      baselineSteps: session.flow?.baselineSteps ?? 0,
      baselineMs: session.flow?.baselineMs ?? 0,
      ...(session.feedback ? { feedback: session.feedback } : {}),
    };
  }

  /**
   * 记录用户对办件结果的反馈。
   *
   * 在此之前，产品对「自己办得对不对」是完全没有信号的——
   * 提示词、知识库、事项库只能靠开发者拍脑袋改。有了这三档反馈，
   * 「它说错了」的占比才第一次成为一个可观测的指标。
   *
   * 三个字段一起记：反馈本身、当时的任务、以及走偏/拦截次数——
   * 因为「没办成」的原因往往不在最后一步，而在前面的某次误判。
   */
  recordFeedback(session: SessionState, verdict: FeedbackVerdict, note?: string): SessionMetrics {
    /* 改主意时先撤掉上一次的计数：分档统计只反映当前结论，不重复计人头 */
    if (session.feedback) this.tally[session.feedback] = Math.max(0, this.tally[session.feedback] - 1);
    this.tally[verdict] += 1;
    session.feedback = verdict;
    this.telemetry.record({
      type: 'feedback.given',
      sessionId: session.id,
      at: this.clock.now(),
      payload: {
        verdict,
        taskId: session.intent?.taskId ?? session.flow?.taskId ?? null,
        stepsGuided: session.stepsGuided,
        wrongTurns: session.wrongTurns,
        guardrailsTriggered: session.guardrailsTriggered,
        /* 备注只留前 200 字：这是埋点不是工单，不需要全文 */
        note: note?.slice(0, 200) ?? null,
      },
    });
    return this.of(session);
  }

  /**
   * 质量指标：有多少人办了、有多少人说它错了。
   *
   * `wrongRate` 是这套指标里最有用的一个数——它直接指向「该改提示词还是该改事项库」。
   * 分母是「给过反馈的人数」，不是「全部会话」：没反馈的人不代表满意，不能算作成功。
   */
  quality(): { total: number; worked: number; failed: number; wrong: number; wrongRate: number } {
    const { worked, failed, wrong } = this.tally;
    const total = worked + failed + wrong;
    return { total, worked, failed, wrong, wrongRate: total > 0 ? +(wrong / total).toFixed(3) : 0 };
  }
}
