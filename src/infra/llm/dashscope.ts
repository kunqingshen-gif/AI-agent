import type { AppConfig } from '../config';
import type { LlmPort, LlmRequest, LlmStats } from '@core/ports';
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

  /*
   * 用量累计。只保留最近 200 条延迟样本：
   * p95 用不着全部历史，而无限增长的数组会在长时间演示后慢慢吃掉内存。
   */
  private stat = {
    calls: 0,
    failures: 0,
    timeouts: 0,
    network: 0,
    tokens: 0,
    sampleTokens: 0,
    tokenSamples: 0,
  };
  private readonly latencies: number[] = [];
  private static readonly MAX_SAMPLES = 200;

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

  private recordSuccess(latencyMs: number, tokens: number): void {
    this.stat.calls += 1;
    this.stat.tokens += tokens;
    /* 只对返回了 usage 的调用算均值，否则分母会把「没报 token」的调用也算进去 */
    if (tokens > 0) {
      this.stat.sampleTokens += tokens;
      this.stat.tokenSamples += 1;
    }
    this.latencies.push(latencyMs);
    if (this.latencies.length > DashScopeLlm.MAX_SAMPLES) this.latencies.shift();
  }

  /**
   * 用量快照。
   *
   * p95 而不是平均值：引导是有人盯着屏幕等着的同步调用，
   * 「平均 800ms」会让一次 5 秒的长尾完全被掩盖，而用户只会记住那一次卡顿。
   */
  stats(): LlmStats {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const pick = (q: number) => {
      if (sorted.length === 0) return 0;
      const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
      return sorted[idx] ?? 0;
    };
    return {
      calls: this.stat.calls,
      failures: this.stat.failures,
      timeouts: this.stat.timeouts,
      network: this.stat.network,
      tokens: this.stat.tokens,
      p50Ms: pick(0.5),
      p95Ms: pick(0.95),
      avgTokens: this.stat.tokenSamples > 0 ? Math.round(this.stat.sampleTokens / this.stat.tokenSamples) : 0,
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

    /*
     * 重试预算。
     *
     * 尽力而为的调用（问答、现场规划）多给一次；
     * 另外**网络层失败一律多给一次**，这条不分主链路还是旁路——
     * 实测本机首个出网连接会被丢包，卡满 undici 的 10 秒连接超时后失败，
     * 而紧接着的第二次只要 400ms。这类失败跟模型服务无关，
     * 不该让老人白等一顿，然后听到「这件事我暂时答不上来」。
     *
     * 超时不在此列：那通常是模型侧排队，重试只会让人再多等一个超时周期。
     */
    const baseAttempts = this.config.maxRetries + 1 + (req.bestEffort ? 1 : 0);
    let attempts = baseAttempts;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const content = await this.once(req, traceId, attempt);
        this.brokenUntil = 0;
        this.lastError = undefined;
        return content;
      } catch (error) {
        lastError = error;
        const code = error instanceof LlmError ? error.code : 'unknown';
        const status = error instanceof LlmError ? error.status : undefined;
        this.logger.warn({ traceId, attempt, err: String(error) }, 'llm 调用失败');

        if (code === 'network' && attempts === baseAttempts) {
          attempts += 1;
          continue;
        }
        const retryable = code === 'timeout' || code === 'network' || (status ?? 0) >= 500;
        if (!retryable || attempt === attempts) break;
      }
    }
    if (req.bestEffort) {
      /* 尽力而为的调用失败只记账、不熔断，避免拖累主链路 */
      this.logger.warn({ traceId, err: String(lastError) }, '尽力而为的模型调用失败，不熔断');
      throw lastError instanceof Error ? lastError : new LlmError('未知模型错误', 'network');
    }
    this.trip(lastError);
    throw lastError instanceof Error ? lastError : new LlmError('未知模型错误', 'network');
  }

  private async once(req: LlmRequest, traceId: string, attempt: number): Promise<string> {
    const controller = new AbortController();
    const timeoutMs = req.timeoutMs ?? this.config.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      this.recordSuccess(Date.now() - startedAt, json.usage?.total_tokens ?? 0);
      return content;
    } catch (error) {
      this.stat.failures += 1;
      if (error instanceof LlmError) {
        if (error.code === 'timeout') this.stat.timeouts += 1;
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        this.stat.timeouts += 1;
        throw new LlmError(`模型超时（${timeoutMs}ms）`, 'timeout');
      }
      this.stat.network += 1;
      /*
       * undici 把真因藏在 cause 里，message 永远只是空泛的 "fetch failed"。
       * 不取 cause 的话，日志里写「网络异常」等于什么都没写——
       * 而 UND_ERR_CONNECT_TIMEOUT / ENOTFOUND / CERT_HAS_EXPIRED 的处理方式完全不同。
       */
      const cause = (error as { cause?: unknown }).cause;
      const reason =
        cause instanceof Error
          ? ((cause as { code?: string }).code ?? cause.message)
          : String(cause ?? error);
      throw new LlmError(`模型网络异常：${reason}`, 'network');
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
