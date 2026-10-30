import { describe, expect, it } from 'vitest';
import { LIFE_ITEMS, scanLifecycle } from '@core/domain/lifecycle';
import { ruleIntent } from '@core/domain/intent-rules';
import { MAX_QUICK_TASKS, quickTasksFrom } from '../src/web/zero';

/**
 * 起手页那三张大按钮的契约。
 *
 * 「老人无成本上手」落到最实的动作，就是这一屏：不用想说什么、不用打字，
 * 看见自己的事点一下。所以这三张卡必须是扫出来的真事、必须能一句话办起来，
 * 不能退化成写死的示例——示例是别人要办的事，老人认不出自己。
 */
describe('起手页常办事项', () => {
  const NOW = new Date('2026-10-30T10:00:00+08:00');

  it('还没扫完时给空数组，页面只留大按钮，不摆假卡片', () => {
    expect(quickTasksFrom(null)).toEqual([]);
  });

  it('只挑能一句话就办起来的事', () => {
    const scan = scanLifecycle(LIFE_ITEMS, NOW);
    const tasks = quickTasksFrom(scan);
    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) {
      expect(ruleIntent(task.utterance)?.taskId, `「${task.utterance}」识别不出来`).toBeDefined();
    }
  });

  it('最急的排第一，且最多三件', () => {
    const scan = scanLifecycle(LIFE_ITEMS, NOW);
    const tasks = quickTasksFrom(scan);
    expect(tasks.length).toBeLessThanOrEqual(MAX_QUICK_TASKS);
    expect(tasks[0]?.label).toBe('本月水费');
    expect(tasks[0]?.hint).toContain('还有');
  });

  it('卡片上写的是「还剩几天」，不是一句抽象的口号', () => {
    const scan = scanLifecycle(LIFE_ITEMS, NOW);
    for (const task of quickTasksFrom(scan)) {
      expect(task.hint).toMatch(/还有|已经/);
      expect(task.label.length).toBeGreaterThan(2);
    }
  });

  it('点下去发出去的话，能落到对应事项上', () => {
    const scan = scanLifecycle(LIFE_ITEMS, NOW);
    const tasks = quickTasksFrom(scan);
    for (const task of tasks) {
      expect(task.utterance.startsWith('我要办')).toBe(true);
    }
    /* 水费、低保复核这两件是老人最常办的，必须识别成不同的事项，不能全落到同一件 */
    const ids = tasks.map((task) => ruleIntent(task.utterance)?.taskId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('没有可办事宜时返回空，不硬凑', () => {
    const scan = scanLifecycle(
      [
        {
          id: 'only.doc',
          title: '低保证明到期',
          dueAt: '2026-11-20',
          kind: 'deadline',
          consequence: '证明失效后复核无法提交。',
          targetScreenId: 'mine.doc.dibao',
        },
      ],
      NOW,
    );
    expect(quickTasksFrom(scan)).toEqual([]);
  });
});
