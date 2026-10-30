import { z } from 'zod';
import type { ScreenModel, SlotName, TaskId } from '@shared/types';
import { GUARDRAIL_KINDS, SLOT_NAMES, TASK_IDS } from '@shared/types';
import { SCREENS } from '@shared/screens';
import type { TaskFlow } from '../domain/catalog';
import type { PlanDraft } from '../domain/plan';

/**
 * 提示词与输出校验。
 * 原则：模型负责「理解」「规划」「措辞」三件事，但**任何一件都不能直接生效**——
 * 规划要过 plan.ts 的屏幕契约与护栏校验，措辞要过 sanitizeAssistantText。
 */

export const GUIDE_SYSTEM_PROMPT = `你是「随行帮办」的办事引导员，服务对象是 60 岁以上、不熟悉智能手机的老年人。

你的唯一任务是：让老人清楚知道「现在手指该点屏幕上的哪个位置」，并且听懂为什么。

硬性要求：
1. 只说一件事，一句话说完，不超过 35 个汉字。
2. 必须引用屏幕上的原字，例如「点蓝色的『开始办理』」。
3. 不出现任何专业术语（不要写"实名认证""活体检测""人脸核验""备案"，改成"照一下您的脸""跟政府说一声"）。
4. 语气像子女在旁边说话，不说"您应当""请务必"。
5. 不承诺办理结果，不编造金额、时限、编号。
6. 绝不指导用户转账、输入密码、提供短信验证码。
7. 只说屏幕上真有的信息。不确定颜色、位置、图标长什么样，就一个字都别提颜色——
   说「点写着『民政服务』的那个」，不要说「点绿色的民政服务」。

只输出 JSON，不要 Markdown：
{"instruction":"一句话指令","speak":"更短的口语播报，20字以内","confidence":0到1的小数,"reason":"一句话说明你依据屏幕上的什么信息"}`;

export const INTENT_SYSTEM_PROMPT = `你是政务事项识别器。输入是老年人说的一句口语（可能带方言词、省略主语、说错名字）。
任务：从给定事项清单中选出最匹配的一项，并抽取能直接落表的信息。

规则：
1. 只能从清单里选；完全对不上时 taskId 填 "unknown"。
2. 口语里的模糊表达要按常识归一：「领钱的」「政府给的补助」→ 结合上下文判断。
3. 抽不到就留空，绝不编造身份证号、手机号、收入。

只输出 JSON：
{"taskId":"清单中的id或unknown","confidence":0到1,"slots":{"name":"","idCard":"","phone":"","householdSize":"","monthlyIncome":"","region":"","visitCity":"","hospital":""},"restated":"用第二人称对用户复述要办什么，如「您要办的是：低保定期复核」","reason":"判断依据"}`;

export const SLOT_SYSTEM_PROMPT = `你是表单助手，服务对象是不识字或看不清屏幕的老年人。
用户会用口语说出表单某一格该填的内容，你要把它转成纯值。

只输出 JSON：{"slots":{"字段名":"值"},"confidence":0到1,"reason":"依据"}
抽不到就返回空对象，绝不猜测。`;

/**
 * 问答提示词。
 *
 * 定位：这个助手不只是「点按钮的机器」，老人问政策、问材料、问这个 App 怎么用，
 * 都要答得上来。但答案必须守三条底线：不编金额时限、不代替官方结论、遇到转账话术先反诈。
 */
export const QUESTION_SYSTEM_PROMPT = `你是「随行帮办」的政务顾问，回答对象是 60 岁以上、不熟悉智能手机的老人。

【回答要求】
1. 先用一句话说清「这是什么」，再补充最多 3 条要点。总字数 160 字以内。
2. 用口语，不用术语。必须出现的术语要顺手解释，例如「备案，就是提前跟医保打个招呼」。
3. 不编造金额、时限、资格线、办结天数。这些一律说「以当地公布为准」。
4. 不做医疗诊断，不替人做法律判断，不给投资建议。
5. 涉及转账、验证码、屏幕共享、陌生链接，必须先提醒这是诈骗，并建议拨 96110 核实。
6. 如果这件事本产品能直接带着办，就在 relatedTaskId 里填对应事项 id；不能办就留空。
7. 完全答不上来时，直说「这个我说不准」，并建议打 12345 或问当地窗口，绝不硬编。

只输出 JSON，不要 Markdown：
{"answer":"一段话回答","points":["要点1","要点2"],"relatedTaskId":null,"confidence":0到1}`;

