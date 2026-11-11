import type {
  AssistRequest,
  FeedbackVerdict,
  FlowId,
  GuideAction,
  ScreenId,
  SessionMetrics,
  ProfileMemory,
  ProfileMemoryView,
  SlotName,
  TaskId,
  UserProfile,
} from '@shared/types';
import { SCREENS } from '@shared/screens';
import type { LlmPort, LlmStats, ProfileStorePort, TelemetryPort, ClockPort } from '../ports';
import { TASK_LIST } from '../domain/catalog';
import { decide } from '../domain/guide-engine';
import type { PreflightResult } from '../domain/preflight';
import type { LifeScan } from '../domain/lifecycle';
import type { ScamAssessment } from '../domain/scam';
import { type CollabResult, type CollabTicket } from '../domain/collab';
import { CollabService } from './collab-service';
import { ToolsService } from './tools-service';
import { MetricsService } from './metrics-service';
import { GuideService } from './guide-service';
import { InterpretService, type InterpretResult } from './interpret-service';
import { DEFAULT_PROMPTS, type PromptSet } from './prompts';
import { defaultProfile } from '@infra/config';
import type { Logger } from '@infra/logger';
import { SessionStore, type SessionState } from './session-store';
export type { SessionState };

/**
 * 应用层：编排「理解意图 → 生成计划 → 逐步引导 → 卡住救援」的完整闭环。
 *
 * 分层约定：
 *  - 已收录事项：路径由 catalog 的确定性流程图给出，模型只改措辞；
 *  - 未收录事项：路径由模型现场规划，但必须先过 domain/plan.ts 的屏幕契约与护栏校验，
 *    校验不过就退回「未收录」话术，绝不指一个不存在的按钮；
 *  - 措辞：模型生成后必须过 zod + 高危词过滤，失败即回退模板。
 * 三档合起来 = AI 真的在决策，但决策不能越过契约。
 */

/** 断点快照里「他办到哪了」的那一段，前端拿它显示「接着上次办」 */
export interface SessionResume {
  taskId: FlowId;
  taskTitle: string;
  stepLabel: string;
  index: number;
  total: number;
  finished: boolean;
}

/** 意图与规划已独立成 InterpretService，这里保留类型出口，调用方无需改导入 */
export type { InterpretResult } from './interpret-service';

const SIMULATED_PROFILE: UserProfile = {
  ...defaultProfile(),
  livingAlone: true,
  hearingImpaired: false,
};

export interface ServiceOptions {
  /** 会话上限，超限淘汰最久未活跃的（默认 2000，实测约 2KB/会话） */
  maxSessions?: number;
  /** 模型改写缓存上限（默认 500，覆盖 17 屏 × 节点 × 三档数字素养的常见组合） */
  maxRewriteCache?: number;
  /**
   * 提示词包。不传就用内置默认值。
   *
   * 注入而不是直接 import：这样「换成业务人员改过的那一版提示词」
   * 只是一次传参，不需要改代码、也不需要重建服务。
   */
  prompts?: PromptSet;
  /**
   * 长期档案存储。不传就是「没有记忆」——
   * 这样测试与无状态部署仍能跑，而记忆是可插拔的能力，不是必需品。
   */
  profiles?: ProfileStorePort;
}



export class AssistService {
  /*
   * 两个 Map 都会单调增长：sessions 每次建会话 +1，rewriteCache 每次改写 +1。
   * 长期运行（尤其是评委连续演示、或部署后无人重启）会持续吃内存，因此按 LRU 封顶。
   * Map 的迭代顺序即插入顺序，delete + set 等于把键移到队尾。
   */
  private readonly store: SessionStore;
  /** 协办码的存取与时效判断已独立成一块，这里只做转发 */
  private readonly collab: CollabService;
  /** 体检 / 日历 / 反诈：同属「替我看一眼」，与办事引导并列 */
  private readonly tools: ToolsService;
  /** 反馈分档与指标 */
  private readonly metricsSvc: MetricsService;
  /** 引导与救援：决策、措辞、求助话术 */
  private readonly guideSvc: GuideService;
  /** 意图与规划：办事 / 问答 / 管家路由，以及未收录事项的现场规划 */
  private readonly interpretSvc: InterpretService;

  /** 当前生效的提示词包；`version` 会进埋点，便于把「说错了」归因到某一版 */
  private readonly prompts: PromptSet;

