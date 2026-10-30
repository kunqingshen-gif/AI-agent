import { randomUUID } from 'node:crypto';
import type {
  AssistRequest,
  GuideAction,
  Intent,
  RescueHint,
  ScreenId,
  SessionMetrics,
  SlotName,
  TaskId,
  UserProfile,
} from '@shared/types';
import { SCREENS } from '@shared/screens';
import type { LlmPort, TelemetryPort, ClockPort } from '../ports';
import type { TaskFlow } from '../domain/catalog';
import { TASK_FLOWS, TASK_LIST } from '../domain/catalog';
import { activeNode, decide } from '../domain/guide-engine';
import { normalizeSpeak, sanitizeAssistantText } from '../domain/guardrails';
import { extractSlotsByRule, ruleIntent, topSuggestions } from '../domain/intent-rules';
import {
  GUIDE_SYSTEM_PROMPT,
  GuideOutputSchema,
  INTENT_SYSTEM_PROMPT,
  IntentOutputSchema,
  SLOT_SYSTEM_PROMPT,
  SlotOutputSchema,
  buildGuideUserPrompt,
  buildSlotUserPrompt,
  extractJson,
  isKnownTask,
} from './prompts';
import { defaultProfile } from '@infra/config';
import type { Logger } from '@infra/logger';

/**
 * 应用层：编排「理解意图 → 生成计划 → 逐步引导 → 卡住救援」的完整闭环。
 *
 * 分层约定：
 *  - 决策（点哪儿）由 domain/guide-engine 的确定性流程给出，模型无权更改；
 *  - 措辞（怎么说）由模型生成，但必须过 zod 校验 + 高危词过滤，失败即回退模板。
 * 这样既保证「AI 真的在参与」，又保证「演示现场不会翻车」。
 */

export interface SessionState {
  id: string;
  profile: UserProfile;
  intent: Intent | null;
  flow: TaskFlow | null;
  completed: Set<string>;
  slots: Partial<Record<SlotName, string>>;
  screenId: ScreenId;
  startedAt: number;
  lastSeenAt: number;
  stepsGuided: number;
  wrongTurns: number;
  guardrailsTriggered: number;
  handoffs: number;
  finished: boolean;
}

export interface InterpretResult {
  ok: boolean;
  intent: Intent | null;
  suggestions: TaskId[];
  message: string;
  source: 'llm' | 'rule' | 'none';
}

const SIMULATED_PROFILE: UserProfile = {
  ...defaultProfile(),
  livingAlone: true,
  hearingImpaired: false,
};

export class AssistService {
  private readonly sessions = new Map<string, SessionState>();
  private readonly rewriteCache = new Map<string, { instruction: string; speak: string; reason: string }>();

  constructor(
    private readonly llm: LlmPort,
    private readonly telemetry: TelemetryPort,
    private readonly clock: ClockPort,
    private readonly logger: Logger,
  ) {}

  /* ─────────────── 会话 ─────────────── */

  createSession(profile?: Partial<UserProfile>): SessionState {
    const now = this.clock.now();
    const session: SessionState = {
      id: randomUUID(),
      profile: { ...SIMULATED_PROFILE, ...profile },
      intent: null,
      flow: null,
      completed: new Set<string>(),
      slots: {},
      screenId: 'gov.home',
      startedAt: now,
      lastSeenAt: now,
      stepsGuided: 0,
      wrongTurns: 0,
      guardrailsTriggered: 0,
      handoffs: 0,
      finished: false,
    };
    this.sessions.set(session.id, session);
    this.telemetry.record({
      type: 'session.started',
      sessionId: session.id,
      at: now,
      payload: { region: session.profile.region, age: session.profile.age },
    });
    return session;
  }

  getSession(id: string): SessionState | undefined {
    return this.sessions.get(id);
  }

  /** 对外暴露模型通道状态，用于 /healthz、/api/meta 与前端徽标 */
  get llmStatus(): { available: boolean; model: string; healthy: boolean; lastError?: string } {
    const health = this.llm.health ?? { available: this.llm.available, healthy: this.llm.available };
    return {
      available: health.available,
      model: this.llm.model,
      healthy: health.healthy,
      ...(health.lastError ? { lastError: health.lastError } : {}),
    };
  }

  listTasks() {
    return TASK_LIST;
  }