export const QuestionOutputSchema = z.object({
  answer: z.string().min(4).max(400),
  points: z.array(z.string().min(2).max(80)).max(4).optional(),
  relatedTaskId: z.enum(TASK_IDS).nullish().catch(null),
  confidence: z.number().min(0).max(1).default(0.6),
});

export type QuestionOutput = z.infer<typeof QuestionOutputSchema>;

/** 把命中的知识库条目与可办事项清单给模型，作为事实锚点与转办白名单 */
export function buildQuestionUserPrompt(
  utterance: string,
  hits: Array<{ question: string; answer: string; points: string[] }>,
  tasks: Array<{ taskId: string; title: string }>,
): string {
  return [
    hits.length
      ? `【已知事实（可信，可引用，不要与之矛盾）】\n${hits
          .map((hit) => `· ${hit.question}：${hit.answer}${hit.points.length ? `（要点：${hit.points.join('；')}）` : ''}`)
          .join('\n')}`
      : '【已知事实】无（请基于常识谨慎作答）',
    `【本产品能直接带着办的事项】${tasks.map((t) => `${t.taskId}｜${t.title}`).join('、') || '无'}`,
    `【老人问】${utterance}`,
    '请回答。只输出 JSON。',
  ].join('\n');
}

/**
 * 现场规划提示词。
 *
 * 这是「AI 从话术层进入决策层」的关键：事项库没收录时，由模型排步骤。
 * 但它拿到的不是「随便想」，而是一张**封闭的屏幕与控件白名单**——
 * 只能从表里挑，挑表外的会被校验器直接丢掉。提示词里说三遍，校验器再说一遍。
 */
export const PLAN_SYSTEM_PROMPT = `你是政务办事路径规划师。用户要办的事不在已收录清单里，你要现场规划一条可在当前手机应用里走通的路径。

【第一步：先判断相关性】
原话必须是在说一件「用户想办的、属于政务/生活服务的事」。
闲聊、问候、脏话、问天气、问知识点、无意义字符，一律不算。
不算时只输出 {"plausible":false}，不要输出 title/steps 等任何其他字段。
拿不准时也算不算——宁可拒排，不可把无关的话硬安到一个事项上。

【是办事请求时，遵守以下约束】
1. screenId 与 targetControlId 只能从下面给出的屏幕表里原样复制，不许拼写、不许臆造。
2. 每一步只点一个控件；点完必须能到达下一步所在屏幕。
3. 最多 5 步；到不了终点就停在最后一个你能确定的屏幕，并令 coverage 为 "partial"。
4. 只能用「同一件事」的屏幕。首页、民政服务列表这类入口页所有事项共用；
   其余页面（如低保复核的须知页、表单页）只属于那一件事，别的事不能借用它们。
5. 涉及付钱、人脸、验证码、授权协议、身份证/银行卡号的步骤，必须标 guardrail
   （payment / biometric / captcha / legal-consent / sensitive-info）。系统还会自行复核。
6. 不承诺办理结果，不编造金额、时限、受理编号。
7. instruction 用老人能听懂的口语，必须引用屏幕上的原字，不超过 30 个汉字。
8. 不要描述颜色、图标样式这类屏幕表里没有的信息。说「点写着『民政服务』的那个」，
   不要说「点绿色的民政服务」——老人会照着颜色去找，找不到就不敢点了。

只输出 JSON，不要 Markdown。先判相关性；不相关时：{"plausible":false}
相关时：{"plausible":true,"title":"事项全称","category":"所属类别","documents":["需要带的材料"],"coverage":"full或partial","steps":[{"screenId":"","targetControlId":"","action":"tap或input或read","goal":"这步的目的","instruction":"给老人看的一句话","speak":"20字内口语","guardrail":null}],"reason":"为什么这么排"}`;

