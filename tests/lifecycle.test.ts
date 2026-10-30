import { describe, expect, it } from 'vitest';
import { LIFE_ITEMS, daysLeftOf, scanLifecycle } from '@core/domain/lifecycle';

/**
 * 守护日历的契约：
 *  1. 排序必须按「还剩几天」，不是按录入顺序——用户只看最上面那一条；
 *  2. 每一件都要写清「过期会怎样」，否则用户不会动；
 *  3. 能直接办的事必须挂上事项，不能只提醒不给路。
 */

const NOW = new Date('2026-10-30T09:00:00+08:00');

describe('天数与紧迫度', () => {
  it('按自然日计算', () => {
    expect(daysLeftOf('2026-10-30', NOW)).toBe(0);
    expect(daysLeftOf('2026-11-05', NOW)).toBe(6);
    expect(daysLeftOf('2026-10-01', NOW)).toBe(-29);
  });

  it('三天以内算急，一个半月以内算要准备', () => {
    const scan = scanLifecycle(LIFE_ITEMS, NOW);
    const bill = scan.entries.find((entry) => entry.id === 'utility.nov');
    const cert = scan.entries.find((entry) => entry.id === 'dibao.doc');
    const pension = scan.entries.find((entry) => entry.id === 'pension.qualify');
    expect(bill?.urgency).toBe('urgent');
    expect(cert?.urgency).toBe('soon');
    expect(pension?.urgency).toBe('later');
  });
});

describe('扫描结果', () => {
  const scan = scanLifecycle(LIFE_ITEMS, NOW);

  it('最急的排在最上面，并且就是 next', () => {
    expect(scan.next?.id).toBe('utility.nov');
    expect(scan.entries[0]?.id).toBe('utility.nov');
    const orders = scan.entries.map((entry) => entry.daysLeft);
    for (let i = 1; i < orders.length; i += 1) {
      expect(orders[i], `第 ${i} 项应当不早于前一项`).toBeGreaterThanOrEqual(orders[i - 1] ?? 0);
    }
  });

  it('一句话说清「最急的是哪件、还有几天、过期会怎样」', () => {
    expect(scan.summary).toContain('本月水费');
    expect(scan.summary).toContain('6 天');
    expect(scan.summary).toContain('停水');
  });

  it('每件都写后果，且能办的事项挂着事由', () => {
    for (const entry of scan.entries) {
      expect(entry.consequence.length, entry.title).toBeGreaterThan(8);
    }
    const renew = scan.entries.find((entry) => entry.id === 'dibao.renew');
    expect(renew?.relatedTaskId).toBe('allowance.renew');
    expect(renew?.targetScreenId).toBe('civil.allowance.intro');
  });

  it('已经过期时优先报逾期，而不是轻描淡写', () => {
    const scan = scanLifecycle(
      [{ id: 'x', title: '低保证明到期', dueAt: '2026-09-01', kind: 'deadline', consequence: '证明失效，复核无法提交，当月救助金延后。' }],
      NOW,
    );
    expect(scan.overdue).toBe(1);
    expect(scan.next?.urgency).toBe('overdue');
    expect(scan.entries[0]?.phrase).toContain('已经过了');
    expect(scan.summary).toContain('已经过期');
  });

  it('没有到期事项时不说空话，也不制造焦虑', () => {
    const scan = scanLifecycle([], NOW);
    expect(scan.next).toBeNull();
    expect(scan.summary).toContain('没有到期');
  });
});
