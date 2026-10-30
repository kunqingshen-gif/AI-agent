import { z } from 'zod';
import type { ScreenModel, SlotName, TaskId } from '@shared/types';
import { SLOT_NAMES, TASK_IDS } from '@shared/types';
import type { TaskFlow } from '../domain/catalog';

/**
 * 提示词与输出校验。
 * 原则：模型只负责「理解」和「措辞」，不负责「决策」；
 * 所有模型输出必须过 zod + 白名单双重校验，不通过即降级到规则引擎。
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