/**
 * 把屏幕库压成紧凑白名单，供规划提示词使用。
 *
 * 刻意**不带 semantics 长描述**：17 屏的业务语义加起来近千字，会把提示词推到
 * 3000 token 以上，模型光读就得几秒，规划调用直接顶到超时。屏幕标题（"民政服务"
 * "医保服务"）本身已经说明了业务归属，真正的定位信息是控件标签。
 *
 * 控件也不是全给：文本页、结果页没有可点的东西，给了只是噪声。
 * 只保留首页宫格、列表、按钮组、弹窗按钮与表单字段——这五类才是能指的东西。
 */
export function buildScreenMapPrompt(): string {
  const lines: string[] = ['【可用屏幕与控件（只能从这里挑，原样复制 id）】'];
  for (const screen of Object.values(SCREENS)) {
    const items: string[] = [];
    for (const block of screen.blocks) {
      if (block.type === 'grid' || block.type === 'list' || block.type === 'actions' || block.type === 'dialog') {
        for (const item of block.items) items.push(`${item.id}=${item.label}`);
      } else if (block.type === 'form') {
        for (const field of block.fields) items.push(`${field.id}=${field.label}`);
      }
    }
    if (!items.length) continue;
    lines.push(`${screen.id}｜${screen.title}｜${items.join(', ')}`);
  }
  return lines.join('\n');
}

export function buildPlanUserPrompt(utterance: string, hints: string[]): string {
  return [
    buildScreenMapPrompt(),
    hints.length ? `【用户可能想去的方向】${hints.join('、')}` : '',
    `【老人原话】${utterance}`,
    '请给出一条最多 5 步的路径。只输出 JSON。',
  ]
    .filter(Boolean)
    .join('\n');
}

export const GuideOutputSchema = z.object({
  instruction: z.string().min(2).max(80),
  speak: z.string().min(1).max(60).optional(),
  confidence: z.number().min(0).max(1).default(0.6),
  reason: z.string().max(120).optional(),
});

export const IntentOutputSchema = z.object({
  taskId: z.union([z.enum(TASK_IDS), z.literal('unknown')]),
  confidence: z.number().min(0).max(1),
  slots: z.record(z.string()).optional(),
  restated: z.string().max(60).optional(),
  reason: z.string().max(200).optional(),
});

export const SlotOutputSchema = z.object({
  slots: z.record(z.string()),
  confidence: z.number().min(0).max(1).default(0.5),
  reason: z.string().max(120).optional(),
});

/**
 * 规划输出校验。
 * 这里只管「字段形状对不对」，不管「屏幕和控件真不真」——后者是 plan.ts 的事。
 * 分开的理由：形状错误是模型抽风，契约错误是模型幻觉，两者的处置与埋点不该混在一起。
 *
 * 形状是判别联合：`plausible:false` 时只允许这一个字段（判定不相关就不该再排步骤），
 * `plausible:true`（含缺省）时才是完整计划。
 */
const PlanStepSchema = z.object({
  screenId: z.string().min(1).max(40),
  targetControlId: z.string().max(60).optional(),
  action: z.enum(['tap', 'input', 'read']).default('tap'),
  goal: z.string().min(1).max(60),
  instruction: z.string().min(2).max(80),
  speak: z.string().max(60).optional(),
  guardrail: z.enum(GUARDRAIL_KINDS).nullish().catch(null),
});

export const PlanOutputSchema = z
  .object({
    /** 相关性前置判断：原话不是办事请求时为 false。缺省视为 true（兼容不回该字段的模型） */
    plausible: z.boolean().default(true),
    title: z.string().min(2).max(40).optional(),
    category: z.string().max(20).optional(),
    documents: z.array(z.string().min(1).max(30)).max(6).optional(),
    coverage: z.enum(['full', 'partial']).default('partial'),
    steps: z.array(PlanStepSchema).max(10).optional(),
    reason: z.string().max(200).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.plausible) {
      if (!data.title) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['title'], message: '缺少事项名称' });
      if (!data.steps?.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps'], message: '缺少步骤' });
    } else if (data.steps?.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps'], message: '判定不相关时不应再给出步骤' });
    }
  });

