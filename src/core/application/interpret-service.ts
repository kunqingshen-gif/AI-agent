import type { AnswerPayload, FlowId, Intent, ScreenId, SlotName, TaskId } from '@shared/types';
import { isCustomFlow } from '@shared/types';
import type { ClockPort, LlmPort, TelemetryPort } from '../ports';
import type { Logger } from '@infra/logger';
import type { CollabTicket } from '../domain/collab';
import { TASK_FLOWS, TASK_LIST, type TaskFlow } from '../domain/catalog';
import { looksLikeQuestion, matchFaq } from '../domain/faq';
import { sanitizeAnswer } from '../domain/guardrails';
import { extractSlotsByRule, ruleIntent, topSuggestions } from '../domain/intent-rules';
import { buildFlowFromPlan, type PlanValidation } from '../domain/plan';
import { routeTool, type ToolPayload } from '../domain/tools';
import {
  IntentOutputSchema,
  PlanOutputSchema,
  QuestionOutputSchema,
  SlotOutputSchema,
  buildPlanUserPrompt,
  buildQuestionUserPrompt,
  buildSlotUserPrompt,
  extractJson,
  isKnownTask,
  toPlanDraft,
  type PromptSet,
} from './prompts';
import type { SessionStore } from './session-store';
import type { ToolsService } from './tools-service';

/**
 * 意图与规划。
 *
 * 它回答两个问题：这句话是要办事、要问知识、还是该交给管家看一眼；
 * 以及——事项库没收录的事，模型照着屏幕库能排出一条什么样的路。
 * 排出来的每一步仍要过 domain/plan.ts 的契约与护栏，这一块不拥有「豁免权」。
 *
 * 从 AssistService 独立出来的原因：编排层剩下的职责应该是「把请求交给对的人」，
 * 而不是同时容纳意图识别、现场规划、提示词拼装与问答兜底。
 */

export interface InterpretResult {
  ok: boolean;
  /**
   * 两条并列通道：
   *  - guide：用户要办事 → 进入逐屏引导；
   *  - answer：用户在问知识（政策、材料、这个 App 怎么用）→ 直接回答，不强行拉进流程。
   */
  mode: 'guide' | 'answer' | 'tool';
  intent: Intent | null;
  suggestions: FlowId[];
  message: string;
  source: 'llm' | 'rule' | 'none';
  /** mode === 'answer' 时的回答内容 */
  answer?: AnswerPayload;
  /**
   * mode === 'tool' 时的结果：办前体检 / 守护日历 / 反诈判别 / 协办码。
   *
   * 这四种能力与「办事引导」并列，走同一条入口——用户说完一句话，
   * 由系统决定是带他办、答他问、还是替他查一眼。而不是让他先找入口。
   */
  tool?: ToolPayload;
  /**
   * 本次是否为「AI 现场规划」。前端据此在复述行旁打标，
   * 让评委一眼看出这一条路径不是预置的，是模型当场排的。
   */
  planned?: {
    title: string;
    coverage: 'full' | 'partial';
    steps: number;
    /** 被契约校验拦下或剔除的步骤说明，0 条表示模型一次过 */
    issues: string[];
    injectedGuardrails: string[];
  };
}

export interface InterpretServiceDeps {
  store: SessionStore;
  tools: ToolsService;
  llm: LlmPort;
  prompts: PromptSet;
  telemetry: TelemetryPort;
  clock: ClockPort;
  logger: Logger;
  /** 协办码挂在会话上，由协办模块提供 */
  openCollab: (sessionId: string) => CollabTicket;
  /** 老人换屏：通知陪办的家人 */
  onScreenChange?: (sessionId: string, screenId: ScreenId) => void;
}

export class InterpretService {
  constructor(private readonly deps: InterpretServiceDeps) {}

