import { describe, expect, it, vi } from 'vitest';
import { AssistService } from '@core/application/assist-service';
import type { LlmPort, LlmRequest } from '@core/ports';
import { InMemoryTelemetry } from '@infra/telemetry/jsonl';
import type { Logger } from '@infra/logger';
import type { AssistRequest, ScreenId, SlotName } from '@shared/types';

/** 可编排的假模型：让每个用例精确控制「模型返回什么」 */
class FakeLlm implements LlmPort {
  available = true;
  model = 'fake-model';
  calls: LlmRequest[] = [];
  health?: { available: boolean; healthy: boolean; lastError?: string };

  constructor(private readonly handler: (req: LlmRequest) => string | Promise<string>) {}

  async complete(req: LlmRequest): Promise<string> {
    this.calls.push(req);
    return this.handler(req);
  }
}

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const clock = { now: () => 1_700_000_000_000 };

function build(handler: (req: LlmRequest) => string | Promise<string>) {
  const llm = new FakeLlm(handler);
  const telemetry = new InMemoryTelemetry();
  const service = new AssistService(llm, telemetry, clock, silentLogger);
  return { service, llm, telemetry };
}

async function started(handler: (req: LlmRequest) => string | Promise<string>) {
  const ctx = build(handler);
  const session = ctx.service.createSession({ displayName: '王秀兰' });
  await ctx.service.interpret(session.id, '我想问一下低保那个复核');
  return { ...ctx, sessionId: session.id };
}

const FILLED: Partial<Record<SlotName, string>> = {
  name: '王秀兰',
  idCard: '350102195804120023',
  phone: '13800006021',
  householdSize: '1',
  monthlyIncome: '980',
};

/** 按真实节奏逐屏推进，让服务端自然记录完成状态 */
async function walk(service: AssistService, sessionId: string, screens: ScreenId[], slots = FILLED) {
  for (const screenId of screens) {
    await service.guide(sessionId, guideReq(sessionId, screenId, { slots }));
  }
}

const guideReq = (sessionId: string, screenId: ScreenId, patch: Partial<AssistRequest> = {}): AssistRequest => ({
  sessionId,
  screenId,
  slots: {},
  attemptsOnScreen: 0,
  asksForHelp: false,
  ...patch,
});

