/**
 * 端口（Ports）：应用层只依赖这些接口，不依赖具体实现。
 * 好处是模型厂商可替换、测试可注入假实现（见 tests/）。
 */

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
}

export interface TelemetryEvent {
  type:
    | 'session.started'
    | 'intent.parsed'
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
    | 'feedback.given';
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
