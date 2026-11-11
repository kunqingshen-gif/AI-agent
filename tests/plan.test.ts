import { describe, expect, it, vi } from 'vitest';
import { AssistService } from '@core/application/assist-service';
import { PLAN_SYSTEM_PROMPT } from '@core/application/prompts';
import { buildFlowFromPlan, inferGuardrail, interactiveControlsOf, isRelatedScreen, isBiometricScreen, type PlanDraft } from '@core/domain/plan';
import type { LlmPort, LlmRequest } from '@core/ports';
import { InMemoryTelemetry } from '@infra/telemetry/jsonl';
import type { Logger } from '@infra/logger';

/**
 * 计划验证器是「AI 进入决策层」之后唯一的安全阀，测试重点不在「能不能排对」，
 * 而在「排错了会不会被挡住」——所以下面每个用例都在故意让模型犯错。
 */

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

class FakeLlm implements LlmPort {
  available = true;
  model = 'fake-model';
  calls: LlmRequest[] = [];
  constructor(private readonly handler: (req: LlmRequest) => string | Promise<string>) {}
  async complete(req: LlmRequest): Promise<string> {
    this.calls.push(req);
    return this.handler(req);
  }
}

const ELDER_PLAN: PlanDraft = {
  title: '高龄老人津贴申请',
  category: '民政救助',
  documents: ['身份证', '户口簿'],
  coverage: 'partial',
  steps: [
    {
      screenId: 'gov.home',
      targetControlId: 'home.grid.minzheng',
      action: 'tap',
      goal: '进入民政服务',
      instruction: '点第四个方块，写着「民政服务」的那个。',
      speak: '点民政服务。',
    },
    {
      screenId: 'gov.civil.list',
      targetControlId: 'civil.item.elder',
      action: 'tap',
      goal: '找到高龄津贴入口',
      instruction: '往下划，看到「高龄老人津贴申请」就点它。',
      speak: '点高龄老人津贴。',
    },
  ],
};

describe('计划验证器：屏幕契约', () => {
  it('合法计划转成可执行流程图，并在末尾补一个收尾节点', () => {
    const result = buildFlowFromPlan(ELDER_PLAN, '我想申请高龄津贴');
    expect(result.ok).toBe(true);
    const flow = result.flow!;
    expect(flow.taskId.startsWith('custom.')).toBe(true);
    expect(flow.title).toBe('高龄老人津贴申请');
    /* 2 步 + 1 个收尾 read 节点 */
    expect(flow.nodes).toHaveLength(3);
    expect(flow.nodes[0]!.targetControlId).toBe('home.grid.minzheng');
    expect(flow.nodes[0]!.successScreen).toBe('gov.civil.list');
    expect(flow.nodes[1]!.successScreen).toBe('gov.civil.list');
    expect(flow.nodes[2]!.kind).toBe('read');
  });

  it('首步指向不存在的控件：整单拒绝，一步都不许执行', () => {
    const bad: PlanDraft = {
      ...ELDER_PLAN,
      steps: [{ ...ELDER_PLAN.steps[0]!, targetControlId: 'home.grid.yanglao' }, ELDER_PLAN.steps[1]!],
    };
    const result = buildFlowFromPlan(bad, '我想申请高龄津贴');
    expect(result.ok).toBe(false);
    expect(result.flow).toBeUndefined();
    expect(result.issues.join()).toContain('不存在于');
  });

  it('中途某步编造控件：截断到该步之前，而不是整单作废', () => {
    const bad: PlanDraft = {
      ...ELDER_PLAN,
      steps: [
        ELDER_PLAN.steps[0]!,
        { ...ELDER_PLAN.steps[1]!, targetControlId: 'civil.item.senior-subsidy' },
        { screenId: 'gov.civil.list', targetControlId: 'civil.item.dibao-renew', action: 'tap', goal: 'x', instruction: '再点低保' },
      ],
    };
    const result = buildFlowFromPlan(bad, '我想申请高龄津贴');
    expect(result.ok).toBe(true);
    expect(result.droppedSteps).toBe(1);
    /* 只剩首步 + 收尾节点 */
    expect(result.flow!.nodes).toHaveLength(2);
    expect(result.issues.join()).toContain('不存在于');
  });

  it('屏幕 id 不在屏幕库内：首步即拒绝', () => {
    const bad: PlanDraft = {
      ...ELDER_PLAN,
      steps: [{ ...ELDER_PLAN.steps[0]!, screenId: 'gov.senior.hall' }],
    };
    expect(buildFlowFromPlan(bad, '高龄津贴').ok).toBe(false);
  });

  it('截断后的收尾节点必须诚实说明「后面没见过」并给材料清单', () => {
    const truncated = buildFlowFromPlan({ ...ELDER_PLAN, steps: [ELDER_PLAN.steps[0]!] }, '高龄津贴');
    const last = truncated.flow!.nodes.at(-1)!;
    expect(last.instruction).toContain('没见过');
    expect(last.instruction).toContain('身份证');
    expect(last.speak).toContain('卡住了');
  });

  it('步骤超过上限时截断到 8 步，不无限膨胀', () => {
    const many: PlanDraft = {
      ...ELDER_PLAN,
      steps: Array.from({ length: 12 }, () => ({
        screenId: 'gov.civil.list',
        targetControlId: 'civil.item.elder',
        action: 'tap' as const,
        goal: '重复',
        instruction: '继续点',
      })),
    };
    const result = buildFlowFromPlan(many, '高龄津贴');
    expect(result.flow!.nodes).toHaveLength(9); // 8 步 + 收尾
    expect(result.issues.join()).toContain('超过上限');
  });
});