  /* ─────────────── 意图理解 ─────────────── */

  async interpret(sessionId: string, utterance: string): Promise<InterpretResult> {
    const session = this.requireSession(sessionId);
    const ruleBased = ruleIntent(utterance);

    let intent: Intent | null = ruleBased;
    let source: InterpretResult['source'] = ruleBased ? 'rule' : 'none';

    if (this.llm.available) {
      try {
        const raw = await this.llm.complete(
          {
            system: INTENT_SYSTEM_PROMPT,
            user: [
              `【事项清单】`,
              ...TASK_LIST.map((t) => `- ${t.taskId}｜${t.title}｜触发词：${t.hotkey}`),
              `【老人说的话】${utterance}`,
            ].join('\n'),
            temperature: 0.1,
            maxTokens: 400,
          },
          sessionId,
        );
        const parsed = IntentOutputSchema.safeParse(extractJson(raw));
        if (parsed.success && parsed.data.taskId !== 'unknown' && isKnownTask(parsed.data.taskId)) {
          const flow = TASK_FLOWS[parsed.data.taskId];
          const slots: Partial<Record<SlotName, string>> = {
            ...extractSlotsByRule(utterance),
            ...this.pickSlots(parsed.data.slots ?? {}),
          };
          intent = {
            taskId: parsed.data.taskId,
            confidence: parsed.data.confidence,
            slots,
            missingSlots: [],
            urgency: /急|马上|今天|截止|到期/.test(utterance) ? 'urgent' : 'normal',
            restated: (parsed.data.restated ?? '').replace(/^您要办的是[:：]\s*/, '').trim() || flow.title,
            source: 'llm',
            rawUtterance: utterance,
          };
          source = 'llm';
        } else {
          this.telemetry.record({
            type: 'llm.fallback',
            sessionId,
            at: this.clock.now(),
            payload: { stage: 'intent', error: 'invalid-output' },
          });
          intent = ruleBased;
          source = ruleBased ? 'rule' : 'none';
        }
      } catch (error) {
        this.telemetry.record({
          type: 'llm.fallback',
          sessionId,
          at: this.clock.now(),
          payload: { stage: 'intent', error: String(error) },
        });
        this.logger.warn({ sessionId, err: String(error) }, '意图理解降级到规则引擎');
      }
    }

    if (!intent) {
      return {
        ok: false,
        intent: null,
        suggestions: topSuggestions(utterance),
        message: '我没太听明白您要办哪件事。您可以从下面三件里选一件，也可以再说一遍。',
        source,
      };
    }

    const flow = TASK_FLOWS[intent.taskId];
    const needSlots = new Set<SlotName>();
    flow.nodes.forEach((node) => {
      if (node.slot) needSlots.add(node.slot);
    });
    intent.missingSlots = [...needSlots].filter((slot) => !intent?.slots[slot]);

    session.intent = intent;
    session.flow = flow;
    session.slots = { ...intent.slots };
    session.completed = new Set<string>();
    session.finished = false;

    this.telemetry.record({
      type: 'intent.parsed',
      sessionId,
      at: this.clock.now(),
      payload: { taskId: intent.taskId, confidence: intent.confidence, source: intent.source },
    });

    return { ok: true, intent, suggestions: [intent.taskId], message: intent.restated, source };
  }

