/**
 * 随行帮办 · 共享契约层
 *
 * 本文件是前后端唯一的事实来源（single source of truth）：
 *  - 服务的「屏幕模型」与前端渲染的「屏幕模型」是同一份数据结构，
 *    因此 Agent 读到的控件与用户看到的控件天然一致。
 *  - 生产环境中该结构由 Android AccessibilityService / 无障碍节点树映射而来，
 *    演示环境由本地屏幕库提供，二者遵循同一接口，见 docs/adr/0002。
 */

/* ────────────────────────── 事项 ────────────────────────── */

export const TASK_IDS = ['allowance.renew', 'pension.qualify', 'medical.filing', 'utility.pay'] as const;
export type TaskId = (typeof TASK_IDS)[number];

/**
 * 事项标识。
 *
 * 已收录事项用固定的 TaskId；事项库没收录、由模型现场规划的临时事项用 `custom.` 前缀。
 * 加这个前缀不是为了好看：它让「有流程图背书的事项」与「AI 现编的事项」在日志、埋点、
 * 指标里天然可区分，评审看事件流就能分清哪一步是 catalog 保证的、哪一步是模型推的。
 */
export type FlowId = TaskId | `custom.${string}`;
export function isCustomFlow(id: string): id is `custom.${string}` {
  return id.startsWith('custom.');
}

/* ────────────────────────── 屏幕 ────────────────────────── */

export const SCREEN_IDS = [
  'gov.home',
  'gov.service',
  'gov.mine',
  'gov.edu.list',
  'gov.civil.list',
  /* 服务大厅的第二层：主题专区（服务大厅宫格 / 人生阶段点进来的结果页） */
  'gov.all',
  'topic.shebao',
  'topic.huji',
  'topic.gongjijin',
  'topic.shuwu',
  'topic.birth',
  'topic.school',
  'topic.work',
  'topic.retire',
  'topic.pass',
  /* 我的：办件进度、材料详情、家人代办 */
  'mine.elder',
  'mine.doc.idcard',
  'mine.doc.hukou',
  'mine.doc.dibao',
  'mine.doc.bank',
  'mine.family',
  /* 尚未接入演示的事项统一落到这里——有说明、有出路，不是死路 */
  'gov.todo',
  'civil.allowance.intro',
  'civil.allowance.form',
  'civil.allowance.face',
  'civil.allowance.risk',
  'civil.allowance.done',
  'wrong.insurance',
  'wrong.temp',
  'pension.qualify.intro',
  'pension.qualify.face',
  'pension.qualify.done',
  'medical.filing.form',
  'medical.filing.done',
  'utility.bill',
  'utility.pay.confirm',
  'utility.done',
] as const;
export type ScreenId = (typeof SCREEN_IDS)[number];

export type ControlRole = 'button' | 'link' | 'input' | 'tab' | 'icon' | 'listItem';

export interface Control {
  /** 控件唯一标识，同一屏幕内唯一；Agent 只能指向已存在于此表的控件 */
  id: string;
  label: string;
  role: ControlRole;
  /** 补充说明，模拟无障碍节点的 contentDescription */
  hint?: string;
  /** 是否为「危险动作」候选（支付、授权、删除、提交实名信息） */
  risky?: boolean;
}

export type ScreenBlock =
  | { type: 'search'; id: string; placeholder: string }
  | { type: 'grid'; id: string; columns: number; items: Control[] }
  | { type: 'list'; id: string; items: Control[] }
  | { type: 'text'; id: string; title?: string; paragraphs: string[] }
  | { type: 'notice'; id: string; tone: 'info' | 'warn' | 'danger'; text: string }
  | { type: 'form'; id: string; fields: FormField[] }
  | { type: 'actions'; id: string; items: Control[] }
  | { type: 'dialog'; id: string; title: string; text: string; items: Control[] }
  | { type: 'result'; id: string; title: string; lines: string[] }
  /** 个人信息卡：头像、姓名、认证状态、几个关键数值 */
  | { type: 'profile'; id: string; name: string; badge: string; meta: string[]; stats: Array<{ label: string; value: string }> };