describe('计划验证器：语义相关性', () => {
  it('导航型屏幕对任何事项都放行', () => {
    expect(isRelatedScreen('gov.home', '高龄老人津贴申请')).toBe(true);
    expect(isRelatedScreen('gov.civil.list', '高龄老人津贴申请')).toBe(true);
  });

  it('低保复核的表单不能用来办高龄津贴', () => {
    expect(isRelatedScreen('civil.allowance.form', '高龄老人津贴申请')).toBe(false);
    expect(isRelatedScreen('civil.allowance.intro', '高龄老人津贴申请')).toBe(false);
  });

  it('同一件事的屏幕正常放行', () => {
    expect(isRelatedScreen('civil.allowance.intro', '最低生活保障（低保）对象定期复核')).toBe(true);
    expect(isRelatedScreen('civil.allowance.form', '最低生活保障（低保）对象定期复核')).toBe(true);
  });

  it('把用户领进别的事项页时，计划在该步截断并说明理由', () => {
    const plan: PlanDraft = {
      ...ELDER_PLAN,
      steps: [
        ELDER_PLAN.steps[0]!,
        ELDER_PLAN.steps[1]!,
        {
          screenId: 'civil.allowance.form',
          targetControlId: 'form.name',
          action: 'input',
          goal: '填写姓名',
          instruction: '点「申请人姓名」，写您的名字。',
        },
      ],
    };
    const result = buildFlowFromPlan(plan, '我要办高龄津贴');
    expect(result.ok).toBe(true);
    expect(result.droppedSteps).toBe(1);
    expect(result.issues.join()).toContain('不是同一件事');
    /* 只剩首页 → 民政列表两步 + 收尾 */
    expect(result.flow!.nodes).toHaveLength(3);
    expect(result.flow!.nodes.map((n) => n.screenId)).not.toContain('civil.allowance.form');
  });

  it('模型自报 full 但实际被截断时，覆盖度以校验结果为准', () => {
    const plan: PlanDraft = {
      ...ELDER_PLAN,
      coverage: 'full',
      steps: [
        ELDER_PLAN.steps[0]!,
        ELDER_PLAN.steps[1]!,
        {
          screenId: 'civil.allowance.form',
          targetControlId: 'form.name',
          action: 'input',
          goal: '填写姓名',
          instruction: '点「申请人姓名」。',
        },
      ],
    };
    const result = buildFlowFromPlan(plan, '我要办高龄津贴');
    expect(result.droppedSteps).toBe(1);
    expect(result.coverage).toBe('partial');
  });

  it('完整走通且未被截断时才是 full', () => {
    const full = buildFlowFromPlan({ ...ELDER_PLAN, coverage: 'full' }, '我要办高龄津贴');
    expect(full.droppedSteps).toBe(0);
    expect(full.coverage).toBe('full');
  });
});