  /**
   * 把一次工具路由变成可渲染的结果。
   *
   * 返回 null 表示「这次路由其实没东西可说」（比如反诈判别结果是 none），
   * 此时调用方应当继续走原有的办事/问答链路，而不是弹一个空面板。
   */
  private buildTool(sessionId: string, route: ReturnType<typeof routeTool>, utterance: string): { payload: ToolPayload; message: string } | null {
    if (!route) return null;

    if (route.kind === 'preflight') {
      const session = this.deps.store.get(sessionId);
      const fromSession =
        session?.intent && !isCustomFlow(session.intent.taskId) ? (session.intent.taskId as TaskId) : undefined;
      const result = this.deps.tools.preflight(route.taskId ?? fromSession ?? 'allowance.renew');
      if (!result) return null;
      return { payload: { kind: 'preflight', data: result }, message: result.summary };
    }

    if (route.kind === 'scam') {
      const assessment = this.deps.tools.scam(utterance);
      if (assessment.level === 'none') return null;
      return { payload: { kind: 'scam', data: assessment, quote: route.quote }, message: assessment.verdict };
    }

    if (route.kind === 'collab') {
      const ticket = this.deps.openCollab(sessionId);
      return {
        payload: { kind: 'collab', data: ticket },
        message: `协办码 ${ticket.code}，十分钟内有效。念给家人，他在自己手机上输这个码就能陪着您办。`,
      };
    }

    const scan = this.deps.tools.lifecycle();
    return { payload: { kind: 'lifecycle', data: scan }, message: scan.summary };
  }

  /* ─────────────── 意图理解 ─────────────── */