  constructor(
    private readonly llm: LlmPort,
    private readonly telemetry: TelemetryPort,
    private readonly clock: ClockPort,
    private readonly logger: Logger,
    private readonly options: ServiceOptions = {},
  ) {
    this.prompts = options.prompts ?? DEFAULT_PROMPTS;
    this.store = new SessionStore(clock, telemetry, {
      ...(options.maxSessions === undefined ? {} : { maxSessions: options.maxSessions }),
      ...(options.profiles ? { profiles: options.profiles } : {}),
      defaults: SIMULATED_PROFILE,
      onProfileChanged: () => this.guideSvc.clearCache(),
    });
    this.collab = new CollabService(clock, telemetry, (sessionId) => {
      const session = this.store.get(sessionId);
      return {
        screenTitle: (session && SCREENS[session.screenId]?.title) || '手机桌面',
        taskTitle: session?.flow?.title ?? null,
      };
    });
    this.tools = new ToolsService(clock);
    this.metricsSvc = new MetricsService(clock, telemetry);
    this.guideSvc = new GuideService({
      store: this.store,
      llm,
      prompts: this.prompts,
      telemetry,
      clock,
      logger,
      ...(options.maxRewriteCache === undefined ? {} : { maxRewriteCache: options.maxRewriteCache }),
      onScreenChange: (sessionId, screenId) => this.collab.syncScreen(sessionId, screenId),
    });
    this.interpretSvc = new InterpretService({
      store: this.store,
      tools: this.tools,
      llm,
      prompts: this.prompts,
      telemetry,
      clock,
      logger,
      openCollab: (sessionId) => this.openCollabFor(sessionId),
      onScreenChange: (sessionId, screenId) => this.collab.syncScreen(sessionId, screenId),
    });
  }

  /**
   * 模型用量快照（tokens、延迟分位）。
   *
   * 转发自模型适配器：应用层不知道也不该知道「一次调用多少钱」，
   * 但要把这个数交给运维和答辩——所以只透传，不算账。
   */
  llmStats(): LlmStats | null {
    return this.llm.stats?.() ?? null;
  }

  /** 当前提示词版本，供 `/api/meta` 与埋点使用 */
  promptVersion(): string {
    return this.prompts.version;
  }


  /* ─────────────── 会话与档案（转到 SessionStore） ─────────────── */

  createSession(profile?: Partial<UserProfile>, memory?: { ownerId?: string; stored?: ProfileMemory }): SessionState {
    return this.store.create(profile, memory);
  }

  profileView(sessionId: string): ProfileMemoryView | null {
    return this.store.profileView(sessionId);
  }

  updateMemory(
    sessionId: string,
    patch: ProfileMemory,
  ): { view: ProfileMemoryView; message: string } | null {
    return this.store.updateMemory(sessionId, patch);
  }

  forgetMemory(sessionId: string): boolean {
    return this.store.forgetMemory(sessionId);
  }

  getSession(id: string): SessionState | undefined {
    return this.store.get(id);
  }

  /**
   * 断点快照：刷新页面后，前端凭它还原来那一页。
   *
   * 为什么要有它：老人最容易发生的不是「不会办」，而是「办到一半被打断」——
   * 有人敲门、手机没电、切出去接了个电话。从头再走一遍，他多半就不办了。
   * 会话本来就在服务端内存里，缺的只是「前端刷新后还记得刚才那个 sessionId」；
   * 这个接口把「他在第几步、哪一屏、办的是哪件事」一次说清，前端据此复原。
   *
   * 不返回表单里的身份证号等内容：快照只用于回到那一屏，敏感值仍由前端当下输入。
   */
  sessionSnapshot(id: string): {
    sessionId: string;
    profile: UserProfile;
    screenId: ScreenId;
    tasks: typeof TASK_LIST;
    memory: ProfileMemoryView | null;
    resume: SessionResume | null;
  } | null {
    const session = this.store.get(id);
    if (!session) return null;

    let resume: SessionResume | null = null;
    if (session.flow) {
      const decision = decide({
        flow: session.flow,
        screenId: session.screenId,
        slots: session.slots,
        completed: session.completed,
        attemptsOnScreen: 0,
        asksForHelp: false,
      });
      resume = {
        taskId: session.flow.taskId,
        taskTitle: session.flow.title,
        stepLabel: decision.stepLabel,
        index: decision.progress.index,
        total: decision.progress.total,
        finished: decision.completed,
      };
    }

    return {
      sessionId: id,
      profile: session.profile,
      screenId: session.screenId,
      tasks: TASK_LIST,
      memory: this.profileView(id),
      resume,
    };
  }

  /**
   * 开一次会话：带着这台设备上记住的档案进来。
   *
   * 「先读档案、再建会话」放在应用层而不是路由里：
   * 这是业务决定（记忆优先于默认值、但让位于用户这次明确说的话），
   * 换个入口（小程序、电话机器人）时不该重写一遍。
   */
  openSession(profile?: Partial<UserProfile>, ownerId?: string): SessionState {
    const stored = ownerId ? (this.options.profiles?.load(ownerId) ?? null) : null;
    const memory: { ownerId?: string; stored?: ProfileMemory } = {};
    if (ownerId) memory.ownerId = ownerId;
    if (stored) memory.stored = stored.memory;
    return this.createSession(profile, memory);
  }

