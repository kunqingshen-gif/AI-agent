import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import helmet from '@fastify/helmet';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { SCREEN_IDS, TASK_IDS, type AssistRequest, type ScreenId, type SlotName, type TaskId } from '@shared/types';
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

const SessionSchema = z.object({
  profile: ProfileSchema.optional(),
  /**
   * 这台设备的档案编号（前端首次进入时生成、存在本机）。
   *
   * 为什么不用账号：老人不该为了办事先注册。
   * 代价是换手机就丢了记忆——可以接受，总比让人先填一堆信息强。
   */
  ownerId: z.string().trim().min(8).max(64).optional(),
});

/** 档案可改的字段：白名单，和 ProfileMemory 一一对应 */
const ProfilePatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(20),
    age: z.number().int().min(40).max(110),
    digitalLiteracy: z.enum(['low', 'medium', 'high']),
    livingAlone: z.boolean(),
    hearingImpaired: z.boolean(),
  })
  .partial()
  .refine((data) => Object.keys(data).length > 0, { message: '至少要改一项' });

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

/**
 * 结果反馈。
 *
 * verdict 三档必填，不接受自由文本当结论——老人不会填量表，
 * 只会回答「办成没有」；note 可选，是给愿意多说一句的人留的口子。
 */
const FeedbackSchema = z.object({
  sessionId: z.string().min(8).max(64),
  verdict: z.enum(['worked', 'failed', 'wrong']),
  note: z.string().trim().max(200).optional(),
});

const PreflightSchema = z.object({
  taskId: z.enum(TASK_IDS).optional(),
  sessionId: z.string().min(8).max(64).optional(),
});

const ScamSchema = z.object({ text: z.string().trim().min(2).max(300) });

const CollabOpenSchema = z.object({ sessionId: z.string().min(8).max(64) });
const CollabJoinSchema = z.object({ code: z.string().trim().min(4).max(10), helper: z.string().trim().min(1).max(10) });
const CollabHintSchema = z.object({ code: z.string().trim().min(4).max(10), text: z.string().trim().min(1).max(60) });
const CollabCodeSchema = z.object({ code: z.string().trim().min(4).max(10) });

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
    /* 当前生效的提示词版本：改了配置却看不出改没改，是最容易踩的坑 */
    promptVersion: service.promptVersion(),
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
    const session = service.openSession(parsed.data.profile, parsed.data.ownerId);
    return {
      sessionId: session.id,
      profile: session.profile,
      screenId: session.screenId,
      tasks: service.listTasks(),
      /* 前端据此显示「我记得您：王秀兰 · 68 岁 · 大字慢讲」 */
      memory: service.profileView(session.id),
    };
  });

  /* ── 断点续办：刷新后凭 sessionId 还原来那一页 ── */
  app.get('/api/session/:id/state', async (request, reply) => {
    const { id } = request.params as { id: string };
    const snapshot = service.sessionSnapshot(id);
    if (!snapshot) {
      return reply.status(404).send({ error: 'SESSION_NOT_FOUND', message: '会话已过期，请重新开始' });
    }
    return snapshot;
  });

  /* ── 长期档案：可查、可改、可忘 ── */

  app.get('/api/session/:id/profile', async (request, reply) => {
    const { id } = request.params as { id: string };
    const view = service.profileView(id);
    if (!view) return reply.status(404).send({ error: 'SESSION_NOT_FOUND', message: '会话已过期，请重新开始' });
    return view;
  });

  app.patch('/api/session/:id/profile', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = ProfilePatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error.flatten());
    const result = service.updateMemory(id, parsed.data);
    if (!result) return reply.status(404).send({ error: 'SESSION_NOT_FOUND', message: '会话已过期，请重新开始' });
    return { ...result, profile: service.getSession(id)?.profile };
  });

  app.delete('/api/session/:id/profile', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!service.getSession(id)) {
      return reply.status(404).send({ error: 'SESSION_NOT_FOUND', message: '会话已过期，请重新开始' });
    }
    const removed = service.forgetMemory(id);
    return { forgotten: removed, memory: service.profileView(id), profile: service.getSession(id)?.profile };
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

  /*
   * 结果反馈：办成了 / 没办成 / 它说错了。
   *
   * 这是产品唯一的「外部信号」入口。没有它，提示词和事项库只能靠开发者猜；
   * 有它，「它说错了」的占比才第一次成为可观测指标，能进 /api/metrics，
   * 也能直接对着某一句话去改。
   *
   * 允许重复提交：老人改主意、或者第一次点错，都该能改。后到的覆盖前一次，
   * 但每一笔都留痕（埋点不去重），这样才看得出「改主意」本身有多常见。
   */
  app.post('/api/feedback', async (request, reply) => {
    const parsed = FeedbackSchema.safeParse(request.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error.flatten());
    try {
      return service.recordFeedback(parsed.data.sessionId, parsed.data.verdict, parsed.data.note);
    } catch {
      return reply.status(404).send({ error: 'SESSION_NOT_FOUND', message: '会话已过期，请重新开始' });
    }
  });

  /*
   * 管家能力的独立入口。
   *
   * 这些接口是给「面板」用的：用户可能在面板里直接点事项看体检，
   * 不一定先说话。自然语言那条路走 /api/intent 的 tool 通道，两条路共用同一个服务方法，
   * 所以不会出现「说一句话和点一下，结论不一样」的情况。
   */
  app.post('/api/preflight', async (request, reply) => {
    const parsed = PreflightSchema.safeParse(request.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error.flatten());
    const result = service.preflight(parsed.data.taskId as TaskId | undefined);
    if (!result) return reply.status(404).send({ error: 'NOT_FOUND', message: '这件事还没有录入受理要求，做不了体检' });
    return result;
  });

  app.get('/api/lifecycle', async () => service.lifecycle());

  app.post('/api/scam', async (request, reply) => {
    const parsed = ScamSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.flatten());
    return service.scamOf(parsed.data.text);
  });

  app.post('/api/collab/open', async (request, reply) => {
    const parsed = CollabOpenSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.flatten());
    try {
      return service.openCollabFor(parsed.data.sessionId);
    } catch {
      return reply.status(404).send({ error: 'SESSION_NOT_FOUND', message: '会话已过期，请重新开始' });
    }
  });

  app.post('/api/collab/join', async (request, reply) => {
    const parsed = CollabJoinSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.flatten());
    const result = service.joinCollabByCode(parsed.data.code, parsed.data.helper);
    if (!result.ok) return reply.status(409).send({ error: 'COLLAB_REJECTED', message: result.reason });
    return result.value;
  });

  app.post('/api/collab/hint', async (request, reply) => {
    const parsed = CollabHintSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.flatten());
    const result = service.hintByCode(parsed.data.code, parsed.data.text);
    if (!result.ok) return reply.status(409).send({ error: 'COLLAB_REJECTED', message: result.reason });
    return result.value;
  });

  app.post('/api/collab/close', async (request, reply) => {
    const parsed = CollabCodeSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.flatten());
    const result = service.closeCollabByCode(parsed.data.code);
    if (!result.ok) return reply.status(404).send({ error: 'NOT_FOUND', message: result.reason });
    return result.value;
  });

  app.get('/api/metrics', async () => ({
    events: await telemetry.summary(),
    /* 质量指标：反馈分档与「它说错了」占比——答辩时这一个数最说明问题 */
    quality: service.quality(),
    /*
     * 成本与延迟：tokens、p50/p95。之前这些只进日志，等于「能看不能算」，
     * 被问「一次办事多少钱」只能估。现在是实测值。
     */
    llm: service.llmStats(),
    at: Date.now(),
  }));

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