export interface FormField {
  id: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  kind: 'text' | 'idcard' | 'phone' | 'number' | 'select' | 'upload';
  /** 供 Agent 预填 / 校验的槽位名 */
  slot?: SlotName;
  options?: string[];
}

export interface ScreenModel {
  id: ScreenId;
  /** 所属应用，用于跨应用场景 */
  app: '政务服务平台' | '医保服务平台' | '生活缴费';
  title: string;
  blocks: ScreenBlock[];
  /** 底部导航 */
  tabs?: Control[];
  /** 该屏幕的「业务语义」，帮助 LLM 判断用户此刻位置 */
  semantics: string;
  /** 演示用的「一次性陷阱」：用户在此屏可能踩到的坑，用于评估迷路 */
  traps?: string[];
}

/* ────────────────────────── 用户与意图 ────────────────────────── */

export const SLOT_NAMES = ['name', 'idCard', 'phone', 'householdSize', 'monthlyIncome', 'region', 'visitCity', 'hospital'] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

export interface UserProfile {
  displayName: string;
  age: number;
  region: string;
  /** 数字素养，决定话术密度与字号建议 */
  digitalLiteracy: 'low' | 'medium' | 'high';
  /** 是否独居（决定是否优先推荐子女代办 / 社区帮办） */
  livingAlone: boolean;
  /** 听觉是否受限（决定是否强制文字 + 震动替代语音） */
  hearingImpaired?: boolean;
  /** 常用方言，影响播报用词 */
  dialect?: '普通话' | '闽南语' | '粤语' | '四川话';
}

export interface Intent {
  taskId: FlowId;
  confidence: number;
  slots: Partial<Record<SlotName, string>>;
  missingSlots: SlotName[];
  urgency: 'normal' | 'urgent';
  /** 面向用户的一句话复述，用于「先确认再动手」 */
  restated: string;
  source: 'llm' | 'rule';
  rawUtterance: string;
}

/* ────────────────────────── 问答 ────────────────────────── */

/**
 * 一次问答的结果。
 *
 * 「有问必答」是本产品对老人的承诺：问政策、问材料、问这个 App 怎么用，
 * 都不该回一句「这件事我还没学会」。所以问答与引导是两条并列通道：
 * 问答给知识，引导给动作，二者通过 relatedTaskId 打通。
 */
export interface AnswerPayload {
  /** 主体回答，口语，160 字以内 */
  text: string;
  /** 最多 3 条要点 */
  points: string[];
  /** 这事本产品能直接办时给出事项 id，前端提供「直接去办」 */
  relatedTaskId?: TaskId;
  source: 'llm' | 'rule';
  latencyMs?: number;
}

/* ────────────────────────── 护栏 ────────────────────────── */

export const GUARDRAIL_KINDS = ['payment', 'identity', 'biometric', 'captcha', 'legal-consent', 'sensitive-info'] as const;
export type GuardrailKind = (typeof GUARDRAIL_KINDS)[number];

export const GUARDRAIL_COPY: Record<GuardrailKind, { title: string; body: string }> = {
  payment: {
    title: '这一步涉及付钱，我不替您按',
    body: '凡是需要付钱、输入密码、开通免密的操作，都必须由您本人看清楚金额和收款方后自己确认。',
  },
  identity: {
    title: '这一步在提交您的身份信息',
    body: '身份证号、银行卡号属于敏感信息，我不会替您输入，也不会读出来。请确认屏幕上是官方应用。',
  },
  biometric: {
    title: '这一步需要您本人在场',
    body: '人脸识别必须由本人完成，任何要求您对着镜头「点头、眨眼、读数字」并转账的，都是诈骗。',
  },
  captcha: {
    title: '这一步是验证码',
    body: '验证码只填在官方应用里。任何人通过电话、短信向您索要验证码，都不要给。',
  },
  'legal-consent': {
    title: '这一步是授权协议',
    body: '授权协议涉及您的权利，请让家人或窗口人员帮您逐条确认后再同意。',
  },
  'sensitive-info': {
    title: '这一步涉及敏感信息',
    body: '请确认周围没有陌生人，且屏幕未被他人共享。',
  },
};

