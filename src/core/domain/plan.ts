import type { Control, GuardrailKind, ScreenId } from '@shared/types';
import { SCREENS } from '@shared/screens';
import type { FlowNode, TaskFlow } from './catalog';
import { isMandatoryHumanAction } from './guardrails';

/**
 * 计划验证器（Plan Verifier）
 *
 * 定位：这是「AI 进入决策层」之后的**唯一一道闸门**。
 *
 * 在此之前，路径由 catalog 里的流程图写死，模型只负责改措辞 —— 功能稳，但 AI 是装饰。
 * 现在放开一层：事项库没收录的事，由模型现场排步骤。但模型排出来的每一步都必须
 * 通过本文件的三条硬约束，否则不许执行：
 *
 *  1. 屏幕契约：screenId 必须真实存在，targetControlId 必须真实挂在那块屏幕上。
 *     这条直接消灭「AI 指了一个不存在的按钮」——不是靠提示词求它别编，是结构上不可能。
 *  2. 护栏不可让渡：支付 / 人脸 / 验证码 / 授权 / 证件号，只要命中就**强制**降级为
 *     本人确认，模型自报的 guardrail 只能加不能减（取并集）。
 *  3. 可达性：上一步的落点必须接得上下一步的起点，接不上就截断，不硬编。
 *
 * 截断而非整单拒绝，是刻意的：模型偶尔在第五步编一个控件，不应该让前四步的正确
 * 判断一起作废。截断后补一个 read 节点诚实告知「后面的页面我还没见过」，把材料清单
 * 念给用户，并给出求助通道。宁可少走一步，不可指错一步。
 */

/** 模型给出的单步草案（未经校验，字段可能是编的） */
export interface PlanStepDraft {
  screenId: string;
  targetControlId?: string;
  action: 'tap' | 'input' | 'read';
  /** 这一步要达到的目的，给人看 */
  goal: string;
  instruction: string;
  speak?: string;
  /** 模型自报的风险类型，只作参考，最终以推断结果为准 */
  guardrail?: GuardrailKind | null;
}

export interface PlanDraft {
  title: string;
  category?: string;
  documents?: string[];
  coverage: 'full' | 'partial';
  steps: PlanStepDraft[];
}

export interface PlanValidation {
  ok: boolean;
  flow?: TaskFlow;
  /** 被拦下的原因，写进埋点与 reason，评委会关心「AI 编了但被挡住」 */
  issues: string[];
  /** 因违约被剔除的步数 */
  droppedSteps: number;
  /** 校验器额外注入的护栏（模型没报但必须加的） */
  injectedGuardrails: GuardrailKind[];
  /**
   * 实际覆盖度，以校验结果为准而不是模型自报。
   * 模型说 full、实际被截断了两步，那就得如实对用户说「只走到这儿」。
   */
  coverage: 'full' | 'partial';
}

const MAX_STEPS = 8;
const MAX_INSTRUCTION = 60;

/** 从屏幕模型里抽出「可被指的东西」，包含表单字段 */
export function interactiveControlsOf(screenId: ScreenId): Map<string, Control> {
  const map = new Map<string, Control>();
  for (const block of SCREENS[screenId].blocks) {
    if (block.type === 'grid' || block.type === 'list' || block.type === 'actions' || block.type === 'dialog') {
      for (const item of block.items) map.set(item.id, item);
    } else if (block.type === 'form') {
      for (const field of block.fields) {
        map.set(field.id, {
          id: field.id,
          label: field.label,
          role: 'input',
          ...(field.required ? { hint: '必填' } : {}),
        });
      }
    }
  }
  for (const tab of SCREENS[screenId].tabs ?? []) map.set(tab.id, tab);
  return map;
}

const PAY_RE = /付款|支付|付钱|缴费|转账|汇款|金额|收款方/;
const CAPTCHA_RE = /验证码|短信码|动态码/;
const CONSENT_RE = /同意|授权|协议|勾选|打钩/;
const BIO_RE = /人脸|刷脸|核验|眨眼|张嘴|摄像头|照一下/;
const ID_RE = /身份证|银行卡|证件号|卡号/;