  /** 从模型输出中挑出合法槽位，过滤掉编造/越界字段 */
  private pickSlots(raw: Record<string, string>): Partial<Record<SlotName, string>> {
    const allowed: SlotName[] = ['name', 'idCard', 'phone', 'householdSize', 'monthlyIncome', 'region', 'visitCity', 'hospital'];
    const out: Partial<Record<SlotName, string>> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!allowed.includes(key as SlotName)) continue;
      const text = String(value).trim();
      if (!text) continue;
      if (key === 'idCard' && !/^\d{17}[\dXx]$/.test(text)) continue;
      if (key === 'phone' && !/^1[3-9]\d{9}$/.test(text)) continue;
      out[key as SlotName] = text;
    }
    return out;
  }

  /* ─────────────── 逐步引导 ─────────────── */

  async guide(sessionId: string, req: AssistRequest): Promise<GuideAction> {
    const startedAt = this.clock.now();
    const session = this.requireSession(sessionId);
    session.lastSeenAt = startedAt;
    session.screenId = req.screenId;
    session.slots = { ...session.slots, ...(req.slots ?? {}) };

    const flow = session.flow;
    if (!flow) {
      return this.clarifyAction(session, startedAt);
    }

    /* 1. 自动推进：上一节点是否已被用户走通 */
    const pending = activeNode(flow, session.slots, session.completed);
    if (pending) {
      const advanced = req.screenId === pending.successScreen && req.screenId !== pending.screenId;
      const typed = pending.kind === 'input' && pending.slot ? Boolean(session.slots[pending.slot]?.trim()) : false;
      if (advanced || typed) {
        session.completed.add(pending.id);
      }
    }
    /* 推进后重新取当前节点：避免用到已完成的旧节点 */
    const node = activeNode(flow, session.slots, session.completed);

    /* 2. 确定性决策 */
    const rule = decide({
      flow,
      screenId: req.screenId,
      slots: session.slots,
      completed: session.completed,
      attemptsOnScreen: req.attemptsOnScreen,
      asksForHelp: req.asksForHelp,
    });

    session.stepsGuided += 1;
    if (rule.kind === 'back') session.wrongTurns += 1;
    if (rule.guardrail) {
      session.guardrailsTriggered += 1;
      this.telemetry.record({
        type: 'guardrail.blocked',
        sessionId,
        at: startedAt,
        payload: { guardrail: rule.guardrail, nodeId: rule.nodeId },
      });
    }
    if (rule.rescue.triggered) {
      this.telemetry.record({
        type: 'rescue.triggered',
        sessionId,
        at: startedAt,
        payload: { kind: rule.rescue.kind, nodeId: rule.nodeId },
      });
    }

    /* 3. 措辞：模型重写（护栏节点与纠偏节点以外的普通步骤） */
    const screen = SCREENS[req.screenId];
    let instruction = rule.instruction;
    let speak = rule.speak;
    let source: 'llm' | 'rule' = 'rule';
    let confidence = rule.kind === 'back' ? 0.62 : 0.88;
    let reason = rule.reason;

    const allowRewrite = rule.nodeId !== null && !rule.guardrail && (rule.kind === 'tap' || rule.kind === 'input' || rule.kind === 'back');
    if (allowRewrite && node && this.llm.available) {
      const targetLabel = this.labelOf(req.screenId, node.targetControlId);
      const cacheKey = `${node.id}::${req.screenId}::${targetLabel ?? ''}::${session.profile.digitalLiteracy}`;
      const cached = this.rewriteCache.get(cacheKey);
      if (cached) {
        instruction = cached.instruction;
        speak = cached.speak;
        source = 'llm';
        confidence = 0.9;
        reason = `${rule.reason}｜模型：${cached.reason}`;
      } else {
        try {
          const raw = await this.llm.complete(
            {
              system: GUIDE_SYSTEM_PROMPT,
              user: buildGuideUserPrompt({
                flow,
                screen,
                nodeIntent: node.intent,
                ...(targetLabel ? { targetLabel } : {}),
                attemptsOnScreen: req.attemptsOnScreen,
                profile: {
                  age: session.profile.age,
                  livingAlone: session.profile.livingAlone,
                  digitalLiteracy: session.profile.digitalLiteracy,
                },
                ruleInstruction: rule.instruction,
                offPath: rule.kind === 'back',
              }),
              temperature: 0.3,
              maxTokens: 260,
            },
            sessionId,
          );
          const parsed = GuideOutputSchema.safeParse(extractJson(raw));
          if (parsed.success) {
            const safe = sanitizeAssistantText(parsed.data.instruction, rule.instruction, 60);
            if (!safe.rejected) {
              instruction = safe.text;
              speak = normalizeSpeak(parsed.data.speak ?? safe.text, rule.speak);
              source = 'llm';
              confidence = Number(((parsed.data.confidence + 0.9) / 2).toFixed(2));
              reason = `${rule.reason}｜模型：${(parsed.data.reason ?? '').slice(0, 60)}`;
              this.rewriteCache.set(cacheKey, { instruction, speak, reason: (parsed.data.reason ?? '').slice(0, 60) });
            }
          }
        } catch (error) {
          this.telemetry.record({
            type: 'llm.fallback',
            sessionId,
            at: this.clock.now(),
            payload: { stage: 'guide', nodeId: node.id, error: String(error) },
          });
          this.logger.warn({ sessionId, err: String(error) }, '引导话术降级到模板');
        }
      }
    }

    /* 4. 收尾：完成判定 */
    const completed = rule.completed;
    if (completed && !session.finished) {
      session.finished = true;
      this.telemetry.record({
        type: 'task.completed',
        sessionId,
        at: startedAt,
        payload: { taskId: flow.taskId, steps: session.stepsGuided, wrongTurns: session.wrongTurns },
      });
    }
    /* 只读播报节点：播完即视为完成，保证下一次调用进入「已完成」态 */
    if (node?.kind === 'read' && req.screenId === node.screenId) {
      session.completed.add(node.id);
      if (!session.finished) {
        session.finished = true;
        this.telemetry.record({
          type: 'task.completed',
          sessionId,
          at: startedAt,
          payload: { taskId: flow.taskId, steps: session.stepsGuided, wrongTurns: session.wrongTurns },
        });
      }
    }

    const action: GuideAction = {
      kind: rule.kind,
      ...(rule.targetControlId ? { targetControlId: rule.targetControlId } : {}),
      instruction,
      speak,
      ...(rule.guardrail ? { guardrail: rule.guardrail } : {}),
      reason: reason.slice(0, 180),
      confidence,
      stepLabel: rule.stepLabel,
      progress: rule.progress,
      source,
      rescue: rule.rescue,
      latencyMs: this.clock.now() - startedAt,
    };

    if (rule.prefillSlot) {
      const prefill = this.prefillFor(rule.prefillSlot, session);
      if (prefill) action.prefill = prefill;
      const fieldId = this.fieldIdForSlot(req.screenId, rule.prefillSlot);
      if (fieldId) {
        /* 填表节点也要给出可高亮的控件，否则前端不知道该圈哪一格 */
        action.fieldId = fieldId;
        action.targetControlId = fieldId;
      }
    }

    this.telemetry.record({
      type: 'guide.issued',
      sessionId,
      at: startedAt,
      payload: {
        nodeId: rule.nodeId,
        kind: rule.kind,
        source,
        latencyMs: action.latencyMs,
        screenId: req.screenId,
      },
    });

    return action;
  }

  /* ─────────────── 口语填表 ─────────────── */

  async extractSlots(
    sessionId: string,
    utterance: string,
    slotHint?: SlotName,
    label = '当前输入框',
  ): Promise<{ slots: Partial<Record<SlotName, string>>; confidence: number; source: 'llm' | 'rule' }> {
    const session = this.requireSession(sessionId);
    const ruleSlots = slotHint ? {} : extractSlotsByRule(utterance);

    if (!this.llm.available) {
      const fallback = slotHint ? this.singleSlotByRule(utterance, slotHint) : ruleSlots;
      return { slots: fallback, confidence: 0.5, source: 'rule' };
    }

    try {
      const raw = await this.llm.complete(
        {
          system: SLOT_SYSTEM_PROMPT,
          user: buildSlotUserPrompt(utterance, slotHint, label),
          temperature: 0.1,
          maxTokens: 240,
        },
        sessionId,
      );
      const parsed = SlotOutputSchema.safeParse(extractJson(raw));
      if (parsed.success) {
        const slots = this.pickSlots(parsed.data.slots);
        if (Object.keys(slots).length > 0) {
          session.slots = { ...session.slots, ...slots };
          return { slots, confidence: parsed.data.confidence, source: 'llm' };
        }
      }
    } catch (error) {
      this.logger.warn({ sessionId, err: String(error) }, '槽位抽取降级');
    }
    return { slots: slotHint ? this.singleSlotByRule(utterance, slotHint) : ruleSlots, confidence: 0.45, source: 'rule' };
  }

  private singleSlotByRule(utterance: string, slot: SlotName): Partial<Record<SlotName, string>> {
    const extracted = extractSlotsByRule(utterance);
    if (extracted[slot]) return { [slot]: extracted[slot] } as Partial<Record<SlotName, string>>;
    const number = utterance.match(/(\d+(?:\.\d+)?)/);
    if (number?.[1] && (slot === 'householdSize' || slot === 'monthlyIncome')) {
      return { [slot]: number[1] } as Partial<Record<SlotName, string>>;
    }
    return {};
  }

  /* ─────────────── 救援 ─────────────── */

  hotlineScript(sessionId: string): { script: string; hotline: string } {
    const session = this.requireSession(sessionId);
    const flow = session.flow;
    const title = flow?.title ?? '政务服务事项';
    const idTail = session.slots.idCard ? session.slots.idCard.slice(-4) : '****';
    const script = `您好，我是${session.profile.displayName}，今年${session.profile.age}岁，住在${session.profile.region}。我要办的是「${title}」，身份证后四位是 ${idTail}。我自己在手机上操作不了，能不能麻烦您指导一下，或者告诉我最近的窗口在哪里？`;
    session.handoffs += 1;
    this.telemetry.record({
      type: 'rescue.triggered',
      sessionId,
      at: this.clock.now(),
      payload: { kind: 'handoff' },
    });
    return { script, hotline: '12345（政务服务便民热线）' };
  }

  /* ─────────────── 指标 ─────────────── */

  metrics(sessionId: string): SessionMetrics {
    const session = this.requireSession(sessionId);
    const flow = session.flow;
    return {
      stepsGuided: session.stepsGuided,
      wrongTurns: session.wrongTurns,
      guardrailsTriggered: session.guardrailsTriggered,
      handoffs: session.handoffs,
      elapsedMs: this.clock.now() - session.startedAt,
      completed: session.finished,
      baselineSteps: flow?.baselineSteps ?? 0,
      baselineMs: flow?.baselineMs ?? 0,
    };
  }

  /* ─────────────── 内部工具 ─────────────── */

  private requireSession(id: string): SessionState {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`会话不存在或已过期：${id}`);
    return session;
  }

  private clarifyAction(session: SessionState, startedAt: number): GuideAction {
    return {
      kind: 'read',
      instruction: '您先告诉我要办什么事，比如「我要办低保复核」或者「我要交水费」。',
      speak: '先跟我说，您要办啥事。',
      reason: '会话尚未确定办理事项',
      confidence: 0.5,
      stepLabel: '待确认事项',
      progress: { index: 0, total: 0 },
      source: 'rule',
      rescue: { triggered: false, kind: 'none', message: '' } as RescueHint,
      latencyMs: this.clock.now() - startedAt,
      ...(session.profile.hearingImpaired ? {} : {}),
    };
  }

  private labelOf(screenId: ScreenId, controlId?: string): string | undefined {
    if (!controlId) return undefined;
    const screen = SCREENS[screenId];
    for (const block of screen.blocks) {
      if (block.type === 'grid' || block.type === 'list' || block.type === 'actions') {
        const hit = block.items.find((i) => i.id === controlId);
        if (hit) return hit.label;
      } else if (block.type === 'dialog') {
        const hit = block.items.find((i) => i.id === controlId);
        if (hit) return hit.label;
      } else if (block.type === 'form') {
        const hit = block.fields.find((f) => f.id === controlId);
        if (hit) return hit.label;
      }
    }
    return undefined;
  }

  /** 由槽位反查当前屏幕上的表单控件 id，供前端定位输入框 */
  private fieldIdForSlot(screenId: ScreenId, slot: SlotName): string | undefined {
    const screen = SCREENS[screenId];
    for (const block of screen.blocks) {
      if (block.type !== 'form') continue;
      const hit = block.fields.find((field) => field.slot === slot);
      if (hit) return hit.id;
    }
    return undefined;
  }

  private prefillFor(
    slot: SlotName,
    session: SessionState,
  ): { value: string; source: 'profile' | 'last-submission'; label: string } | undefined {
    if (session.slots[slot]) return undefined;
    const profileValue = (session.profile as unknown as Record<string, unknown>)[slot];
    const known: Partial<Record<SlotName, string>> = {
      name: session.profile.displayName,
      idCard: '350102195804120023',
      phone: '13800006021',
      region: session.profile.region,
      householdSize: session.profile.livingAlone ? '1' : '2',
      monthlyIncome: '980',
    };
    const value = known[slot] ?? (typeof profileValue === 'string' ? profileValue : undefined);
    if (!value) return undefined;
    return { value, source: 'profile', label: '按档案帮您填' };
  }
}