describe('编排层：意图理解', () => {
  it('优先采用模型的判断，并记录来源', async () => {
    const { service, sessionId } = await started(() =>
      JSON.stringify({ taskId: 'allowance.renew', confidence: 0.93, restated: '低保复核', slots: { name: '王秀兰' } }),
    );
    const session = service.getSession(sessionId);
    expect(session?.intent?.taskId).toBe('allowance.renew');
    expect(session?.intent?.source).toBe('llm');
    expect(session?.intent?.restated).toBe('低保复核');
  });

  it('模型返回非 JSON 时降级到规则引擎，流程不中断', async () => {
    const { service, sessionId, telemetry } = await started(() => '抱歉，我没听懂。');
    const session = service.getSession(sessionId);
    expect(session?.intent?.taskId).toBe('allowance.renew');
    expect(session?.intent?.source).toBe('rule');
    expect(telemetry.events.some((e) => e.type === 'llm.fallback')).toBe(true);
  });

  it('模型说 unknown 时不硬凑，退回规则结果', async () => {
    const { service, sessionId } = await started(() => JSON.stringify({ taskId: 'unknown', confidence: 0.2 }));
    expect(service.getSession(sessionId)?.intent?.source).toBe('rule');
  });

  it('模型编造的身份证号会被丢弃', async () => {
    const { service, sessionId } = await started(() =>
      JSON.stringify({ taskId: 'allowance.renew', confidence: 0.9, slots: { idCard: '123', phone: '110' } }),
    );
    expect(service.getSession(sessionId)?.slots.idCard).toBeUndefined();
    expect(service.getSession(sessionId)?.slots.phone).toBeUndefined();
  });

  it('完全无关的话术返回澄清建议', async () => {
    const { service } = build(() => '{}');
    const session = service.createSession();
    const result = await service.interpret(session.id, '今天天气不错');
    expect(result.ok).toBe(false);
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  it('脏话/闲聊被模型判为不相关时，不触发 AI 规划，回应得体且留痕', async () => {
    const { service, telemetry } = build((req) =>
      req.system.includes('路径规划师') ? JSON.stringify({ plausible: false }) : '{}',
    );
    const session = service.createSession();
    const result = await service.interpret(session.id, '我想吃大便。');
    expect(result.ok).toBe(false);
    expect(result.intent).toBeNull();
    /* 回应要拉回正题，而不是装傻继续规划 */
    expect(result.message).toContain('没听出');
    /* 留痕：off-topic 拒排要有埋点，答辩时可展示这层判断 */
    const rejected = telemetry.events.find((e) => e.type === 'plan.rejected');
    expect(rejected && 'stage' in rejected.payload ? (rejected.payload as { stage?: string }).stage : undefined).toBe('off-topic');
    /* 会话不得被塞进一条编造出来的流程 */
    expect(service.getSession(session.id)?.flow).toBeNull();
  });

  it('问知识时走问答通道，不强行拉进办理流程', async () => {
    const { service, telemetry } = build(() =>
      JSON.stringify({
        answer: '教育服务是管上学相关事的一栏，入学报名、学籍查询、助学贷款都在里面。',
        points: ['入学报名按学区', '查询学籍要先实名'],
        relatedTaskId: null,
        confidence: 0.9,
      }),
    );
    const session = service.createSession();
    const result = await service.interpret(session.id, '什么是教育服务');
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('answer');
    expect(result.intent).toBeNull();
    expect(result.answer?.text).toContain('教育服务');
    expect(result.answer?.source).toBe('llm');
    /* 只回答，不许偷跑办理流程 */
    expect(service.getSession(session.id)?.flow).toBeNull();
    expect(telemetry.events.some((e) => e.type === 'answer.served')).toBe(true);
  });

  it('模型不可用时，知识库仍能回答常见问题', async () => {
    const ctx = build(() => '{}');
    ctx.llm.available = false;
    const session = ctx.service.createSession();
    const result = await ctx.service.interpret(session.id, '高龄津贴怎么申请');
    expect(result.mode).toBe('answer');
    expect(result.answer?.source).toBe('rule');
    expect(result.answer?.relatedTaskId).toBeUndefined();
    expect(result.answer?.text.length).toBeGreaterThan(20);
  });

  it('问答能带回可办事项，用户一句话即可转到办理', async () => {
    const ctx = build(() =>
      JSON.stringify({ answer: '低保复核是核对家庭收入和人口变化。', points: ['每半年一次'], relatedTaskId: 'allowance.renew' }),
    );
    const session = ctx.service.createSession();
    const result = await ctx.service.interpret(session.id, '低保复核是什么意思');
    expect(result.answer?.relatedTaskId).toBe('allowance.renew');
    expect(result.suggestions).toContain('allowance.renew');
  });

  it('模型嘴上说「不相关」却仍附带步骤时，按形状错误拒绝，不进入引导', async () => {
    const { service, telemetry } = build((req) =>
      req.system.includes('路径规划师')
        ? JSON.stringify({
            plausible: false,
            title: '低保复核',
            steps: [{ screenId: 'gov.home', targetControlId: 'home.grid.minzheng', action: 'tap', goal: '进入民政', instruction: '点民政服务。' }],
          })
        : '{}',
    );
    const session = service.createSession();
    const result = await service.interpret(session.id, '今天天气哈哈不错');
    expect(result.ok).toBe(false);
    const rejected = telemetry.events.find((e) => e.type === 'plan.rejected');
    expect(rejected && 'stage' in rejected.payload ? (rejected.payload as { stage?: string }).stage : undefined).toBe('schema');
  });
});

describe('编排层：引导', () => {
  it('模型给出合规话术时采用模型的措辞', async () => {
    const { service, sessionId } = await started(() =>
      JSON.stringify({ instruction: '点最上面那排最左边的「社保服务」', speak: '点社保', confidence: 0.9 }),
    );
    const action = await service.guide(sessionId, guideReq(sessionId, 'gov.home'));
    expect(action.source).toBe('llm');
    expect(action.instruction).toContain('社保服务');
  });

  it('模型话术含高危词时被拦截，回退模板', async () => {
    const { service, sessionId } = await started(() =>
      JSON.stringify({ instruction: '先把银行卡密码输入进去再点', confidence: 0.9 }),
    );
    const action = await service.guide(sessionId, guideReq(sessionId, 'gov.home'));
    expect(action.source).toBe('rule');
    expect(action.instruction).not.toContain('密码');
  });

  it('护栏节点不让模型改写措辞', async () => {
    const { service, llm, sessionId } = await started(() => JSON.stringify({ instruction: '随便点', confidence: 0.9 }));
    await service.interpret(sessionId, '我要办低保复核');
    await walk(service, sessionId, ['gov.home', 'gov.civil.list', 'civil.allowance.intro', 'civil.allowance.form']);
    const before = llm.calls.length;
    const action = await service.guide(sessionId, guideReq(sessionId, 'civil.allowance.face', { slots: FILLED }));
    expect(action.kind).toBe('human-confirm');
    expect(action.guardrail).toBe('biometric');
    expect(llm.calls.length).toBe(before);
  });

  it('模型不可用时全链路仍可引导', async () => {
    const llm = new FakeLlm(() => {
      throw new Error('network down');
    });
    const service = new AssistService(llm, new InMemoryTelemetry(), clock, silentLogger);
    const session = service.createSession();
    await service.interpret(session.id, '我要办低保复核');
    const action = await service.guide(session.id, guideReq(session.id, 'gov.home'));
    expect(action.kind).toBe('tap');
    expect(action.targetControlId).toBe('home.grid.minzheng');
    expect(action.source).toBe('rule');
  });

  it('填表节点附带一键预填值', async () => {
    const { service, sessionId } = await started(() => '{}');
    await service.interpret(sessionId, '我要办低保复核');
    await walk(service, sessionId, ['gov.home', 'gov.civil.list', 'civil.allowance.intro'], {});
    const action = await service.guide(sessionId, guideReq(sessionId, 'civil.allowance.form'));
    expect(action.prefill?.value).toBe('王秀兰');
    expect(action.fieldId).toBe('form.name');
  });

  it('走错页面时给出纠偏动作而不是继续指路', async () => {
    const { service, sessionId } = await started(() => '{}');
    await service.interpret(sessionId, '我要办低保复核');
    const action = await service.guide(sessionId, guideReq(sessionId, 'wrong.insurance'));
    expect(action.kind).toBe('back');
    expect(action.rescue.triggered).toBe(true);
  });

  it('模型熔断后对外状态变为降级，便于界面如实提示', async () => {
    const { service, llm } = build(() => '{}');
    expect(service.llmStatus.healthy).toBe(true);
    llm.health = { available: true, healthy: false, lastError: 'http' };
    expect(service.llmStatus).toMatchObject({ available: true, healthy: false, lastError: 'http' });
  });

  it('会话不存在时抛出可识别的错误', async () => {
    const { service } = build(() => '{}');
    await expect(service.guide('not-a-session', guideReq('not-a-session', 'gov.home'))).rejects.toThrow(/会话不存在/);
  });
});

describe('编排层：指标', () => {
  it('完成全流程后标记完成并统计护栏次数', async () => {
    const { service, sessionId } = await started(() => '{}');
    await service.interpret(sessionId, '我要办低保复核');

    const slots: Partial<Record<SlotName, string>> = {
      name: '王秀兰',
      idCard: '350102195804120023',
      phone: '13800006021',
      householdSize: '1',
      monthlyIncome: '980',
    };
    const seq: Array<[ScreenId, Partial<Record<SlotName, string>>]> = [
      ['gov.home', slots],
      ['gov.civil.list', slots],
      ['civil.allowance.intro', slots],
      ['civil.allowance.form', slots],
      ['civil.allowance.face', slots],
      ['civil.allowance.risk', slots],
      ['civil.allowance.done', slots],
    ];
    for (const [screenId, s] of seq) {
      await service.guide(sessionId, guideReq(sessionId, screenId, { slots: s }));
    }
    const metrics = service.metrics(sessionId);
    expect(metrics.completed).toBe(true);
    expect(metrics.guardrailsTriggered).toBe(2);
    expect(metrics.baselineSteps).toBe(12);
  });

  it('求助话术带上事项与身份尾号，避免老人重复解释', async () => {
    const { service, sessionId } = await started(() => '{}');
    await service.interpret(sessionId, '我要办低保复核');
    const { script, hotline } = service.hotlineScript(sessionId);
    expect(script).toContain('低保');
    expect(script).toContain('后四位');
    expect(hotline).toContain('12345');
  });
});

describe('编排层：无障碍适配', () => {
  it('听障用户不生成语音，并在判断依据里留痕', async () => {
    const ctx = build(() => '{}');
    const session = ctx.service.createSession({ displayName: '王秀兰', hearingImpaired: true });
    await ctx.service.interpret(session.id, '我要办低保复核');

    const action = await ctx.service.guide(session.id, guideReq(session.id, 'gov.home'));
    expect(action.speak).toBe('');
    expect(action.reason).toContain('听障模式');
    /* 指引本身不能因为关掉语音而失效 */
    expect(action.instruction.length).toBeGreaterThan(0);
    expect(action.targetControlId).toBe('home.grid.minzheng');
  });

  it('未开启听障模式时仍正常生成语音，不受影响', async () => {
    const { service, sessionId } = await started(() => '{}');
    const action = await service.guide(sessionId, guideReq(sessionId, 'gov.home'));
    expect(action.speak.length).toBeGreaterThan(0);
    expect(action.reason).not.toContain('听障模式');
  });
});

describe('编排层：内存上限', () => {
  it('会话超过上限时淘汰最老的，避免内存单调增长', () => {
    const service = new AssistService(new FakeLlm(() => '{}'), new InMemoryTelemetry(), clock, silentLogger, {
      maxSessions: 3,
    });
    const ids = [0, 1, 2, 3].map(() => service.createSession().id);
    expect(service.getSession(ids[0] as string)).toBeUndefined();
    expect(service.getSession(ids[3] as string)).toBeDefined();
  });

  it('被访问过的会话刷新 LRU 顺序，不会被新会话挤掉', async () => {
    const service = new AssistService(new FakeLlm(() => '{}'), new InMemoryTelemetry(), clock, silentLogger, {
      maxSessions: 2,
    });
    const first = service.createSession().id;
    const second = service.createSession().id;

    /* 访问 first，使其成为最近使用 */
    await service.guide(first, guideReq(first, 'gov.home'));

    service.createSession(); // 触发淘汰
    expect(service.getSession(first)).toBeDefined();
    expect(service.getSession(second)).toBeUndefined();
  });
});
