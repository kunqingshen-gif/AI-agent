import type { AppConfig } from '../config';
import type { LlmPort, LlmRequest } from '@core/ports';
import type { Logger } from '../logger';

/**
 * DashScope（阿里云百炼）OpenAI 兼容适配器。
 *
 * 选择理由：国内可直连、中文口语理解稳定、OpenAI 协议兼容便于日后替换。
 * 稳定性措施：显式超时、有限重试、失败即刻抛错交由上层降级（绝不阻塞引导）。
 */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly code: 'timeout' | 'http' | 'network' | 'empty' | 'disabled',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { total_tokens?: number };
}

/** 失败后的冷却时间：期间直接走规则通道，避免每次请求都等满超时 */
const BREAKER_COOLDOWN_MS = 60_000;

export class DashScopeLlm implements LlmPort {
  readonly available: boolean;
  readonly model: string;
  private brokenUntil = 0;
  private lastError: string | undefined;

  constructor(
    private readonly config: AppConfig['llm'],
    private readonly logger: Logger,
  ) {
    this.available = Boolean(config.apiKey);
    this.model = config.model;
  }

  get health(): { available: boolean; healthy: boolean; lastError?: string } {
    return {
      available: this.available,
      healthy: this.available && Date.now() >= this.brokenUntil,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  private trip(error: unknown): void {
    this.brokenUntil = Date.now() + BREAKER_COOLDOWN_MS;
    this.lastError = error instanceof LlmError ? error.code : 'unknown';
    this.logger.warn({ lastError: this.lastError }, '模型通道熔断，后续请求走规则兜底');
  }

  async complete(req: LlmRequest, traceId: string): Promise<string> {
    if (!this.available) throw new LlmError('未配置 LLM_API_KEY，已停用模型通道', 'disabled');
    if (Date.now() < this.brokenUntil) {
      throw new LlmError(`模型通道熔断中（${this.lastError ?? 'unknown'}）`, 'disabled');
    }

    const attempts = this.config.maxRetries + 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const content = await this.once(req, traceId, attempt);
        this.brokenUntil = 0;
        this.lastError = undefined;
        return content;
      } catch (error) {
        lastError = error;
        const retryable = error instanceof LlmError && (error.code === 'timeout' || error.code === 'network' || (error.status ?? 0) >= 500);
        this.logger.warn({ traceId, attempt, err: String(error) }, 'llm 调用失败');
        if (!retryable || attempt === attempts) break;
      }
    }
    this.trip(lastError);
    throw lastError instanceof Error ? lastError : new LlmError('未知模型错误', 'network');
  }

  private async once(req: LlmRequest, traceId: string, attempt: number): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey ?? ''}`,
          'x-trace-id': traceId,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          temperature: req.temperature ?? 0.2,
          max_tokens: req.maxTokens ?? 800,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        this.logger.warn({ traceId, status: response.status, body: body.slice(0, 200) }, '模型返回非 2xx');
        throw new LlmError(`模型返回 ${response.status}`, 'http', response.status);
      }

      const json = (await response.json()) as ChatResponse;
      const content = json.choices?.[0]?.message?.content ?? '';
      this.logger.debug(
        { traceId, attempt, latencyMs: Date.now() - startedAt, tokens: json.usage?.total_tokens },
        'llm 调用成功',
      );
      if (!content.trim()) throw new LlmError('模型返回空内容', 'empty');
      return content;
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new LlmError(`模型超时（${this.config.timeoutMs}ms）`, 'timeout');
      }
      throw new LlmError(`模型网络异常：${String(error)}`, 'network');
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 未配置密钥时的空实现，让上层逻辑无需分支判断 */
export class DisabledLlm implements LlmPort {
  readonly available = false;
  readonly model = 'disabled';
  readonly health = { available: false, healthy: false, lastError: 'disabled' };
  async complete(): Promise<string> {
    throw new LlmError('模型通道未启用', 'disabled');
  }
}
