import { randomUUID } from 'node:crypto';
import type {
  FeedbackVerdict,
  Intent,
  ProfileMemory,
  ProfileMemoryView,
  ScreenId,
  SlotName,
  UserProfile,
} from '@shared/types';
import type { ClockPort, ProfileStorePort, SessionSnapshot, SessionSnapshotPort, TelemetryPort } from '../ports';
import type { TaskFlow } from '../domain/catalog';

/**
 * 会话与长期档案的存放。
 *
 * 从 AssistService 里独立出来，因为它管的是「这台手机上的这个人」——
 * 谁在建会话、会话多久淘汰、档案记了什么、什么时候忘掉。
 * 意图识别和路径规划不该关心这些，它们只该拿到一个 session 对象。
 */

export interface SessionState {
  id: string;
  profile: UserProfile;
  intent: Intent | null;
  flow: TaskFlow | null;
  completed: Set<string>;
  slots: Partial<Record<SlotName, string>>;
  screenId: ScreenId;
  startedAt: number;
  lastSeenAt: number;
  stepsGuided: number;
  wrongTurns: number;
  guardrailsTriggered: number;
  handoffs: number;
  finished: boolean;
  /** 用户对这一单的最终反馈；只记一次，后到的覆盖前一次（用户改主意是允许的） */
  feedback?: FeedbackVerdict;
  /**
   * 这台设备上的档案编号。为空表示「这次不留名」——
   * 不留名就只活在本次会话里，关掉即忘，这也是一种正当选择。
   */
  ownerId?: string;
  /** 本次档案是读回来的，还是刚建的（决定界面上显示「记得」还是「刚记下」） */
  profileSource?: 'stored' | 'session';
}

export interface SessionStoreOptions {
  /** 会话上限，超限淘汰最久未活跃的（默认 2000，实测约 2KB/会话） */
  maxSessions?: number;
  /** 长期档案存储；不传就是「没有记忆」 */
  profiles?: ProfileStorePort;
  /**
   * 会话快照落盘；不传就是纯内存。
   *
   * 落盘不是为了长期记忆，而是为了「接着上次办」扛住进程重启：
   * 老人办到一半、服务刚好重启，重新开始等于让他白办一遍。
   */
  snapshots?: SessionSnapshotPort;
  /** 会话里的默认档案（演示用的那位老人） */
  defaults: UserProfile;
  /** 档案改了之后，依赖档案的缓存必须作废 */
  onProfileChanged?: () => void;
}

const DEFAULT_MAX_SESSIONS = 2000;

export class SessionStore {
  /*
   * sessions 会单调增长（每次建会话 +1），长期运行（评委连续演示、部署后无人重启）
   * 会持续吃内存，因此按 LRU 封顶。Map 的迭代顺序即插入顺序，
   * delete + set 等于把键移到队尾。
   */
  private readonly sessions = new Map<string, SessionState>();

  constructor(
    private readonly clock: ClockPort,
    private readonly telemetry: TelemetryPort,
    private readonly options: SessionStoreOptions,
  ) {}

  private remember(session: SessionState): void {
    const max = this.options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.sessions.delete(session.id);
    this.sessions.set(session.id, session);
    while (this.sessions.size > max) {
      const oldest = this.sessions.keys().next();
      if (oldest.done) break;
      this.sessions.delete(oldest.value);
    }
  }

  get(id: string): SessionState | undefined {
    return this.sessions.get(id) ?? this.restore(id);
  }

  /**
   * 内存里没有 → 去盘上找。
   *
   * 懒加载：不扫描整个目录，只在这个 id 真的被访问时读一个文件。
   * 进程重启后第一次刷新页面，走的就是这条路径。
   */
  private restore(id: string): SessionState | undefined {
    const snapshot = this.options.snapshots?.load(id);
    if (!snapshot || snapshot.id !== id) return undefined;
    const session = fromSnapshot(snapshot);
    this.remember(session);
    return session;
  }

  /** 取不到就抛：路由层据此返回 404，而不是把 undefined 往下传 */
  require(id: string): SessionState {
    const session = this.sessions.get(id) ?? this.restore(id);
    if (!session) throw new Error(`会话不存在或已过期：${id}`);
    /* 命中即刷新 LRU 顺序，保证还在用的会话不会被新会话挤掉 */
    this.remember(session);
    return session;
  }

  /** 状态每变一次就落一次盘：崩溃丢的只是最后一次写入，不是整段办理过程 */
  private persist(session: SessionState): void {
    this.options.snapshots?.save(toSnapshot(session));
  }