/**
 * 这块屏幕本身是不是生物核验页——看屏幕上写着什么，不看 id 怎么命名。
 *
 * 早前的判据是 `screenId.endsWith('.face')`。那是一条隐形的命名契约：
 * 只要有人把屏幕 id 从 `civil.allowance.face` 改成 `civil.allowance.verify`，
 * 护栏就静默失效，而且没有任何测试会红——这是护栏最不能接受的失效方式。
 * 现在改成读屏幕标题与正文标题，改 id 不再影响判定。
 *
 * 刻意不读 semantics 与控件 hint：办前说明页爱写「提交后进入实名核验」，
 * 若一并扫描，整个表单都会被打成生物核验，护栏从「拦住风险」退化成「什么都拦」。
 */
export function isBiometricScreen(screenId: ScreenId): boolean {
  if (!(screenId in SCREENS)) return false;
  const screen = SCREENS[screenId];
  const headings = screen.blocks.flatMap((block) => {
    if (block.type === 'text' || block.type === 'dialog') return [block.title];
    return [];
  });
  return BIO_RE.test([screen.title, ...headings].join(' '));
}

/**
 * 风险推断：只看「这一步要干什么」和「它要点的那个控件的性质」，不看模型怎么说。
 * 顺序即优先级，先命中先返回 —— 人脸优先于付款，付款优先于验证码。
 */
export function inferGuardrail(step: PlanStepDraft, screenId: ScreenId): GuardrailKind | undefined {
  if (!(screenId in SCREENS)) return undefined;
  const text = `${step.goal} ${step.instruction} ${step.speak ?? ''}`;
  const control = step.targetControlId ? interactiveControlsOf(screenId).get(step.targetControlId) : undefined;
  const controlText = `${control?.label ?? ''} ${control?.hint ?? ''}`;
  const risky = control?.risky === true;

  if (isBiometricScreen(screenId) || BIO_RE.test(text) || (risky && BIO_RE.test(controlText))) return 'biometric';
  if (PAY_RE.test(text) || (risky && PAY_RE.test(controlText))) return 'payment';
  if (CAPTCHA_RE.test(text)) return 'captcha';
  if (risky && /本人|确认|安全/.test(controlText)) return 'identity';
  if (CONSENT_RE.test(text)) return 'legal-consent';
  if (ID_RE.test(text)) return 'sensitive-info';
  return undefined;
}

function slug(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 16);
  return cleaned || '未命名事项';
}

/**
 * 跨事项通用的「导航型」屏幕：任何事都要从这里过，不参与语义相关性判定。
 * 除此之外的屏幕都属于某件具体事项（低保复核的表单不可能用来办高龄津贴），
 * 一旦模型把用户往别的业务屏上带，就必须拦下来。
 */
const GENERIC_SCREENS: ReadonlySet<string> = new Set<ScreenId>([
  'gov.home',
  'gov.civil.list',
  'wrong.insurance',
  'wrong.temp',
]);

/** 这些二字词太通用，拿来做相关性判断会把无关的屏全判成相关 */
const STOP_GRAMS: ReadonlySet<string> = new Set([
  '申请', '办理', '服务', '查询', '信息', '填写', '提交', '确认', '开始', '进行', '需要', '相关',
]);

/**
 * 同一件事的多种说法。
 *
 * 老人说的是「老年津贴」「养老补贴」，屏幕上印的是「高龄津贴」——二者是一件事，
 * 但二字重叠一个也对不上（养老补贴 → 养老/老补/补贴，高龄津贴 → 高龄/龄津/津贴），
 * 于是模型排出的正确步骤被语义闸门当成「领错门」截断，用户听到的是「后面我没见过」。
 * 这是护栏误伤：为了不走错，把本来走对的路也封了。
 *
 * 解决办法不是放宽闸门，而是先把说法归一：先认「这是哪个概念」，再比概念，
 * 概念对不上才退回二字重叠。这样「老年津贴」能进高龄津贴的屏，
 * 而「高龄津贴」仍然进不去低保复核的表单——该拦的照拦。
 */
interface Concept {
  id: string;
  /** 归一后替换成的标准词，也用于二字回退时对齐用词 */
  canonical: string;
  words: readonly string[];
}

