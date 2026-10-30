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
    | 'llm.error';
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