  create(profile?: Partial<UserProfile>, memory?: { ownerId?: string; stored?: ProfileMemory }): SessionState {
    const now = this.clock.now();
    const session: SessionState = {
      id: randomUUID(),
      /*
       * 三层叠加，越靠后越可信：
       *   内置默认值 → 上次记住的档案 → 这次用户明确说的。
       * 反过来（拿记忆盖住用户这次的话）就会变成「您上次说您眼睛不好」这种自作聪明的纠正。
       */
      profile: { ...this.options.defaults, ...memory?.stored, ...profile },
      intent: null,
      flow: null,
      completed: new Set<string>(),
      slots: {},
      screenId: 'gov.home',
      startedAt: now,
      lastSeenAt: now,
      stepsGuided: 0,
      wrongTurns: 0,
      guardrailsTriggered: 0,
      handoffs: 0,
      finished: false,
      ...(memory?.ownerId ? { ownerId: memory.ownerId } : {}),
      profileSource: memory?.stored ? 'stored' : 'session',
    };
    this.remember(session);
    this.persist(session);
    this.telemetry.record({
      type: 'session.started',
      sessionId: session.id,
      at: now,
      payload: { region: session.profile.region, age: session.profile.age },
    });
    return session;
  }

  /*
   * ─────────────── 会话状态写入 ───────────────
   *
   * 状态字段的写入只允许走这里。读取方散在引导、意图、指标三块，
   * 写入点若不集中，排查「这一步是谁改的」就得满仓库找 `session.xxx =`。
   */

  /** 记一次来访：刷新活跃时间与当前屏幕（刷新页面后据此复原） */
  touch(session: SessionState, at: number, screenId: ScreenId): void {
    session.lastSeenAt = at;
    session.screenId = screenId;
    this.persist(session);
  }

  /** 合并前端带回的槽位；后到的同名字段覆盖先到的 */
  mergeSlots(session: SessionState, slots: Partial<Record<SlotName, string>>): void {
    session.slots = { ...session.slots, ...slots };
    this.persist(session);
  }

  /** 这一节点已走通 */
  markStep(session: SessionState, nodeId: string): void {
    session.completed.add(nodeId);
    this.persist(session);
  }

  /** 确定这一单要办什么：换事项即重开进度 */
  setIntent(session: SessionState, intent: Intent, flow: TaskFlow): void {
    session.intent = intent;
    session.flow = flow;
    session.slots = { ...intent.slots };
    session.completed = new Set<string>();
    session.finished = false;
    this.persist(session);
  }

  /** 办完；返回本次是否由未完成变为完成，调用方据此只记一次埋点 */
  markFinished(session: SessionState): boolean {
    if (session.finished) return false;
    session.finished = true;
    this.persist(session);
    return true;
  }

  /** 计数器 +1：stepsGuided / wrongTurns / guardrailsTriggered / handoffs */
  bumpMetric(
    session: SessionState,
    metric: 'stepsGuided' | 'wrongTurns' | 'guardrailsTriggered' | 'handoffs',
  ): void {
    session[metric] += 1;
    this.persist(session);
  }

  /** 记最终反馈；同一会话只保留最后一次结论（用户改主意是允许的） */
  setFeedback(session: SessionState, verdict: FeedbackVerdict): void {
    session.feedback = verdict;
    this.persist(session);
  }

  /**
   * 老人能看到「你到底记了我什么」。
   *
   * 这一条不是锦上添花：记忆型产品最该被追问的就是这句话。
   * 答不上来，等于要求老人凭信任交出自己的画像。
   */
  profileView(sessionId: string): ProfileMemoryView | null {
    const session = this.get(sessionId);
    if (!session) return null;
    const memory = toMemory(session.profile);
    const stored = session.ownerId ? this.options.profiles?.load(session.ownerId) : null;
    return {
      memory,
      source: stored ? 'stored' : 'session',
      ...(stored ? { updatedAt: stored.updatedAt, expiresAt: stored.expiresAt } : {}),
    };
  }