describe('计划验证器：说法归一', () => {
  it('老人说「老年津贴」「养老补贴」，也能走上高龄津贴的屏', () => {
    expect(isRelatedScreen('mine.elder', '老年津贴申请')).toBe(true);
    expect(isRelatedScreen('mine.elder', '养老补贴')).toBe(true);
    expect(isRelatedScreen('mine.elder', '高龄津贴')).toBe(true);
  });

  it('归一不等于放水：老年津贴仍进不了低保复核的表单', () => {
    expect(isRelatedScreen('civil.allowance.form', '老年津贴申请')).toBe(false);
    expect(isRelatedScreen('civil.allowance.intro', '养老补贴')).toBe(false);
  });
});

describe('计划验证器：护栏不依赖屏幕 id 命名', () => {
  it('按屏幕上写着什么来判断是不是生物核验页', () => {
    expect(isBiometricScreen('civil.allowance.face')).toBe(true);
    expect(isBiometricScreen('pension.qualify.face')).toBe(true);
  });

  it('风控确认页、普通页面不会被误判成生物核验', () => {
    expect(isBiometricScreen('civil.allowance.risk')).toBe(false);
    expect(isBiometricScreen('gov.home')).toBe(false);
    expect(isBiometricScreen('civil.allowance.form')).toBe(false);
  });

  it('核验页上即使步骤文案很普通，也强制降级为本人确认', () => {
    /* 文案里没有人脸/核验字样，靠的只能是「这块屏幕本身是核验页」 */
    expect(
      inferGuardrail(
        { screenId: 'civil.allowance.face', targetControlId: 'face.btn.start', action: 'tap', goal: '继续', instruction: '点右下角' },
        'civil.allowance.face',
      ),
    ).toBe('biometric');
  });
});

describe('计划验证器：护栏只增不减', () => {
  it('核验页上的步骤自动判为人脸护栏', () => {
    expect(
      inferGuardrail(
        { screenId: 'civil.allowance.face', targetControlId: 'face.btn.start', action: 'tap', goal: '照脸', instruction: '点开始核验' },
        'civil.allowance.face',
      ),
    ).toBe('biometric');
  });

  it('模型把付款步骤标成 null，也照样被推断成 payment', () => {
    const plan: PlanDraft = {
      ...ELDER_PLAN,
      steps: [
        {
          screenId: 'utility.bill',
          targetControlId: 'bill.btn.pay',
          action: 'tap',
          goal: '去付款',
          instruction: '点「立即缴费」。',
          guardrail: null,
        },
      ],
    };
    const result = buildFlowFromPlan(plan, '我要交水费');
    expect(result.injectedGuardrails).toContain('payment');
    expect(result.flow!.nodes[0]!.guardrail).toBe('payment');
    /* 命中强制护栏的节点一定是 human-confirm，模型无法把它变回普通点击 */
    expect(result.flow!.nodes[0]!.kind).toBe('human-confirm');
  });

  it('模型自报的护栏不会被削弱或抹掉', () => {
    const plan: PlanDraft = {
      ...ELDER_PLAN,
      steps: [
        {
          screenId: 'gov.civil.list',
          targetControlId: 'civil.item.elder',
          action: 'tap',
          goal: '提交身份证号',
          instruction: '这里要填身份证号。',
          guardrail: 'identity',
        },
      ],
    };
    const result = buildFlowFromPlan(plan, '高龄津贴');
    expect(result.flow!.nodes[0]!.guardrail).toBeDefined();
    expect(result.flow!.nodes[0]!.kind).toBe('human-confirm');
  });

  it('普通点击不会被误判成护栏', () => {
    expect(
      inferGuardrail(
        { screenId: 'gov.home', targetControlId: 'home.grid.minzheng', action: 'tap', goal: '进入民政服务', instruction: '点民政服务' },
        'gov.home',
      ),
    ).toBeUndefined();
  });

  it('控件清单覆盖表单字段，供规划器指向输入框', () => {
    const controls = interactiveControlsOf('civil.allowance.form');
    expect(controls.has('form.name')).toBe(true);
    expect(controls.get('form.name')!.role).toBe('input');
  });
});

