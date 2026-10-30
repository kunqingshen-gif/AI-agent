import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import helmet from '@fastify/helmet';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { SCREEN_IDS, type AssistRequest, type ScreenId, type SlotName } from '@shared/types';
import { VERSION } from '@shared/version';
import { SCREENS } from '@shared/screens';
import type { AssistService } from '@core/application/assist-service';
import type { AppConfig } from '@infra/config';
import type { Logger } from '@infra/logger';
import type { TelemetryPort } from '@core/ports';

const ProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(20),
    age: z.number().int().min(40).max(110),
    region: z.string().trim().max(40),
    livingAlone: z.boolean(),
    digitalLiteracy: z.enum(['low', 'medium', 'high']),
    hearingImpaired: z.boolean(),
  })
  .partial();

const SessionSchema = z.object({ profile: ProfileSchema.optional() });

const IntentSchema = z.object({
  sessionId: z.string().min(8).max(64),
  utterance: z.string().trim().min(1).max(300),
});

const GuideSchema = z.object({
  sessionId: z.string().min(8).max(64),
  screenId: z.enum(SCREEN_IDS),
  slots: z.record(z.string().max(60)).default({}),
  attemptsOnScreen: z.number().int().min(0).max(50).default(0),
  asksForHelp: z.boolean().default(false),
  tappedControlId: z.string().max(60).optional(),
});

const ExtractSchema = z.object({
  sessionId: z.string().min(8).max(64),
  utterance: z.string().trim().min(1).max(300),
  slot: z.string().max(30).optional(),
  label: z.string().max(40).optional(),
});

const RescueSchema = z.object({ sessionId: z.string().min(8).max(64) });

export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  service: AssistService;
  telemetry: TelemetryPort;
}