export type PlanOutput = z.infer<typeof PlanOutputSchema>;

/** zod 通过后的形状与 PlanDraft 对齐，供领域层校验器消费。
 * 前置的 superRefine 已保证 plausible 时 title/steps 必在，这里只做形状对齐。 */
export function toPlanDraft(parsed: PlanOutput): PlanDraft {
  return {
    title: parsed.title ?? '',
    ...(parsed.category ? { category: parsed.category } : {}),
    ...(parsed.documents ? { documents: parsed.documents } : {}),
    coverage: parsed.coverage,
    steps: (parsed.steps ?? []).map((step) => ({
      screenId: step.screenId,
      ...(step.targetControlId ? { targetControlId: step.targetControlId } : {}),
      action: step.action,
      goal: step.goal,
      instruction: step.instruction,
      ...(step.speak ? { speak: step.speak } : {}),
      guardrail: step.guardrail ?? null,
    })),
  };
}

export type GuideOutput = z.infer<typeof GuideOutputSchema>;
export type IntentOutput = z.infer<typeof IntentOutputSchema>;
export type SlotOutput = z.infer<typeof SlotOutputSchema>;

/** 从模型返回中提取第一个 JSON 对象，容忍 ```json 包裹与前后废话 */
export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 构造引导场景的用户提示：把「屏幕」翻译成模型能读的清单 */
export function buildGuideUserPrompt(params: {
  flow: TaskFlow;
  screen: ScreenModel;
  nodeIntent: string;
  targetLabel?: string;
  attemptsOnScreen: number;
  profile: { age: number; livingAlone: boolean; digitalLiteracy: string };
  ruleInstruction: string;
  offPath: boolean;
}): string {
  const controls: string[] = [];
  for (const block of params.screen.blocks) {
    if (block.type === 'grid' || block.type === 'list' || block.type === 'actions') {
      block.items.forEach((item) => controls.push(`- ${item.label}（id=${item.id}）`));
    } else if (block.type === 'dialog') {
      block.items.forEach((item) => controls.push(`- [弹窗] ${item.label}（id=${item.id}）`));
    }
  }

  return [
    `【用户】${params.profile.age}岁，${params.profile.livingAlone ? '独居' : '与家人同住'}，数字素养：${params.profile.digitalLiteracy}`,
    `【正在办的事】${params.flow.title}`,
    `【当前屏幕】${params.screen.app} · ${params.screen.title}`,
    `【屏幕说明】${params.screen.semantics}`,
    `【屏幕上的东西】`,
    ...controls.slice(0, 24),
    `【这一步要达到的目的】${params.nodeIntent}`,
    `【只能指向这个控件】${params.targetLabel ?? '（无，仅需口述）'}`,
    `【用户在这页已经乱点了 ${params.attemptsOnScreen} 次】`,
    params.offPath ? '【注意】用户当前不在办理路径上，话术要先指出走错了、再让他返回。' : '',
    `【参考话术】${params.ruleInstruction}`,
    '请按参考话术的意思，用更适合这位老人听的话重写一句。',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildSlotUserPrompt(utterance: string, slotHint: SlotName | undefined, label: string): string {
  const names = SLOT_NAMES.join(' | ');
  return [
    `【当前要填的格】${label}`,
    slotHint ? `【最可能对应的字段】${slotHint}` : '',
    `【可用字段名】${names}`,
    `【老人说的话】${utterance}`,
    '把这句话转成字段值。只输出 JSON。',
  ]
    .filter(Boolean)
    .join('\n');
}

export function isKnownTask(id: string): id is TaskId {
  return (TASK_IDS as readonly string[]).includes(id);
}
