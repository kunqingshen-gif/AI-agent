import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashScopeLlm } from '@infra/llm/dashscope';
import type { Logger } from '@infra/logger';

/**
 * 用量统计的契约。
 *
 * 为什么值得单独测：tokens 和 p95 会直接出现在答辩材料里。
 * 一个算错的成本数字比没有数字更糟——它会让「一次办事不到 5 分钱」
 * 这句话失去可信度。
 */

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const config = {
  baseUrl: 'http://llm.test',
  apiKey: 'test-key',
  model: 'test-model',
  timeoutMs: 2000,
  maxRetries: 0,
};

function okResponse(tokens: number) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }], usage: { total_tokens: tokens } }),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('模型用量统计', () => {
  it('没有调用时全为 0，不编造数字', () => {
    const llm = new DashScopeLlm(config, silentLogger);
    const s = llm.stats();
    expect(s).toMatchObject({ calls: 0, failures: 0, timeouts: 0, tokens: 0, p50Ms: 0, p95Ms: 0, avgTokens: 0 });
  });

  it('累计调用次数与 token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(120)));
    const llm = new DashScopeLlm(config, silentLogger);
    await llm.complete({ system: 's', user: 'u' }, 't1');
    await llm.complete({ system: 's', user: 'u' }, 't2');
    const s = llm.stats();
    expect(s.calls).toBe(2);
    expect(s.tokens).toBe(240);
    expect(s.avgTokens).toBe(120);
  });

  it('没返回 usage 的调用不计入均值，但调用次数照算', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'x' } }] }),
      })),
    );
    const llm = new DashScopeLlm(config, silentLogger);
    await llm.complete({ system: 's', user: 'u' }, 't1');
    const s = llm.stats();
    expect(s.calls).toBe(1);
    expect(s.tokens).toBe(0);
    expect(s.avgTokens).toBe(0);
  });

  it('失败计入 failures，不污染 calls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' })),
    );
    const llm = new DashScopeLlm(config, silentLogger);
    await expect(llm.complete({ system: 's', user: 'u' }, 't1')).rejects.toThrow();
    const s = llm.stats();
    expect(s.failures).toBe(1);
    expect(s.calls).toBe(0);
  });

  it('p95 不低于 p50，且不超过最大样本', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(10)));
    const llm = new DashScopeLlm(config, silentLogger);
    for (let i = 0; i < 5; i += 1) await llm.complete({ system: 's', user: 'u' }, `t${i}`);
    const s = llm.stats();
    expect(s.p95Ms).toBeGreaterThanOrEqual(s.p50Ms);
    expect(s.p95Ms).toBeLessThan(10_000);
  });

  it('连接层失败单独记账，并保留 undici 藏在 cause 里的真因', async () => {
    const fetchSpy = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
      });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const llm = new DashScopeLlm(config, silentLogger);
    /* 报错信息必须带真因，否则「网络异常」四个字对排查毫无用处 */
    await expect(llm.complete({ system: 's', user: 'u' }, 't1')).rejects.toThrow(/UND_ERR_CONNECT_TIMEOUT/);
    const s = llm.stats();
    /* 网络层失败会自动多试一次：两次尝试都记在 network，且不混进 timeouts */
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(s.network).toBe(2);
    expect(s.timeouts).toBe(0);
    expect(s.calls).toBe(0);
  });

  it('超时单独记账，不与连接失败混为一谈', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            );
          }),
      ),
    );
    const llm = new DashScopeLlm({ ...config, timeoutMs: 10 }, silentLogger);
    await expect(llm.complete({ system: 's', user: 'u' }, 't1')).rejects.toThrow(/超时/);
    const s = llm.stats();
    expect(s.timeouts).toBe(1);
    expect(s.network).toBe(0);
  });
});