  async interpret(sessionId: string, utterance: string): Promise<InterpretResult> {
    const session = this.deps.store.require(sessionId);
    const ruleBased = ruleIntent(utterance);

    /*
     * ⓪-1 管家通道：这句话可能根本不是在「办某一件事」，而是在问
     *      「我材料够不够」「最近有什么事」「这是不是骗子」「能不能叫人帮我」。
     *
     * 放在问答之前，是因为这四种问题问的都是「我的情况」，不是公共知识：
     * 「我的材料还差什么」不该被答成一段通用的材料清单。
     * 路由不中就安静地往下走，不抢原有链路。
     */
    const route = routeTool(utterance);
    if (route) {
      const built = this.buildTool(sessionId, route, utterance);
      if (built) {
        this.deps.onScreenChange?.(sessionId, session.screenId);
        this.deps.telemetry.record({
          type: 'tool.routed',
          sessionId,
          at: this.deps.clock.now(),
          payload: { kind: route.kind, confidence: route.confidence, quote: route.quote, reason: route.reason },
        });
        return {
          ok: true,
          mode: 'tool',
          intent: null,
          suggestions: [],
          message: built.message,
          source: 'rule',
          tool: built.payload,
        };
      }
    }

    /*
     * ⓪ 问答通道优先：用户是在问知识，不是在要你动手。
     *
     * 这一条解决的是「问正常问题没回答」的硬伤。判定放在规则匹配之前是有意的：
     * 「低保复核要带什么材料」也命中了低保复核的关键词，但用户要的是答案不是流程。
     * 答完给出 relatedTaskId，想办的话一句话就能接着办，两条通道由此打通。
     */
    if (looksLikeQuestion(utterance)) {
      const answer = await this.answerQuestion(sessionId, utterance);
      if (answer) {
        return {
          ok: true,
          mode: 'answer',
          intent: null,
          suggestions: answer.relatedTaskId ? [answer.relatedTaskId] : [],
          message: answer.text,
          source: answer.source,
          answer,
        };
      }
      /* 答不上来也不能拦着不让办事：继续往下走，按办事请求再判断一次 */
    }

    let intent: Intent | null = null;
    let source: InterpretResult['source'] = 'none';
    /** 已收录事项取 catalog；AI 规划的临时事项由规划结果携带 */
    let flow: TaskFlow | null = null;
    let planned: InterpretResult['planned'];

    /* ① 模型识别已收录事项：对口语归一、方言词、说错名字的处理比规则强 */
    if (this.deps.llm.available) {
      try {
        const raw = await this.deps.llm.complete(
          {
            system: this.deps.prompts.intent,
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
          const known = TASK_FLOWS[parsed.data.taskId];
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
            restated: (parsed.data.restated ?? '').replace(/^您要办的是[:：]\s*/, '').trim() || known.title,
            source: 'llm',
            rawUtterance: utterance,
          };
          flow = known;
          source = 'llm';
        } else if (parsed.success && parsed.data.taskId === 'unknown') {
          /*
           * 解析成功但 taskId 是 unknown：模型看懂了，只是这件事确实不在清单里。
           * 这不是降级——接下来第 ③ 步会请它现场排路径。
           */
          this.deps.telemetry.record({
            type: 'intent.not-in-catalog',
            sessionId,
            at: this.deps.clock.now(),
            payload: { utterance: utterance.slice(0, 60) },
          });
        } else {
          this.deps.telemetry.record({
            type: 'llm.fallback',
            sessionId,
            at: this.deps.clock.now(),
            payload: { stage: 'intent', error: 'invalid-output' },
          });
        }
      } catch (error) {
        this.deps.telemetry.record({
          type: 'llm.fallback',
          sessionId,
          at: this.deps.clock.now(),
          payload: { stage: 'intent', error: String(error) },
        });
        this.deps.logger.warn({ sessionId, err: String(error) }, '意图理解降级到规则引擎');
      }
    }

    /* ② 规则兜底：即使模型不可用，已收录的四件事件件能走 */
    if (!intent && ruleBased) {
      intent = ruleBased;
      flow = TASK_FLOWS[ruleBased.taskId];
      source = 'rule';
    }

    /*
     * ③ 都没命中 → 让模型现场排路径。
     *
     * 这是「AI 不只是装饰」的那一层：事项库只有 4 件事，而老人要办的事远不止 4 件。
     * 模型排出来的每一步都要过 plan.ts 的契约校验，过了才允许进入同一个引导循环。
     */
    if (!intent && this.deps.llm.available) {
      const result = await this.planUnknown(sessionId, utterance);
      if (result?.kind === 'planned') {
        intent = result.intent;
        flow = result.flow;
        planned = result.planned;
        source = 'llm';
      } else if (result?.kind === 'offtopic') {
        /*
         * 模型判定原话不是在说办事（闲聊、脏话、问天气）。
         * 不能装傻去规划，也不能说「没学会」——要坦白没听懂，并把话题拉回办事。
         */
        return {
          ok: false,
          mode: 'guide',
          intent: null,
          suggestions: topSuggestions(utterance),
          message: '这句话我没听出要办什么事。您可以说「我要办低保复核」「养老金要认证」这样的话，或者从下面三件里选一件。',
          source,
        };
      }
    }

    if (!intent || !flow) {
      return {
        ok: false,
        mode: 'guide',
        intent: null,
        suggestions: topSuggestions(utterance),
        message: '这件事我暂时答不上来，也不敢乱指。您可以从下面三件里选一件先办着，或者说得再具体一点——比如「高龄津贴要什么条件」。',
        source,
      };
    }

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

    this.deps.telemetry.record({
      type: 'intent.parsed',
      sessionId,
      at: this.deps.clock.now(),
      payload: {
        taskId: intent.taskId,
        confidence: intent.confidence,
        source: intent.source,
        planned: Boolean(planned),
      },
    });

    return {
      ok: true,
      mode: 'guide',
      intent,
      suggestions: [intent.taskId],
      message: intent.restated,
      source,
      ...(planned ? { planned } : {}),
    };
  }

