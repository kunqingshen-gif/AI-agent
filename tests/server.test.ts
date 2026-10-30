import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { buildApp } from '../src/server/app';
import { AssistService } from '@core/application/assist-service';
import { InMemoryTelemetry } from '@infra/telemetry/jsonl';
import { loadConfig } from '@infra/config';
import type { Logger } from '@infra/logger';
import type { LlmPort } from '@core/ports';

const silentLogger = pino({ level: 'silent' }) as unknown as Logger;

/** 规则模式（无模型）下的接口契约测试 */
const disabledLlm: LlmPort = {
  available: false,
  model: 'disabled',
  complete: async () => {
    throw new Error('disabled');
  },
};

describe('HTTP 接口契约', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    const telemetry = new InMemoryTelemetry();
    const service = new AssistService(disabledLlm, telemetry, { now: () => Date.now() }, silentLogger);
    app = await buildApp({ config, logger: silentLogger, service, telemetry });
  });

  afterAll(async () => {
    await app.close();
  });

  it('健康检查返回 ok 与模型状态', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', llmAvailable: false });
  });

  it('返回事项清单', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tasks' });
    const body = res.json() as Array<{ taskId: string }>;
    expect(body.length).toBe(4);
    expect(body.map((t) => t.taskId)).toContain('allowance.renew');
  });

  it('创建会话返回会话 id 与默认画像', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/session', payload: {} });
    const body = res.json() as { sessionId: string; profile: { displayName: string } };
    expect(res.statusCode).toBe(200);
    expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.profile.displayName).toBe('王秀兰');
  });

  it('请求体不合法时返回 400 与字段明细', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/intent', payload: { sessionId: 1 } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'INVALID_ARGUMENT' });
  });

  it('未知屏幕 id 被拒绝', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/session', payload: {} });
    const { sessionId } = created.json() as { sessionId: string };
    const res = await app.inject({
      method: 'POST',
      url: '/api/guide',
      payload: { sessionId, screenId: 'not.a.screen', slots: {}, attemptsOnScreen: 0, asksForHelp: false },
    });
    expect(res.statusCode).toBe(400);
  });

  it('会话不存在时返回 404 而不是 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/guide',
      payload: { sessionId: 'missing-session-id', screenId: 'gov.home', slots: {}, attemptsOnScreen: 0, asksForHelp: false },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'SESSION_NOT_FOUND' });
  });

  it('完整走一遍：意图 → 引导 → 指标', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/session', payload: {} });
    const { sessionId } = created.json() as { sessionId: string };

    const intent = await app.inject({
      method: 'POST',
      url: '/api/intent',
      payload: { sessionId, utterance: '我要办低保复核' },
    });
    expect((intent.json() as { intent: { taskId: string } }).intent.taskId).toBe('allowance.renew');

    const guide = await app.inject({
      method: 'POST',
      url: '/api/guide',
      payload: { sessionId, screenId: 'gov.home', slots: {}, attemptsOnScreen: 0, asksForHelp: false },
    });
    const action = guide.json() as { targetControlId: string; kind: string };
    expect(action.kind).toBe('tap');
    expect(action.targetControlId).toBe('home.grid.minzheng');

    const metrics = await app.inject({ method: 'GET', url: `/api/session/${sessionId}/metrics` });
    expect((metrics.json() as { stepsGuided: number }).stepsGuided).toBe(1);
  });

  it('埋点汇总可读', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('events');
  });

  /*
   * 放在最后：本用例会把限流计数打满。
   * @fastify/rate-limit 内部是 throw errorResponseBuilder(...)，若返回值不是带
   * statusCode 的 Error，请求会被全局错误处理器兜成 500 —— 老人连点几下就会看到
   * 「服务暂时不可用」，监控也会误判为服务端故障。
   */
  it('触发限流时返回 429 而不是 500', async () => {
    let last: Awaited<ReturnType<typeof app.inject>> | undefined;
    for (let i = 0; i < 245; i += 1) {
      last = await app.inject({ method: 'GET', url: '/healthz' });
    }
    expect(last?.statusCode).toBe(429);
    expect((last?.json() as { error: string }).error).toBe('RATE_LIMITED');
  });
});
