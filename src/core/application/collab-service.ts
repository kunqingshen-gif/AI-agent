import type { ScreenId } from '@shared/types';
import { SCREENS } from '@shared/screens';
import type { ClockPort, TelemetryPort } from '../ports';
import {
  closeCollab,
  collabTelemetry,
  isCollabExpired,
  joinCollab,
  openCollab,
  pushHint,
  type CollabResult,
  type CollabTicket,
} from '../domain/collab';

/**
 * 协办码的存放与生命周期。
 *
 * 从 AssistService 里独立出来，是因为「谁能看到、能说几句、多久失效」是一整块
 * 与办事引导无关的规则：它只依赖「老人此刻在哪一屏」这一个输入，不该和
 * 意图识别、计划校验缠在同一个类里。
 *
 * 边界照旧写在 domain：CollabHint 只有 text，没有控件 id；
 * 这里只负责存取与留痕，不参与任何「代按」。
 */

export interface CollabSessionView {
  screenTitle: string;
  taskTitle: string | null;
}

export class CollabService {
  private readonly tickets = new Map<string, CollabTicket>();

  constructor(
    private readonly clock: ClockPort,
    private readonly telemetry: TelemetryPort,
    /** 由会话层提供「他现在在哪一页」，避免这里去翻会话 Map */
    private readonly viewOf: (sessionId: string) => CollabSessionView,
  ) {}

  /**
   * 生成或复用协办码。
   *
   * 复用是有意的：老人点两次「叫人帮我」不该出现两个码，
   * 否则家属拿到的那个可能是旧的。
   */
  open(sessionId: string): CollabTicket {
    const now = this.clock.now();

    for (const [code, ticket] of this.tickets) {
      if (isCollabExpired(ticket, now) || ticket.status === 'closed') this.tickets.delete(code);
    }
    const existing = [...this.tickets.values()].find((ticket) => ticket.sessionId === sessionId);
    if (existing) return existing;

    const view = this.viewOf(sessionId);
    const ticket = openCollab({
      sessionId,
      screenTitle: view.screenTitle,
      taskTitle: view.taskTitle,
      now,
    });
    this.tickets.set(ticket.code, ticket);
    this.telemetry.record(collabTelemetry(ticket, 'open', now));
    return ticket;
  }

  join(code: string, helper: string): CollabResult<CollabTicket> {
    const ticket = this.tickets.get(code.trim().toUpperCase());
    if (!ticket) {
      return { ok: false, reason: '没找到这个协办码。让老人再念一遍，或者重新生成一个。' };
    }
    const now = this.clock.now();
    const result = joinCollab(ticket, helper, now);
    if (result.ok) {
      this.tickets.set(result.value.code, result.value);
      this.telemetry.record(collabTelemetry(result.value, 'join', now));
    }
    return result;
  }

  hint(code: string, text: string): CollabResult<CollabTicket> {
    const ticket = this.tickets.get(code.trim().toUpperCase());
    if (!ticket) return { ok: false, reason: '没找到这个协办码。' };
    const now = this.clock.now();
    const result = pushHint(ticket, text, now);
    if (result.ok) {
      this.tickets.set(result.value.code, result.value);
      this.telemetry.record(collabTelemetry(result.value, 'hint', now));
    }
    return result;
  }

  close(code: string): CollabResult<CollabTicket> {
    const ticket = this.tickets.get(code.trim().toUpperCase());
    if (!ticket) return { ok: false, reason: '没找到这个协办码。' };
    const closed = closeCollab(ticket);
    this.tickets.set(closed.code, closed);
    this.telemetry.record(collabTelemetry(closed, 'close', this.clock.now()));
    return { ok: true, value: closed };
  }

  /**
   * 家人看到的「他现在在哪一页」由引导流程顺带更新，不需要额外调用。
   * 只对仍然有效的票根更新，过期的不再维护。
   */
  syncScreen(sessionId: string, screenId: ScreenId): void {
    const now = this.clock.now();
    for (const ticket of this.tickets.values()) {
      if (ticket.sessionId !== sessionId || ticket.status === 'closed') continue;
      if (isCollabExpired(ticket, now)) continue;
      const title = SCREENS[screenId]?.title;
      if (title && title !== ticket.screenTitle) {
        this.tickets.set(ticket.code, { ...ticket, screenTitle: title });
      }
    }
  }
}