  /**
   * 问答通道。
   *
   * 顺序：模型（带知识库事实锚点）→ 知识库规则 → 答不上来返回 null。
   * 这条链路的意义是：老人问「什么是教育服务」，不该得到「这件事我还没学会」。
   * 但答得再好也不越界——不编金额时限、不代替官方结论、遇到转账话术先反诈。
   */
  private async answerQuestion(sessionId: string, utterance: string): Promise<AnswerPayload | null> {
    const hits = matchFaq(utterance, 2);
    const startedAt = this.deps.clock.now();

    if (this.deps.llm.available) {
      try {
        const raw = await this.deps.llm.complete(
          {
            system: this.deps.prompts.question,
            user: buildQuestionUserPrompt(
              utterance,
              hits.map((hit) => ({ question: hit.question, answer: hit.answer, points: hit.points })),
              TASK_LIST.map((task) => ({ taskId: task.taskId, title: task.title })),
            ),
            temperature: 0.3,
            /* 160 字正文 + 3 条要点 + JSON 包装，500 token 会被截断成非法 JSON，
               实测截断后只能回落知识库，等于白白多等 10 秒 */
            maxTokens: 800,
            /* 问答比改写重、比规划轻；首字冷启动可能到 8—10s，给 15s，失败不熔断主通道 */
            timeoutMs: 15_000,
            bestEffort: true,
          },
          sessionId,
        );
        const parsed = QuestionOutputSchema.safeParse(extractJson(raw));
        if (parsed.success) {
          const fallback = hits[0]?.answer ?? '这个我说不准，建议您打 12345 问一下。';
          const clean = sanitizeAnswer(parsed.data.answer, fallback);
          if (!clean.rejected || hits[0]) {
            const latencyMs = this.deps.clock.now() - startedAt;
            const related = parsed.data.relatedTaskId && isKnownTask(parsed.data.relatedTaskId) ? parsed.data.relatedTaskId : hits[0]?.relatedTaskId;
            this.deps.telemetry.record({
              type: 'answer.served',
              sessionId,
              at: this.deps.clock.now(),
              payload: {
                source: 'llm',
                rejected: clean.rejected,
                reason: clean.reason,
                relatedTaskId: related ?? null,
                latencyMs,
              },
            });
            return {
              text: clean.text,
              points: (parsed.data.points ?? []).slice(0, 3).map((point) => sanitizeAnswer(point, '').text).filter(Boolean),
              ...(related ? { relatedTaskId: related } : {}),
              source: 'llm',
              latencyMs,
            };
          }
        }
        this.deps.telemetry.record({
          type: 'llm.fallback',
          sessionId,
          at: this.deps.clock.now(),
          payload: { stage: 'answer', error: 'invalid-or-unsafe-output' },
        });
      } catch (error) {
        this.deps.telemetry.record({
          type: 'llm.fallback',
          sessionId,
          at: this.deps.clock.now(),
          payload: { stage: 'answer', error: String(error) },
        });
        this.deps.logger.warn({ sessionId, err: String(error) }, '问答降级到知识库');
      }
    }

    const hit = hits[0];
    if (!hit) return null;
    this.deps.telemetry.record({
      type: 'answer.served',
      sessionId,
      at: this.deps.clock.now(),
      payload: { source: 'rule', faqId: hit.id, relatedTaskId: hit.relatedTaskId ?? null },
    });
    return {
      text: hit.answer,
      points: hit.points.slice(0, 3),
      ...(hit.relatedTaskId ? { relatedTaskId: hit.relatedTaskId } : {}),
      source: 'rule',
    };
  }