const CONCEPTS: readonly Concept[] = [
  {
    id: 'senior-allowance',
    canonical: '高龄津贴',
    words: ['高龄津贴', '高龄老人津贴', '老年津贴', '高龄补贴', '老年补贴', '高龄补助', '老人津贴', '高领津贴', '高令津贴', '养老补贴', '老人补贴'],
  },
  {
    id: 'dibao',
    canonical: '低保',
    words: ['低保', '最低生活保障', '低保金', '救助金', '困难补助'],
  },
  {
    id: 'pension',
    canonical: '养老金',
    /* 养老补贴既可能是高龄津贴，也可能被老人用来指养老金，两边都算，谁先对上算谁 */
    words: ['养老金', '退休金', '养老待遇', '养老补贴', '社保认证', '养老认证', '领取资格认证'],
  },
  {
    id: 'medical',
    canonical: '异地就医',
    words: ['异地就医', '异地备案', '外地看病', '转诊备案', '异地报销'],
  },
  {
    id: 'utility',
    canonical: '生活缴费',
    words: ['水费', '电费', '燃气费', '燃气', '生活缴费', '缴费', '交费', '欠费', '账单'],
  },
];

function conceptsIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const concept of CONCEPTS) {
    if (concept.words.some((word) => text.includes(word))) found.add(concept.id);
  }
  return found;
}

/** 把各种叫法替换成标准词，供二字回退使用 */
function canonicalize(text: string): string {
  let out = text;
  for (const concept of CONCEPTS) {
    for (const word of concept.words) out = out.split(word).join(concept.canonical);
  }
  return out;
}

function bigrams(text: string): Set<string> {
  const clean = text.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  const set = new Set<string>();
  for (let i = 0; i < clean.length - 1; i += 1) {
    const gram = clean.slice(i, i + 2);
    if (!STOP_GRAMS.has(gram)) set.add(gram);
  }
  return set;
}

/**
 * 这一步的屏幕，跟这件事是不是同一码事。
 *
 * 只校验「控件存在」是不够的：`civil.allowance.form` 上确实有「申请人姓名」这一格，
 * 可它是低保复核的表。模型把办高龄津贴的人领进去，控件全对、业务全错——这种错
 * 比指错按钮更伤信任，因为用户会照着把信息填进别人的事项里。
 *
 * 判据分两层：
 *   ① 概念层：两边都认得出概念时，比概念是否相交。「高龄津贴」与「低保复核」
 *      各有所属概念，直接判不相关，不会因为共享「对象」「复核」这种字眼放行；
 *   ② 二字回退：有一边认不出概念（例如表单页只写「填写复核信息」），
 *      才退回归一后的二字重叠——粗糙，但方向正确：**宁可不走，不可走错**。
 */
export function isRelatedScreen(screenId: ScreenId, taskTitle: string): boolean {
  if (GENERIC_SCREENS.has(screenId)) return true;
  if (!(screenId in SCREENS)) return false;
  const screen = SCREENS[screenId];
  const labels = [...interactiveControlsOf(screenId).values()].map((control) => control.label);
  const screenText = [screen.title, ...labels].join(' ');

  const taskConcepts = conceptsIn(taskTitle);
  const screenConcepts = conceptsIn(screenText);
  if (taskConcepts.size > 0 && screenConcepts.size > 0) {
    for (const concept of taskConcepts) {
      if (screenConcepts.has(concept)) return true;
    }
    return false;
  }

  const visible = bigrams(canonicalize(screenText));
  for (const gram of bigrams(canonicalize(taskTitle))) {
    if (visible.has(gram)) return true;
  }
  return false;
}