  /**
   * 老人自己改档案：改完立刻影响后面的措辞，不需要重开一次会话。
   *
   * 为什么要「立刻」：如果改完要等下一次进来才生效，用户唯一的感受是「它没听我的」。
   */
  updateMemory(
    sessionId: string,
    patch: ProfileMemory,
  ): { view: ProfileMemoryView; message: string } | null {
    const session = this.get(sessionId);
    if (!session) return null;

    const before = session.profile.digitalLiteracy;
    session.profile = { ...session.profile, ...patch };
    session.lastSeenAt = this.clock.now();

    /*
     * 措辞缓存必须整体作废。
     *
     * 缓存键里带了数字素养，所以「改了怎么讲」本来就命中不了旧条目；
     * 但年龄、独居与否也在提示词里，却不进键——那就会出现
     * 「说改成独居了，讲法还是按有人陪着讲的」。宁可全清，也不留这种半对。
     */
    this.options.onProfileChanged?.();

    const stored = session.ownerId ? this.options.profiles?.save(session.ownerId, toMemory(session.profile)) : null;
    if (stored && session.ownerId) session.profileSource = 'stored';
    this.persist(session);

    this.telemetry.record({
      type: 'profile.updated',
      sessionId,
      at: this.clock.now(),
      payload: {
        fields: Object.keys(patch).join(','),
        digitalLiteracy: session.profile.digitalLiteracy,
        persisted: Boolean(stored),
      },
    });

    return {
      view: this.profileView(sessionId) ?? { memory: toMemory(session.profile), source: 'session' },
      message:
        before !== session.profile.digitalLiteracy
          ? literacyAck(session.profile.digitalLiteracy)
          : '记住了。以后我就按这个跟您说话。',
    };
  }

  /** 忘掉我：删档案、断开关联，本次会话退回默认档案 */
  forgetMemory(sessionId: string): boolean {
    const session = this.get(sessionId);
    if (!session) return false;
    const removed = session.ownerId ? (this.options.profiles?.forget(session.ownerId) ?? false) : false;
    session.ownerId = undefined;
    session.profile = { ...this.options.defaults };
    session.profileSource = 'session';
    this.persist(session);
    this.options.onProfileChanged?.();
    this.telemetry.record({
      type: 'profile.forgotten',
      sessionId,
      at: this.clock.now(),
      payload: { removed },
    });
    return removed;
  }
}

/** 落盘前必须剔除的槽位：身份证号与手机号只该活在这一次办理的内存里 */
const SENSITIVE_SLOTS: ReadonlyArray<SlotName> = ['idCard', 'phone'];

function toSnapshot(session: SessionState): SessionSnapshot {
  const slots: Partial<Record<SlotName, string>> = {};
  for (const [key, value] of Object.entries(session.slots)) {
    if (!value || SENSITIVE_SLOTS.includes(key as SlotName)) continue;
    slots[key as SlotName] = value;
  }
  return {
    id: session.id,
    profile: session.profile,
    intent: session.intent,
    flow: session.flow,
    completed: [...session.completed],
    slots,
    screenId: session.screenId,
    startedAt: session.startedAt,
    lastSeenAt: session.lastSeenAt,
    stepsGuided: session.stepsGuided,
    wrongTurns: session.wrongTurns,
    guardrailsTriggered: session.guardrailsTriggered,
    handoffs: session.handoffs,
    finished: session.finished,
    ...(session.feedback ? { feedback: session.feedback } : {}),
    ...(session.ownerId ? { ownerId: session.ownerId } : {}),
    ...(session.profileSource ? { profileSource: session.profileSource } : {}),
  };
}

function fromSnapshot(snapshot: SessionSnapshot): SessionState {
  return {
    id: snapshot.id,
    profile: snapshot.profile,
    intent: snapshot.intent,
    flow: snapshot.flow,
    completed: new Set(snapshot.completed),
    slots: snapshot.slots,
    screenId: snapshot.screenId,
    startedAt: snapshot.startedAt,
    lastSeenAt: snapshot.lastSeenAt,
    stepsGuided: snapshot.stepsGuided,
    wrongTurns: snapshot.wrongTurns,
    guardrailsTriggered: snapshot.guardrailsTriggered,
    handoffs: snapshot.handoffs,
    finished: snapshot.finished,
    ...(snapshot.feedback ? { feedback: snapshot.feedback } : {}),
    ...(snapshot.ownerId ? { ownerId: snapshot.ownerId } : {}),
    ...(snapshot.profileSource ? { profileSource: snapshot.profileSource } : {}),
  };
}

/** 档案 → 可展示、可持久化的白名单视图；身份证号/手机号/收入在设计上就进不来 */
export function toMemory(profile: UserProfile): ProfileMemory {
  return {
    displayName: profile.displayName,
    age: profile.age,
    region: profile.region,
    digitalLiteracy: profile.digitalLiteracy,
    livingAlone: profile.livingAlone,
    ...(profile.hearingImpaired === undefined ? {} : { hearingImpaired: profile.hearingImpaired }),
  };
}

/** 改完怎么说回去：不能让老人改完还得自己猜「它听懂了没有」 */
export function literacyAck(level: UserProfile['digitalLiteracy']): string {
  if (level === 'low') return '记住了。以后我说话更慢、更短，字也给您放大。';
  if (level === 'medium') return '记住了。以后我少说两句，重点留着。';
  return '记住了。以后我直接说下一步点哪儿，不再啰嗦。';
}