  /**
   * 未收录事项的现场规划。
   *
   * 返回 null 表示「这个我也不敢排」——调用方据此退回标准话术。
   * 返回 offtopic 表示「原话根本不是在说办事」——调用方给出澄清话术，而不是装傻规划。
   * 各种失败都会留痕：不相关（模型判）、形状不合法（zod）、契约不合法（plan.ts）、调用失败（网络/超时）。
   */
  private async planUnknown(
    sessionId: string,
    utterance: string,
  ): Promise<{ kind: 'planned'; intent: Intent; flow: TaskFlow; planned: NonNullable<InterpretResult['planned']> } | { kind: 'offtopic' } | null> {
    try {
      const hints = topSuggestions(utterance).map((id) => TASK_FLOWS[id].title);
      const raw = await this.deps.llm.complete(
        {
          system: this.deps.prompts.plan,
          user: buildPlanUserPrompt(utterance, hints),
          temperature: 0.2,
          maxTokens: 700,
          /* 规划是一次性重活，用户看得见"正在想"，给足 15s；失败也不熔断主通道 */
          timeoutMs: 15_000,
          bestEffort: true,
        },
        sessionId,
      );
      const parsed = PlanOutputSchema.safeParse(extractJson(raw));
      if (!parsed.success) {
        this.deps.telemetry.record({
          type: 'plan.rejected',
          sessionId,
          at: this.deps.clock.now(),
          payload: { stage: 'schema', error: parsed.error.issues[0]?.message ?? 'invalid' },
        });
        return null;
      }

      /* 相关性闸门：闲聊、脏话、与办事无关的话，一律不排路径 */
      if (!parsed.data.plausible) {
        this.deps.telemetry.record({
          type: 'plan.rejected',
          sessionId,
          at: this.deps.clock.now(),
          payload: { stage: 'off-topic', utterance: utterance.slice(0, 40) },
        });
        return { kind: 'offtopic' };
      }

      const validation: PlanValidation = buildFlowFromPlan(toPlanDraft(parsed.data), utterance);
      if (!validation.ok || !validation.flow) {
        this.deps.telemetry.record({
          type: 'plan.rejected',
          sessionId,
          at: this.deps.clock.now(),
          payload: { stage: 'contract', issues: validation.issues.slice(0, 4) },
        });
        this.deps.logger.warn({ sessionId, issues: validation.issues }, 'AI 规划未通过屏幕契约校验');
        return null;
      }

      const flow = validation.flow;
      this.deps.telemetry.record({
        type: 'plan.created',
        sessionId,
        at: this.deps.clock.now(),
        payload: {
          taskId: flow.taskId,
          title: flow.title,
          steps: flow.nodes.length,
          coverage: validation.coverage,
          droppedSteps: validation.droppedSteps,
          injectedGuardrails: validation.injectedGuardrails,
          issues: validation.issues.slice(0, 4),
        },
      });

      return {
        kind: 'planned',
        intent: {
          taskId: flow.taskId,
          confidence: 0.72,
          slots: extractSlotsByRule(utterance),
          missingSlots: [],
          urgency: /急|马上|今天|截止|到期/.test(utterance) ? 'urgent' : 'normal',
          restated: `您要办的是：${flow.title}。这件事不在常见清单里，我照着屏幕给您排了 ${flow.nodes.length} 步。`,
          source: 'llm',
          rawUtterance: utterance,
        },
        flow,
        planned: {
          title: flow.title,
          /* 覆盖度以校验结果为准：模型说 full、实际被截断，就得如实说只走到这儿 */
          coverage: validation.coverage,
          steps: flow.nodes.length,
          issues: validation.issues,
          injectedGuardrails: validation.injectedGuardrails,
        },
      };
    } catch (error) {
      this.deps.telemetry.record({
        type: 'llm.fallback',
        sessionId,
        at: this.deps.clock.now(),
        payload: { stage: 'plan', error: String(error) },
      });
      this.deps.logger.warn({ sessionId, err: String(error) }, '现场规划失败，退回未收录话术');
      return null;
    }
  }


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

  async extractSlots(
    sessionId: string,
    utterance: string,
    slotHint?: SlotName,
    label = '当前输入框',
  ): Promise<{ slots: Partial<Record<SlotName, string>>; confidence: number; source: 'llm' | 'rule' }> {
    const session = this.deps.store.require(sessionId);
    const ruleSlots = slotHint ? {} : extractSlotsByRule(utterance);

    if (!this.deps.llm.available) {
      const fallback = slotHint ? this.singleSlotByRule(utterance, slotHint) : ruleSlots;
      return { slots: fallback, confidence: 0.5, source: 'rule' };
    }

    try {
      const raw = await this.deps.llm.complete(
        {
          system: this.deps.prompts.slot,
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
      this.deps.logger.warn({ sessionId, err: String(error) }, '槽位抽取降级');
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

}
