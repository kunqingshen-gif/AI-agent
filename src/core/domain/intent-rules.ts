import type { Intent, SlotName, TaskId } from '@shared/types';
import { TASK_FLOWS } from './catalog';

/**
 * 规则层意图识别（LLM 不可用时的降级路径，也是 LLM 结果的交叉校验基准）。
 * 打分思路：命中词越长权重越高；同时命中多个事项时取最高分，差距过小则要求澄清。
 */

export interface IntentCandidate {
  taskId: TaskId;
  score: number;
  matched: string[];
}

export function scoreTasks(utterance: string): IntentCandidate[] {
  const text = utterance.replace(/\s+/g, '');
  const candidates: IntentCandidate[] = [];

  for (const flow of Object.values(TASK_FLOWS)) {
    const terms = flow.hotkey.split(/\s+/).filter(Boolean);
    let score = 0;
    const matched: string[] = [];
    for (const term of terms) {
      if (term.length >= 2 && text.includes(term)) {
        score += term.length * 2;
        matched.push(term);
      }
    }
    // 事项标题中的关键片段也算弱命中
    for (const frag of [flow.title.slice(0, 4), flow.category]) {
      if (frag && text.includes(frag)) {
        score += 1;
        matched.push(frag);
      }
    }
    if (score > 0) candidates.push({ taskId: flow.taskId, score, matched });
  }

  return candidates.sort((a, b) => b.score - a.score);
}

const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

/** 把「九百八十」「三口」这类口语数字转成阿拉伯数字；解析失败返回 NaN */
export function cnToNumber(text: string): number {
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  let total = 0;
  let section = 0;
  let digit = 0;
  let seen = false;
  for (const ch of text) {
    if (ch in CN_DIGITS) {
      digit = CN_DIGITS[ch] as number;
      seen = true;
    } else if (ch in CN_UNITS) {
      const unit = CN_UNITS[ch] as number;
      seen = true;
      if (unit === 10000) {
        total = (total + section + digit) * unit;
        section = 0;
      } else {
        section += (digit === 0 ? 1 : digit) * unit;
      }
      digit = 0;
    }
  }
  if (!seen) return Number.NaN;
  return total + section + digit;
}

/** 从口语中抽取可以直接落表的信息 */
export function extractSlotsByRule(utterance: string): Partial<Record<SlotName, string>> {
  const slots: Partial<Record<SlotName, string>> = {};
  const text = utterance.replace(/\s+/g, '');

  const idCard = text.match(/\d{17}[\dXx]/);
  if (idCard) slots.idCard = idCard[0].toUpperCase();

  const phone = text.match(/1[3-9]\d{9}/);
  if (phone) slots.phone = phone[0];

  const household = text.match(/([\d一二两三四五六七八九十]{1,3})\s*(?:口人|个人|人一起|口)/);
  if (household?.[1]) {
    const count = cnToNumber(household[1]);
    if (Number.isFinite(count) && count > 0 && count < 30) slots.householdSize = String(count);
  }

  const money = '([\\d一二两三四五六七八九十百千万]{2,7}(?:\\.\\d+)?)';
  const income =
    text.match(new RegExp(`(?:收入|挣|领|一共|总共|开了|拿到)[^\\d一二三四五六七八九十]{0,6}${money}`)) ??
    text.match(new RegExp(`${money}\\s*(?:块|元)`));
  if (income?.[1]) {
    const amount = cnToNumber(income[1]);
    if (Number.isFinite(amount) && amount >= 0) slots.monthlyIncome = String(amount);
  }

  const city = text.match(/(北京|上海|广州|深圳|杭州|成都|武汉|南京|西安|福州|厦门|天津|重庆)市?/);
  if (city?.[1]) slots.visitCity = `${city[1]}市`;

  return slots;
}

export function ruleIntent(utterance: string): Intent | null {
  const candidates = scoreTasks(utterance);
  const best = candidates[0];
  if (!best || best.score < 4) return null;

  const runnerUp = candidates[1];
  const margin = runnerUp ? best.score - runnerUp.score : best.score;
  const confidence = Math.min(0.95, 0.45 + Math.min(best.score, 10) / 20 + (margin >= 4 ? 0.15 : 0));

  const flow = TASK_FLOWS[best.taskId];
  return {
    taskId: best.taskId,
    confidence: Number(confidence.toFixed(2)),
    slots: extractSlotsByRule(utterance),
    missingSlots: [],
    urgency: /急|马上|今天|截止|到期/.test(utterance) ? 'urgent' : 'normal',
    restated: `您要办的是：${flow.title}`,
    source: 'rule',
    rawUtterance: utterance,
  };
}

export function topSuggestions(utterance: string, limit = 3): TaskId[] {
  const scored = scoreTasks(utterance);
  if (scored.length >= limit) return scored.slice(0, limit).map((c) => c.taskId);
  const rest = (Object.keys(TASK_FLOWS) as TaskId[]).filter((id) => !scored.some((c) => c.taskId === id));
  return [...scored.map((c) => c.taskId), ...rest].slice(0, limit);
}