/* ────────────────────────── 引导动作 ────────────────────────── */

export type ActionKind = 'tap' | 'input' | 'back' | 'read' | 'human-confirm' | 'handoff';

export interface RescueHint {
  triggered: boolean;
  kind: 'wrong-screen' | 'stuck' | 'face-failed' | 'blocked' | 'none';
  message: string;
  /** 可直接念给窗口/热线听的话术 */
  script?: string;
}

export interface GuideAction {
  kind: ActionKind;
  /** 目标控件，必须存在于当前屏幕模型 */
  targetControlId?: string;
  /** 面向用户的大字指令 */
  instruction: string;
  /** 语音播报文本（更口语，更短） */
  speak: string;
  guardrail?: GuardrailKind;
  /** 当前步骤对应的表单控件 id（仅在填表节点出现） */
  fieldId?: string;
  /** 一键预填建议：来自用户档案或上次填报，减少真实操作步数 */
  prefill?: { value: string; source: 'profile' | 'last-submission'; label: string };
  /** 给评委/审计看的判断依据，体现「AI 为什么这么走」 */
  reason: string;
  confidence: number;
  stepLabel: string;
  progress: { index: number; total: number };
  source: 'llm' | 'rule';
  rescue: RescueHint;
  latencyMs: number;
}

/* ────────────────────────── 会话与指标 ────────────────────────── */

export interface SessionClock {
  startedAt: number;
  updatedAt: number;
}

export interface AssistRequest {
  sessionId: string;
  screenId: ScreenId;
  /** 已填写的槽位值（由前端从表单同步，模拟无障碍读取） */
  slots: Partial<Record<SlotName, string>>;
  /** 用户在本屏已停留的交互次数，用于识别「反复乱点」 */
  attemptsOnScreen: number;
  /** 用户主动求助 */
  asksForHelp: boolean;
  /**
   * 用户刚刚点下的控件 id（可读屏环境里就是无障碍事件）。
   *
   * 为什么需要它：有些入口点下去之后没有下一页（演示库未收录、或对方 App 停在当前页），
   * 只靠「屏幕变了没有」无法判断这一步算不算走通，会让人卡在原地被反复要求点同一个地方。
   */
  tappedControlId?: string;
}

export interface SessionMetrics {
  stepsGuided: number;
  wrongTurns: number;
  guardrailsTriggered: number;
  handoffs: number;
  elapsedMs: number;
  completed: boolean;
  baselineSteps: number;
  baselineMs: number;
  /** 用户对这一单的结果反馈；没反馈就是 undefined */
  feedback?: FeedbackVerdict;
}

/**
 * 用户对「这一单办成没有」的反馈。
 *
 * 三个选项刻意不对等：
 *  - worked：办成了。用于算真实一次办成率。
 *  - failed：没办成，但指引没说错（比如窗口关门了）。用于区分「产品问题」与「外部原因」。
 *  - wrong：**它说错了**。这是唯一能反哺提示词和知识库的信号，权重最高。
 *
 * 不设「一般 / 满意」这类模糊选项：老人不会填量表，只会回答「办成没有」。
 */
export type FeedbackVerdict = 'worked' | 'failed' | 'wrong';


export interface TaskSpecSummary {
  taskId: TaskId;
  title: string;
  category: string;
  hotkey: string;
  requiredDocs: string[];
  baselineSteps: number;
  baselineMs: number;
  pitfalls: string[];
}
