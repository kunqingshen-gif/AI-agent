import type { ScreenId, TaskId } from '@shared/types';

/**
 * 守护日历：办完不是结束。
 *
 * 政务 App 的服务终止于「提交成功」，此后的到期、年检、复核全靠用户自己记，
 * 而记不住正是老年用户最典型的失败模式——养老金认证过期会停发，
 * 低保证明过期会被退回，这些都不弹窗、不打电话，只是某天忽然停了。
 *
 * 这一层把分散在各部门的「时间点」收成一张表，按紧迫度排序，
 * 并给出「现在就该办的那一件」。时间由调用方传入，测试可固定。
 */

export type LifeKind = 'deadline' | 'annual' | 'review' | 'bill';

export interface LifeItem {
  id: string;
  title: string;
  /** 截止日（ISO 日期） */
  dueAt: string;
  kind: LifeKind;
  /** 过了这天会怎样——必须写后果，否则用户不会动 */
  consequence: string;
  relatedTaskId?: TaskId;
  /** 演示版可直接跳转的屏 */
  targetScreenId?: ScreenId;
}

export type LifeUrgency = 'overdue' | 'urgent' | 'soon' | 'later';

export interface LifeEntry extends LifeItem {
  daysLeft: number;
  urgency: LifeUrgency;
  /** 口语说法，例如「还有 6 天」 */
  phrase: string;
  actionLabel: string;
}

export interface LifeScan {
  entries: LifeEntry[];
  /** 最该先办的那一件 */
  next: LifeEntry | null;
  /** 一个月内要处理的件数 */
  dueSoon: number;
  overdue: number;
  summary: string;
}

/**
 * 演示数据：一位 78 岁独居低保老人真实会遇到的五件事。
 * 日期围绕「今天」设置，但写死而不是动态生成——动态生成会让测试失去锚点，
 * 且演示时截图与文档对不上。
 */
export const LIFE_ITEMS: LifeItem[] = [
  {
    id: 'utility.nov',
    title: '本月水费',
    dueAt: '2026-11-05',
    kind: 'bill',
    consequence: '逾期会产生滞纳金，超过 30 天可能停水。',
    relatedTaskId: 'utility.pay',
    targetScreenId: 'utility.bill',
  },
  {
    id: 'dibao.doc',
    title: '低保证明到期',
    dueAt: '2026-11-20',
    kind: 'deadline',
    consequence: '证明失效后，低保复核无法提交，当月救助金会延后发放。',
    targetScreenId: 'mine.doc.dibao',
  },
  {
    id: 'dibao.renew',
    title: '低保资格复核',
    dueAt: '2026-11-30',
    kind: 'review',
    consequence: '半年一次，逾期未复核将暂停低保待遇。',
    relatedTaskId: 'allowance.renew',
    targetScreenId: 'civil.allowance.intro',
  },
  {
    id: 'pension.qualify',
    title: '养老金领取资格认证',
    dueAt: '2027-03-31',
    kind: 'annual',
    consequence: '每年一次，逾期未认证会暂停发放养老金。',
    relatedTaskId: 'pension.qualify',
    targetScreenId: 'pension.qualify.intro',
  },
  {
    id: 'medical.filing',
    title: '异地就医备案到期',
    dueAt: '2027-04-18',
    kind: 'deadline',
    consequence: '到期后在外地住院需先垫全款，再回参保地报销。',
    relatedTaskId: 'medical.filing',
    targetScreenId: 'medical.filing.form',
  },
];

const DAY_MS = 86_400_000;

function startOfDay(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

export function daysLeftOf(iso: string, now: Date): number {
  const parts = iso.split('-').map(Number);
  const y = parts[0] ?? 1970;
  const m = parts[1] ?? 1;
  const d = parts[2] ?? 1;
  return Math.round((Date.UTC(y, m - 1, d) - startOfDay(now)) / DAY_MS);
}

function urgencyOf(days: number): LifeUrgency {
  if (days < 0) return 'overdue';
  if (days <= 7) return 'urgent';
  /* 45 天：老人的准备动作以「月」为单位（约子女、去社区、开证明），30 天太赶 */
  if (days <= 45) return 'soon';
  return 'later';
}

const RANK: Record<LifeUrgency, number> = { overdue: 0, urgent: 1, soon: 2, later: 3 };

function phraseOf(days: number): string {
  if (days < 0) return `已经过了 ${Math.abs(days)} 天`;
  if (days === 0) return '就是今天';
  if (days === 1) return '明天到期';
  return `还有 ${days} 天`;
}

function actionOf(kind: LifeKind, urgency: LifeUrgency): string {
  if (urgency === 'overdue') return '马上补办';
  if (urgency === 'urgent') return '这周内办';
  if (kind === 'review') return '提前准备';
  if (kind === 'bill') return '现在去交';
  if (kind === 'deadline') return '去看看这份材料';
  return '先去办';
}

export function scanLifecycle(items: LifeItem[] = LIFE_ITEMS, now: Date = new Date()): LifeScan {
  const entries: LifeEntry[] = items
    .map((item) => {
      const daysLeft = daysLeftOf(item.dueAt, now);
      const urgency = urgencyOf(daysLeft);
      return { ...item, daysLeft, urgency, phrase: phraseOf(daysLeft), actionLabel: actionOf(item.kind, urgency) };
    })
    .sort((a, b) => RANK[a.urgency] - RANK[b.urgency] || a.daysLeft - b.daysLeft);

  const next = entries[0] ?? null;
  const dueSoon = entries.filter((e) => e.urgency === 'urgent' || e.urgency === 'soon').length;
  const overdue = entries.filter((e) => e.urgency === 'overdue').length;

  let summary: string;
  if (!next) {
    summary = '近期没有到期的事，您可以放心。有新政策我会主动告诉您。';
  } else if (overdue > 0) {
    summary = `有 ${overdue} 件事已经过期了，最急的是「${next.title}」，${next.consequence}`;
  } else if (dueSoon > 0) {
    summary = `未来一个半月有 ${dueSoon} 件事要办。最急的是「${next.title}」，${next.phrase}，${next.consequence}`;
  } else {
    summary = `最近一件是「${next.title}」，${next.phrase}。现在不用急，到时候我会提醒您。`;
  }

  return { entries, next, dueSoon, overdue, summary };
}
