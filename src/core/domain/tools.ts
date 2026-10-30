import type { TaskId } from '@shared/types';
import { assessScam, type ScamAssessment } from './scam';
import type { PreflightResult } from './preflight';
import type { LifeScan } from './lifecycle';
import type { CollabTicket } from './collab';

/**
 * 工具路由：让四种「管家能力」从自然语言进入，而不是从四个按钮进入。
 *
 * 这是本产品与政务 App 最根本的差别所在。闽政通的每个功能都要求用户先知道
 * 「这件事属于哪个分类、在哪个入口」；而对老人来说，他要说的只是一句话：
 * 「我这份材料还差什么」「我女儿能不能帮我弄」「刚才有人打电话说……」
 *
 * 路由用规则而非模型，三个理由：
 *  1. 快——老人说完就要有反应，等 3 秒就会以为坏了；
 *  2. 稳——误路由的代价是「答非所问」，规则可回归测试，模型不可；
 *  3. 可解释——面板上能写出「因为您提到了『还差什么』」，评审看得见判断依据。
 * 规则不中时返回 null，落回原有的意图识别，不影响既有链路。
 */

export type ToolKind = 'preflight' | 'lifecycle' | 'scam' | 'collab';

export interface ToolRoute {
  kind: ToolKind;
  confidence: number;
  /** 体检针对的事项 */
  taskId?: TaskId;
  /** 用于判别的原话片段 */
  quote: string;
  reason: string;
}

interface Pattern {
  pattern: RegExp;
  confidence: number;
  reason: string;
}

const PREFLIGHT_PATTERNS: Pattern[] = [
  { pattern: /还差(什么|哪|哪些)|缺(什么|哪|哪些)|少(什么|哪)/, confidence: 0.92, reason: '问「还缺什么」，属于提交前的材料核对' },
  { pattern: /(够|齐|全)不(够|齐|全)|齐了(吗|没)|材料.{0,3}(齐|全)/, confidence: 0.9, reason: '问材料是否齐全' },
  { pattern: /能(不能|否)?(一次)?办成|会不会(被)?退回|会不会白跑|退回来/, confidence: 0.9, reason: '问能不能一次办成' },
  { pattern: /(体检|预检|先看看).{0,6}(材料|能不能办)/, confidence: 0.88, reason: '明确要求做办前检查' },
  { pattern: /我这(份|些).{0,4}(证明|材料).{0,4}(行|有用|有效)/, confidence: 0.86, reason: '问手上这份材料管不管用' },
];

const LIFECYCLE_PATTERNS: Pattern[] = [
  { pattern: /(有|哪)(什么|哪些).{0,4}(事|要办).{0,4}(要办|该办|到期)?/, confidence: 0.9, reason: '问「有什么事要办」' },
  { pattern: /(快要?|即将|马上).{0,4}(到期|截止)|到期(了|的)/, confidence: 0.9, reason: '问到期事项' },
  { pattern: /(最近|接下来|这段时间).{0,4}(要办|该办|有事)/, confidence: 0.88, reason: '问近期安排' },
  { pattern: /(办事|办理).{0,2}日历|提醒(一下|我).{0,4}(要办|到期)/, confidence: 0.86, reason: '要求列出待办日历' },
  { pattern: /我(还)?有(没有)?(什么|啥).{0,4}(没办|要办)/, confidence: 0.88, reason: '问有没有漏办的事' },
];

const COLLAB_PATTERNS: Pattern[] = [
  { pattern: /(女儿|儿子|孩子|家人|老伴|亲戚|邻居|帮办员|社区).{0,6}(帮我|远程|看着|教|一起)/, confidence: 0.9, reason: '希望家人或帮办员远程陪着办' },
  { pattern: /远程.{0,4}(帮|协助|看)|协办|叫人(来)?帮|找人帮/, confidence: 0.88, reason: '要求远程协办' },
  { pattern: /(我|他|她).{0,2}(弄|搞)不(会|来|定).{0,6}(帮|教)/, confidence: 0.82, reason: '承认不会操作并寻求帮助' },
];

/** 诈骗判别的强特征：命中任一即进入反诈通道，优先级最高 */
const SCAM_TRIGGER = /诈骗|骗子|骗人|被骗|可疑(电话|短信|信息)|冒充|安全账户|涉嫌|涉案|洗钱|通缉|冻结|验证码|屏幕共享|不要告诉家里人|别告诉家里人/;

const TASK_WORDS: Array<{ taskId: TaskId; pattern: RegExp }> = [
  { taskId: 'allowance.renew', pattern: /低保|复核|最低生活保障|救助/ },
  { taskId: 'pension.qualify', pattern: /养老|退休|资格认证|生存认证/ },
  { taskId: 'medical.filing', pattern: /异地就医|备案|医保|住院|报销/ },
  { taskId: 'utility.pay', pattern: /水费|电费|燃气|缴费|交费/ },
];

function matchAny(text: string, patterns: Pattern[]): { pattern: Pattern; quote: string } | null {
  for (const pattern of patterns) {
    const hit = pattern.pattern.exec(text);
    if (hit) return { pattern, quote: hit[0] };
  }
  return null;
}

function detectTask(text: string): TaskId | undefined {
  return TASK_WORDS.find((entry) => entry.pattern.test(text))?.taskId;
}

export function routeTool(text: string): ToolRoute | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length < 3) return null;

  /*
   * 反诈优先。
   * 「有人打电话让我把低保的钱转到安全账户」同时像「低保办事」和「诈骗」，
   * 这种时候先按风险处理——钱出去了就回不来，办事晚一天没有损失。
   */
  const scamHit = SCAM_TRIGGER.exec(normalized);
  if (scamHit) {
    const assessment = assessScam(normalized);
    if (assessment.level !== 'none') {
      return {
        kind: 'scam',
        confidence: 0.95,
        quote: scamHit[0],
        reason: `听到「${scamHit[0]}」，按反诈通道处理（命中 ${assessment.hits.length} 个风险特征）`,
      };
    }
  }

  const preflight = matchAny(normalized, PREFLIGHT_PATTERNS);
  if (preflight) {
    const taskId = detectTask(normalized);
    return {
      kind: 'preflight',
      confidence: preflight.pattern.confidence,
      ...(taskId ? { taskId } : {}),
      quote: preflight.quote,
      reason: preflight.pattern.reason,
    };
  }

  const collab = matchAny(normalized, COLLAB_PATTERNS);
  if (collab) {
    return {
      kind: 'collab',
      confidence: collab.pattern.confidence,
      quote: collab.quote,
      reason: collab.pattern.reason,
    };
  }

  const lifecycle = matchAny(normalized, LIFECYCLE_PATTERNS);
  if (lifecycle) {
    return {
      kind: 'lifecycle',
      confidence: lifecycle.pattern.confidence,
      quote: lifecycle.quote,
      reason: lifecycle.pattern.reason,
    };
  }

  return null;
}


/**
 * 一次工具调用的结果，直接给前端渲染。
 *
 * 用判别联合而不是 `{ kind, data: any }`：前端的每个分支拿到的都是具体类型，
 * 少写一个分支编译就报错——评审看代码时也能一眼看出四种能力各自返回什么。
 */
export type ToolPayload =
  | { kind: 'preflight'; data: PreflightResult }
  | { kind: 'lifecycle'; data: LifeScan }
  | { kind: 'scam'; data: ScamAssessment; quote: string }
  | { kind: 'collab'; data: CollabTicket };