export async function buildApp(deps: AppDeps) {
  const { config, logger, service, telemetry } = deps;
  const app = Fastify({
    loggerInstance: logger,
    genReqId: () => crypto.randomUUID(),
    bodyLimit: 64 * 1024,
  });

  await app.register(rateLimit, {
    max: 240,
    timeWindow: '1 minute',
    /*
     * 注意：@fastify/rate-limit 内部是 `throw errorResponseBuilder(...)`，
     * 返回值必须是 Error 实例，且靠 statusCode 决定响应码；返回普通对象会落到
     * 全局错误处理器被当成 500。这里显式带 statusCode=429，避免把「请求太快」
     * 误报成「服务端故障」。
     */
    errorResponseBuilder: (_req, context) => {
      /* context.after 形如 "57 seconds"/"1 minute"，直接展示是英文，转成中文秒数 */
      const seconds = Math.max(1, Number.parseInt(String(context.after), 10) || 60);
      return Object.assign(new Error(`请求过于频繁，请 ${seconds} 秒后再试`), {
        statusCode: 429,
        code: 'RATE_LIMITED',
      });
    },
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) {
      request.log.error({ reqId: request.id, err: error.message }, 'unhandled');
      reply.status(500).send({
        error: 'INTERNAL_ERROR',
        message: '服务暂时不可用，请稍后再试。',
        traceId: request.id,
      });
      return;
    }
    /* 4xx 属于客户端可纠正的问题，如实回传，不要掩盖成 500 */
    request.log.warn({ reqId: request.id, err: error.message, status }, 'client error');
    reply.status(status).send({
      error: status === 429 ? 'RATE_LIMITED' : 'BAD_REQUEST',
      message: error.message,
      traceId: request.id,
    });
  });

  /** 结构化的最小回复接口，避免 Fastify 泛型在不同 server 实现间的型变问题 */
  interface ReplyLike {
    status(code: number): { send(payload: unknown): unknown };
  }
  const badRequest = (reply: ReplyLike, detail: unknown) =>
    reply.status(400).send({ error: 'INVALID_ARGUMENT', message: '请求参数不合法', detail });

  app.get('/healthz', async () => ({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    llmAvailable: service.llmStatus.available,
    llmHealthy: service.llmStatus.healthy,
    version: VERSION,
  }));

  app.get('/api/meta', async () => ({
    product: '随行帮办 AssistGuide',
    version: VERSION,
    llm: {
      available: service.llmStatus.available,
      healthy: service.llmStatus.healthy,
      model: service.llmStatus.model,
      ...(service.llmStatus.lastError ? { lastError: service.llmStatus.lastError } : {}),
      mode: 'openai-compatible',
    },
    guardrailMode: config.guardrailMode,
    screens: SCREEN_IDS.length,
  }));

  app.get('/api/tasks', async () => service.listTasks());

  app.get('/api/screens/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const screen = SCREENS[id as ScreenId];
    if (!screen) return reply.status(404).send({ error: 'NOT_FOUND', message: '屏幕不存在' });
    return screen;
  });

  app.post('/api/session', async (request, reply) => {
    const parsed = SessionSchema.safeParse(request.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error.flatten());
    const session = service.createSession(parsed.data.profile);
    return {
      sessionId: session.id,
      profile: session.profile,
      screenId: session.screenId,
      tasks: service.listTasks(),
    };
  });

  app.post('/api/intent', async (request, reply) => {
    const parsed = IntentSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.flatten());
    try {
      return await service.interpret(parsed.data.sessionId, parsed.data.utterance);
    } catch (error) {
      if (String(error).includes('会话不存在')) {
        return reply.status(404).send({ error: 'SESSION_NOT_FOUND', message: '会话已过期，请重新开始' });
      }
      throw error;
    }
  });

  app.post('/api/guide', async (request, reply) => {
    const parsed = GuideSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.flatten());
    const payload: AssistRequest = {
      sessionId: parsed.data.sessionId,
      screenId: parsed.data.screenId,
      slots: parsed.data.slots as Partial<Record<SlotName, string>>,
      attemptsOnScreen: parsed.data.attemptsOnScreen,
      asksForHelp: parsed.data.asksForHelp,
      ...(parsed.data.tappedControlId ? { tappedControlId: parsed.data.tappedControlId } : {}),
    };
    try {
      return await service.guide(payload.sessionId, payload);
    } catch (error) {
      if (String(error).includes('会话不存在')) {
        return reply.status(404).send({ error: 'SESSION_NOT_FOUND', message: '会话已过期，请重新开始' });
      }
      throw error;
    }
  });

  app.post('/api/slots/extract', async (request, reply) => {
    const parsed = ExtractSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.flatten());
    try {
      return await service.extractSlots(
        parsed.data.sessionId,
        parsed.data.utterance,
        parsed.data.slot as SlotName | undefined,
        parsed.data.label,
      );
    } catch {
      return reply.status(404).send({ error: 'SESSION_NOT_FOUND', message: '会话已过期，请重新开始' });
    }
  });

  app.post('/api/rescue', async (request, reply) => {
    const parsed = RescueSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.flatten());
    try {
      return service.hotlineScript(parsed.data.sessionId);
    } catch {
      return reply.status(404).send({ error: 'SESSION_NOT_FOUND', message: '会话已过期，请重新开始' });
    }
  });

  app.get('/api/session/:id/metrics', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return service.metrics(id);
    } catch {
      return reply.status(404).send({ error: 'SESSION_NOT_FOUND', message: '会话已过期，请重新开始' });
    }
  });

  app.get('/api/metrics', async () => ({ events: await telemetry.summary(), at: Date.now() }));

  const webRoot = path.resolve(process.cwd(), 'dist/web');
  if (existsSync(webRoot)) {
    /*
     * 安全响应头。CSP 关闭：页面用 React 行内 style 与 Web Speech API，
     * 开 CSP 需要放宽 'unsafe-inline' 才有意义，得不偿失；其余头（nosniff、
     * frame 防护、referrer）保留下发。
     */
    await app.register(helmet, { contentSecurityPolicy: false });

    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: '/',
      cacheControl: false,
      /*
       * Vite 产物文件名带内容 hash，可以放心长缓存；index.html 必须每次校验，
       * 否则用户会一直拿到旧的资源引用。
       */
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) {
          res.setHeader('cache-control', 'no-cache');
        } else {
          res.setHeader('cache-control', 'public, max-age=31536000, immutable');
        }
      },
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api')) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: '接口不存在' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