describe('编排层：未收录事项走 AI 现场规划', () => {
  function build() {
    const llm = new FakeLlm((req) => {
      if (req.system === PLAN_SYSTEM_PROMPT) return JSON.stringify(ELDER_PLAN);
      return JSON.stringify({ taskId: 'unknown', confidence: 0.2, restated: '' });
    });
    const telemetry = new InMemoryTelemetry();
    const service = new AssistService(llm, telemetry, { now: () => 1_700_000_000_000 }, silentLogger);
    return { llm, telemetry, service };
  }

  it('识别不到已收录事项时，用规划结果建会话并进入同一个引导循环', async () => {
    const { service, telemetry } = build();
    const session = service.createSession({ displayName: '王秀兰' });

    const result = await service.interpret(session.id, '我想申请高龄老人的那个补贴');
    expect(result.ok).toBe(true);
    expect(result.intent!.taskId.startsWith('custom.')).toBe(true);
    expect(result.planned?.steps).toBe(3);
    expect(result.planned?.coverage).toBe('partial');

    const action = await service.guide(session.id, {
      sessionId: session.id,
      screenId: 'gov.home',
      slots: {},
      attemptsOnScreen: 0,
      asksForHelp: false,
    });
    expect(action.kind).toBe('tap');
    expect(action.targetControlId).toBe('home.grid.minzheng');
    /* 判断依据里必须自报「这是 AI 排的」，否则无法与 catalog 路径区分 */
    expect(action.reason).toContain('AI 规划路径');
    expect(action.stepLabel).toContain('第 1 步');

    const summary = await telemetry.summary();
    expect(summary['plan.created']).toBe(1);
  });

  it('用户点在 AI 指的那个控件上（无下一页）也算走通，不会卡在原地反复指', async () => {
    const { service } = build();
    const session = service.createSession();
    await service.interpret(session.id, '我想申请高龄老人的那个补贴');

    const base = { sessionId: session.id, slots: {}, attemptsOnScreen: 0, asksForHelp: false };
    const first = await service.guide(session.id, { ...base, screenId: 'gov.home' });
    expect(first.targetControlId).toBe('home.grid.minzheng');

    const second = await service.guide(session.id, { ...base, screenId: 'gov.civil.list' });
    expect(second.targetControlId).toBe('civil.item.elder');

    /* 这一屏没有下一页，只带「点过了」这个信号 */
    const third = await service.guide(session.id, { ...base, screenId: 'gov.civil.list', tappedControlId: 'civil.item.elder' });
    expect(third.kind).toBe('read');
    expect(third.progress.index).toBe(third.progress.total);
  });

  it('点在别的控件上不会误判为走通', async () => {
    const { service } = build();
    const session = service.createSession();
    await service.interpret(session.id, '我想申请高龄老人的那个补贴');

    const base = { sessionId: session.id, slots: {}, attemptsOnScreen: 0, asksForHelp: false };
    await service.guide(session.id, { ...base, screenId: 'gov.home' });
    const stillFirst = await service.guide(session.id, {
      ...base,
      screenId: 'gov.home',
      tappedControlId: 'home.grid.yibao',
    });
    expect(stillFirst.targetControlId).toBe('home.grid.minzheng');
  });

  it('规划被契约拦下时退回「未收录」话术，且留下 plan.rejected 埋点', async () => {
    const llm = new FakeLlm((req) => {
      if (req.system === PLAN_SYSTEM_PROMPT) {
        return JSON.stringify({
          ...ELDER_PLAN,
          steps: [{ ...ELDER_PLAN.steps[0]!, targetControlId: 'home.grid.buzhidao' }],
        });
      }
      return JSON.stringify({ taskId: 'unknown', confidence: 0.1 });
    });
    const telemetry = new InMemoryTelemetry();
    const service = new AssistService(llm, telemetry, { now: () => 1_700_000_000_000 }, silentLogger);
    const session = service.createSession();

    const result = await service.interpret(session.id, '我要办个说不清的事');
    expect(result.ok).toBe(false);
    expect(result.intent).toBeNull();
    expect(result.message).toContain('答不上来');

    const summary = await telemetry.summary();
    expect(summary['plan.rejected']).toBe(1);
  });
});