  /** 对外暴露模型通道状态，用于 /healthz、/api/meta 与前端徽标 */
  get llmStatus(): { available: boolean; model: string; healthy: boolean; lastError?: string } {
    const health = this.llm.health ?? { available: this.llm.available, healthy: this.llm.available };
    return {
      available: health.available,
      model: this.llm.model,
      healthy: health.healthy,
      ...(health.lastError ? { lastError: health.lastError } : {}),
    };
  }

  listTasks() {
    return TASK_LIST;
  }

  /* ─────────────── 管家能力：四种，和办事引导并列 ─────────────── */

  /**
   * 办前体检：按指定事项出清单，未指定则按低保复核演示。
   *
   * 会话里正在办哪一件，由意图模块在 `InterpretService.buildTool` 里读取并传进来；
   * 这里刻意不做「智能猜事项」——猜错事项的体检比不做更糟，
   * 它会让人拿着一份不相干的清单去补材料。
   */
  preflight(taskId?: TaskId): PreflightResult | null {
    return this.tools.preflight(taskId);
  }

  /** 守护日历：把分散在各部门的时间点收成一张表 */
  lifecycle(): LifeScan {
    return this.tools.lifecycle();
  }

  /** 可疑话术判别 */
  scamOf(text: string): ScamAssessment {
    return this.tools.scam(text);
  }

  openCollabFor(sessionId: string): CollabTicket {
    this.requireSession(sessionId);
    return this.collab.open(sessionId);
  }

  joinCollabByCode(code: string, helper: string): CollabResult<CollabTicket> {
    return this.collab.join(code, helper);
  }

  hintByCode(code: string, text: string): CollabResult<CollabTicket> {
    return this.collab.hint(code, text);
  }

  closeCollabByCode(code: string): CollabResult<CollabTicket> {
    return this.collab.close(code);
  }

  /** 意图与规划已独立成 InterpretService，这里只做转发（保持对外方法名不变） */
  async interpret(sessionId: string, utterance: string): Promise<InterpretResult> {
    return this.interpretSvc.interpret(sessionId, utterance);
  }

  /** 口语填表也从意图模块走：它读的是同一套槽位白名单 */
  async extractSlots(
    sessionId: string,
    utterance: string,
    slotHint?: SlotName,
    label = '当前输入框',
  ): Promise<{ slots: Partial<Record<SlotName, string>>; confidence: number; source: 'llm' | 'rule' }> {
    return this.interpretSvc.extractSlots(sessionId, utterance, slotHint, label);
  }

  /** 引导与救援已独立成 GuideService，这里只做转发（保持对外方法名不变） */
  async guide(sessionId: string, req: AssistRequest): Promise<GuideAction> {
    return this.guideSvc.guide(sessionId, req);
  }

  hotlineScript(sessionId: string): { script: string; hotline: string } {
    return this.guideSvc.hotlineScript(sessionId);
  }

  /* ─────────────── 指标 ─────────────── */

  metrics(sessionId: string): SessionMetrics {
    return this.metricsSvc.of(this.requireSession(sessionId));
  }

  /**
   * 记录用户对办件结果的反馈。
   *
   * 为什么这件事重要到要单独一个接口：
   * 在此之前，产品对「自己办得对不对」是**完全没有信号**的——
   * 提示词、知识库、事项库只能靠开发者拍脑袋改。有了这三档反馈，
   * 「它说错了」的占比才第一次成为一个可观测的指标，
   * 而不是靠评委问一句「老人用得怎么样」然后我们猜。
   *
   * 三个字段一起记：反馈本身、当时的任务、以及走偏/拦截次数——
   * 因为「没办成」的原因往往不在最后一步，而在前面的某次误判。
   */
  recordFeedback(sessionId: string, verdict: FeedbackVerdict, note?: string): SessionMetrics {
    return this.metricsSvc.recordFeedback(this.requireSession(sessionId), verdict, note);
  }

  /**
   * 质量指标：有多少人办了、有多少人说它错了。
   *
   * 分母是「给过反馈的人数」，不是「全部会话」：没反馈的人不代表满意，不能算作成功。
   */
  quality(): { total: number; worked: number; failed: number; wrong: number; wrongRate: number } {
    return this.metricsSvc.quality();
  }

  /* ─────────────── 内部工具 ─────────────── */

  private requireSession(id: string): SessionState {
    return this.store.require(id);
  }

}

/**
 * 从完整档案里挑出「可以留下来」的字段。
 *
 * 白名单制：加一个新字段必须同时改这里与 shared/types.ts 的 ProfileMemory，
 * 否则它只是这次会话里过一下，不会被记住——这种「默认不记」的写法比为敏感字段逐个拉黑安全。
 * （实现在 session-store.ts，这里保留说明，方便从档案相关代码一路找过去。）
 */