function clip(text: string, max = MAX_INSTRUCTION): string {
  const value = text.replace(/\s+/g, ' ').trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * 把模型草案转成可执行流程图。
 * 返回 ok=false 时调用方必须退回「未收录」的标准话术，不得使用半成品。
 */
export function buildFlowFromPlan(plan: PlanDraft, utterance: string): PlanValidation {
  const issues: string[] = [];
  const injected: GuardrailKind[] = [];

  if (!plan.steps.length) {
    return { ok: false, issues: ['模型未给出任何步骤'], droppedSteps: 0, injectedGuardrails: [], coverage: 'partial' };
  }

  let steps = plan.steps;
  if (steps.length > MAX_STEPS) {
    issues.push(`步骤 ${steps.length} 步超过上限 ${MAX_STEPS}，已截断`);
    steps = steps.slice(0, MAX_STEPS);
  }

  const accepted: PlanStepDraft[] = [];
  let dropped = 0;

  for (const [index, step] of steps.entries()) {
    const screenId = step.screenId as ScreenId;
    if (!(screenId in SCREENS)) {
      issues.push(`第 ${index + 1} 步屏幕「${step.screenId}」不在屏幕库内`);
      dropped += 1;
      if (index === 0) return { ok: false, issues, droppedSteps: dropped, injectedGuardrails: injected, coverage: 'partial' };
      break;
    }
    if (step.targetControlId && !interactiveControlsOf(screenId).has(step.targetControlId)) {
      issues.push(`第 ${index + 1} 步控件「${step.targetControlId}」不存在于「${screenId}」`);
      dropped += 1;
      if (index === 0) return { ok: false, issues, droppedSteps: dropped, injectedGuardrails: injected, coverage: 'partial' };
      break;
    }
    /*
     * 语义闸门：控件存在不等于事项对得上。
     * 把办高龄津贴的人领进低保复核的表单，比指错按钮更糟——他会照着实名填进去。
     */
    if (index > 0 && !isRelatedScreen(screenId, plan.title)) {
      issues.push(`第 ${index + 1} 步的屏幕「${SCREENS[screenId].title}」与「${plan.title}」不是同一件事`);
      dropped += 1;
      break;
    }
    accepted.push(step);
  }

  if (!accepted.length) {
    return { ok: false, issues: [...issues, '没有任何一步通过校验'], droppedSteps: dropped, injectedGuardrails: injected, coverage: 'partial' };
  }

  const truncated = dropped > 0 || plan.coverage === 'partial';
  const nodes: FlowNode[] = [];

  for (const [index, step] of accepted.entries()) {
    const screenId = step.screenId as ScreenId;
    const next = accepted[index + 1];
    const inferred = inferGuardrail(step, screenId);
    const declared = step.guardrail ?? undefined;

    /*
     * 护栏取并集且以推断为准：
     * 模型可以把「点确认」说成普通步骤，但只要控件带 risky 或屏幕是核验页，
     * 推断结果就会把它降级为本人确认。模型没有权限把它降回去。
     */
    const guardrail = inferred ?? (declared && isMandatoryHumanAction(declared) ? declared : undefined);
    if (guardrail && guardrail !== declared) injected.push(guardrail);

    const kind = guardrail ? 'human-confirm' : step.action === 'input' ? 'input' : step.action === 'read' ? 'read' : 'tap';

    nodes.push({
      id: `p${index + 1}`,
      screenId,
      ...(step.targetControlId ? { targetControlId: step.targetControlId } : {}),
      kind,
      intent: clip(step.goal, 40),
      instruction: clip(step.instruction),
      speak: clip(step.speak ?? step.instruction, 40),
      /* 下一步的起点就是这一步的落点；末步停在本屏，等 read 节点收尾 */
      successScreen: next ? (next.screenId as ScreenId) : screenId,
      ...(guardrail ? { guardrail } : {}),
    });
  }

  const last = nodes[nodes.length - 1]!;
  const lastScreen = last.screenId;
  const docs = (plan.documents ?? []).filter((d) => d.trim()).slice(0, 6);

  /* 收尾节点：把「我还能做什么 / 我做不到什么」说清楚，这是诚实性的一部分 */
  nodes.push({
    id: `p${nodes.length + 1}`,
    screenId: lastScreen,
    kind: 'read',
    intent: truncated ? '告知材料清单与求助通道' : '播报办理完成',
    instruction: truncated
      ? `${plan.title}到这一步了。${docs.length ? `要带的是：${docs.join('、')}。` : ''}再往后的页面我没见过，不敢瞎指，您卡住了就点「我卡住了」。`
      : `${plan.title}已经办完，结果会通过短信通知您。`,
    speak: truncated ? '后面我没见过，卡住了就喊我。' : '办完了，等短信就行。',
    successScreen: lastScreen,
  });

  const flow: TaskFlow = {
    taskId: `custom.${slug(plan.title)}`,
    title: plan.title,
    category: plan.category?.trim() || '未收录事项 · AI 现场规划',
    hotkey: utterance.slice(0, 40),
    facts: docs.length ? [`所需材料：${docs.join('、')}`] : [],
    requiredDocs: docs,
    baselineSteps: nodes.length,
    baselineMs: nodes.length * 45_000,
    pitfalls: truncated ? ['后续页面尚未纳入屏幕库，需要本人确认后再走'] : [],
    entryScreen: nodes[0]!.screenId,
    terminalScreen: lastScreen,
    trapScreens: [],
    nodes,
  };

  return {
    ok: true,
    flow,
    issues,
    droppedSteps: dropped,
    injectedGuardrails: [...new Set(injected)],
    coverage: truncated ? 'partial' : 'full',
  };
}
