/**
 * 端口（Ports）：应用层只依赖这些接口，不依赖具体实现。
 * 好处是模型厂商可替换、测试可注入假实现（见 tests/）。
 */

import type { ProfileMemory } from '@shared/types';

export interface LlmRequest {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  /** 期望返回 JSON，适配器会做容错解析 */
  expectJson?: boolean;
  /**
   * 单次调用的超时覆盖（毫秒）。
   * 引导改写必须快（用户盯着屏幕等），现场规划允许慢一点（用户看得见"正在想"），
   * 两者的合理上限不是同一个数，所以超时不该写死在配置里。
   */
  timeoutMs?: number;
  /**
   * 尽力而为：失败不触发熔断。
   * 规划失败只是"这件事没学会"，不该把整个模型通道拉黑 60 秒——
   * 否则一次慢查询会让接下来的普通引导全部降级成规则话术。
   */
  bestEffort?: boolean;
}

export interface LlmHealth {
  /** 已配置密钥 */
  available: boolean;
  /** 熔断状态：false 表示近期调用连续失败，已切换到规则通道 */
  healthy: boolean;
  /** 最近一次失败原因，供状态徽标与排障使用 */
  lastError?: string;
}

export interface LlmPort {
  readonly available: boolean;
  readonly model: string;
  /** 实现可选：未提供时视为「只要可用就健康」 */
  readonly health?: LlmHealth;
  complete(req: LlmRequest, traceId: string): Promise<string>;
  /**
   * 累计用量（可选实现）。
   *
   * 为什么需要：一次办事会调 6–10 次模型，成本与延迟是这类产品的命门。
   * 之前 tokens 只进了日志，等于「能看不能算」——答辩时被问「一次多少钱」
   * 只能估，不能用实测数据回答。
   *
   * 实现可缺省：测试里的假模型不需要统计，缺省时上层按「无数据」处理。
   */
  stats?(): LlmStats;
}

export interface LlmStats {
  /** 成功返回的调用次数 */
  calls: number;
  failures: number;
  timeouts: number;
  /**
   * 连接层失败（DNS/握手/代理），与超时分开记账。
   *
   * 为什么必须分开：这两类问题的主管部门完全不同——
   * 超时是我们把 timeoutMs 定小了，该改自己的配置；
   * 连接失败是网络通路的事，改配置永远改不好。
   * 混在一个 failures 里，排查时只能靠猜。
   */
  network: number;
  /** 累计 token（仅统计服务端返回 usage 的调用） */
  tokens: number;
  /** 延迟分位（毫秒）；样本不足时取已有样本 */
  p50Ms: number;
  p95Ms: number;
  /** 单次调用平均 token；无样本为 0 */
  avgTokens: number;
}

/* ────────────────────────── 档案记忆 ────────────────────────── */

export interface StoredProfile {
  memory: ProfileMemory;
  updatedAt: number;
  /** 到期时间；过了这个点就不再参与引导措辞 */
  expiresAt: number;
}

/**
 * 长期档案的存取端口。
 *
 * 分层意图：一次会话里的东西（当前屏幕、乱点次数）是**短期记忆**，活在内存里；
 * 这位老人「怎么称呼、多大年纪、话该密还是该疏」是**长期记忆**，要跨会话留着。
 * 两者的生命周期、过期策略、隐私敏感度都不同，所以不放在同一个地方。
 */
export interface ProfileStorePort {
  /** 读不到、已过期、文件坏了，都返回 null——档案缺失不能拦住老人办事 */
  load(ownerId: string): StoredProfile | null;
  save(ownerId: string, memory: ProfileMemory): StoredProfile;
  forget(ownerId: string): boolean;
}

export interface TelemetryEvent {
  type:
    | 'session.started'
    | 'intent.parsed'
    /**
     * 模型**合法地**判定「这件事不在已收录清单里」。
     *
     * 单独记一种事件，是为了别把它算进 llm.fallback：
     * 这是模型答对了（清单只有 4 件事），不是模型降级了。
     * 混在一起统计，「降级率」会虚高，答辩时等于自己抹黑自己。
     */
    | 'intent.not-in-catalog'
    | 'guide.issued'
    | 'guardrail.blocked'
    | 'rescue.triggered'
    | 'task.completed'
    | 'llm.fallback'
    | 'llm.error'
    /** 模型为未收录事项现场规划，并通过了契约校验 */
    | 'plan.created'
    /** 模型给出的计划被 schema 或屏幕契约拦下 */
    | 'plan.rejected'
    /** 问答通道给出回答（source 区分模型作答与知识库兜底） */
    | 'answer.served'
    /** 一句话被路由到管家的某种能力（体检 / 日历 / 反诈 / 协办） */
    | 'tool.routed'
    /** 协办码状态变化：生成、接入、留言、关闭 */
    | 'collab.updated'
    /**
     * 用户对办件结果给出反馈（办成了 / 没办成 / 它说错了）。
     *
     * 这条事件是「运营迭代」的唯一入口：没有它，提示词和知识库只能靠拍脑袋改。
     */
    | 'feedback.given'
    /**
     * 老人自己改了档案（称呼 / 怎么讲 / 独居与否）。
     *
     * 值得单独埋点：档案是唯一「用户亲口纠正我们的地方」。
     * 如果改了以后引导措辞没变，这条埋点就是证据。
     */
    | 'profile.updated'
    /** 老人要求忘掉他的信息（合规要求，不是可选功能） */
    | 'profile.forgotten';
  sessionId: string;
  at: number;
  payload: Record<string, unknown>;
}

export interface TelemetryPort {
  record(event: TelemetryEvent): void;
  summary(): Promise<Record<string, number>>;
}

export interface ClockPort {
  now(): number;
}
