import type { TelemetryEvent } from '../ports';

/**
 * 协办码：把「懂的人」叫到现场，而不是让 AI 假装懂。
 *
 * 现有政务 App 的代办是「授权 + 代操作」：老人把账号交给子女，之后发生的每件事
 * 老人都不知道。本产品反过来——老人始终握着手机，家人只被允许「看见」和「说一句」。
 *
 * 这个边界写在类型里，不是写在文案里：
 *   CollabHint 只有 text，没有 controlId，也没有 action。
 *   家人发不出「点提交」这种指令，代按在数据层面就不存在。
 * 支付、人脸、授权协议仍由本人完成，护栏不因为「家人在线」而放宽。
 */

export interface CollabHint {
  at: number;
  from: string;
  text: string;
}

export type CollabStatus = 'waiting' | 'joined' | 'closed';

export interface CollabTicket {
  code: string;
  sessionId: string;
  createdAt: number;
  expiresAt: number;
  status: CollabStatus;
  /** 接入的家人称呼，如「女儿」 */
  helper: string | null;
  /** 家人能看到老人当前在哪一页——只读，不能改 */
  screenTitle: string;
  taskTitle: string | null;
  hints: CollabHint[];
}

export type CollabResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/** 去掉了 0/O、1/I 这类在电话里念不清的字符——老人是靠嘴把码报给子女的 */
const CODE_ALPHABET = '23456789ACDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;
export const COLLAB_TTL_MS = 10 * 60 * 1000;
export const MAX_HINTS = 5;
export const MAX_HINT_LENGTH = 40;

export function generateCollabCode(rand: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    const index = Math.floor(rand() * CODE_ALPHABET.length) % CODE_ALPHABET.length;
    code += CODE_ALPHABET[index] ?? '2';
  }
  return code;
}

export function openCollab(input: {
  sessionId: string;
  screenTitle: string;
  taskTitle: string | null;
  now?: number;
  rand?: () => number;
}): CollabTicket {
  const now = input.now ?? Date.now();
  return {
    code: generateCollabCode(input.rand),
    sessionId: input.sessionId,
    createdAt: now,
    expiresAt: now + COLLAB_TTL_MS,
    status: 'waiting',
    helper: null,
    screenTitle: input.screenTitle,
    taskTitle: input.taskTitle,
    hints: [],
  };
}

export function isCollabExpired(ticket: CollabTicket, now: number = Date.now()): boolean {
  return now > ticket.expiresAt;
}

/**
 * 还剩多久，毫秒；过期后返回 0（不返回负数）。
 *
 * 界面要把它念成一个具体的数——「还剩 9 分 12 秒」比「十分钟内有效」有用，
 * 老人不需要自己算从生成到现在过了多久。
 */
export function collabRemainingMs(ticket: CollabTicket, now: number = Date.now()): number {
  return Math.max(0, ticket.expiresAt - now);
}

/** 过期后统一用这一句：说清为什么不行，再给一条出路 */
export const COLLAB_EXPIRED_REASON = '这个协办码过期了（生成后十分钟内有效）。请老人重新生成一个，再念给您。';

export function joinCollab(ticket: CollabTicket, helper: string, now: number = Date.now()): CollabResult<CollabTicket> {
  if (ticket.status === 'closed') return { ok: false, reason: '这次协办已经结束了，需要重新生成一个码。' };
  if (isCollabExpired(ticket, now)) return { ok: false, reason: COLLAB_EXPIRED_REASON };
  if (ticket.status === 'joined') return { ok: true, value: ticket };
  return { ok: true, value: { ...ticket, status: 'joined', helper } };
}

/**
 * 家人发来的一条提示。
 *
 * 注意这里没有任何「执行」参数：这条提示只会出现在老人屏幕上，
 * 是否照做仍由老人自己决定、自己按。这就是「陪办」与「代办」的分界。
 */
export function pushHint(ticket: CollabTicket, text: string, now: number = Date.now()): CollabResult<CollabTicket> {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return { ok: false, reason: '提示不能是空的。' };
  if (clean.length > MAX_HINT_LENGTH) return { ok: false, reason: `一次最多 ${MAX_HINT_LENGTH} 个字，说短一点老人更好懂。` };
  if (ticket.status === 'waiting') return { ok: false, reason: '家人还没接入，先把码告诉他。' };
  if (ticket.status === 'closed') return { ok: false, reason: '这次协办已经结束了。' };
  /* 过期后才想起发提示：以前只挡了「接入」，已接入的人可以一直发下去，时效形同虚设 */
  if (isCollabExpired(ticket, now)) return { ok: false, reason: COLLAB_EXPIRED_REASON };
  if (ticket.hints.length >= MAX_HINTS) return { ok: false, reason: `一次最多 ${MAX_HINTS} 条提示，多了老人会乱。` };

  const last = ticket.hints[ticket.hints.length - 1];
  if (last && last.text === clean) return { ok: true, value: ticket };

  return {
    ok: true,
    value: {
      ...ticket,
      hints: [...ticket.hints, { at: now, from: ticket.helper ?? '家人', text: clean }],
    },
  };
}

export function closeCollab(ticket: CollabTicket): CollabTicket {
  return { ...ticket, status: 'closed' };
}

/** 家人接入这件事要留痕：谁、什么时候、看到了哪一页。家属事后可查，监管也可查 */
export function collabTelemetry(ticket: CollabTicket, action: 'open' | 'join' | 'hint' | 'close', now: number): TelemetryEvent {
  return {
    type: 'collab.updated',
    sessionId: ticket.sessionId,
    at: now,
    payload: {
      action,
      code: ticket.code,
      status: ticket.status,
      helper: ticket.helper,
      screenTitle: ticket.screenTitle,
      hints: ticket.hints.length,
    },
  };
}
