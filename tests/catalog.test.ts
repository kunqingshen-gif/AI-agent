import { describe, expect, it } from 'vitest';
import { extractSlotsByRule, ruleIntent, scoreTasks, topSuggestions } from '@core/domain/intent-rules';
import { TASK_FLOWS } from '@core/domain/catalog';
import { SCREENS, controlExists } from '@shared/screens';

/**
 * 契约测试：任务流程图与屏幕库必须始终自洽。
 * 任何一次改动（新增屏幕、改控件 id）只要破坏契约，CI 立即失败。
 */
describe('任务知识库契约', () => {
  const flows = Object.values(TASK_FLOWS);

  it('每个节点指向的屏幕都存在', () => {
    for (const flow of flows) {
      for (const node of flow.nodes) {
        expect(SCREENS[node.screenId], `${flow.taskId}/${node.id} 屏幕缺失`).toBeDefined();
        expect(SCREENS[node.successScreen], `${flow.taskId}/${node.id} 目标屏幕缺失`).toBeDefined();
      }
    }
  });

  it('每个节点指向的控件都真实存在于该屏幕', () => {
    for (const flow of flows) {
      for (const node of flow.nodes) {
        if (!node.targetControlId) continue;
        expect(controlExists(node.screenId, node.targetControlId), `${flow.taskId}/${node.id} 控件不存在`).toBe(true);
      }
    }
  });

  it('填表节点都能在当前屏幕找到对应表单控件', () => {
    for (const flow of flows) {
      for (const node of flow.nodes) {
        if (node.kind !== 'input' || !node.slot) continue;
        const screen = SCREENS[node.screenId];
        const fields = screen.blocks.flatMap((b) => (b.type === 'form' ? b.fields : []));
        expect(fields.some((f) => f.slot === node.slot), `${flow.taskId}/${node.id} 缺少 ${node.slot} 表单项`).toBe(true);
      }
    }
  });

  it('陷阱屏幕不与该流程的正常节点冲突', () => {
    for (const flow of flows) {
      const normalScreens = new Set(flow.nodes.map((n) => n.screenId));
      for (const trap of flow.trapScreens) {
        expect(normalScreens.has(trap)).toBe(false);
      }
    }
  });

  it('每个流程都以只读播报节点收尾', () => {
    for (const flow of flows) {
      expect(flow.nodes.at(-1)?.kind).toBe('read');
      expect(flow.nodes.at(-1)?.screenId).toBe(flow.terminalScreen);
    }
  });
});

describe('规则层意图识别', () => {
  it('口语「低保那个复核」命中低保复核', () => {
    expect(ruleIntent('我想问一下低保那个复核，今年还没弄呢')?.taskId).toBe('allowance.renew');
  });

  it('把「认证」理解为养老金资格认证', () => {
    expect(ruleIntent('养老金要认证，我不会弄')?.taskId).toBe('pension.qualify');
  });

  it('把「外地看病」理解为异地就医备案', () => {
    expect(ruleIntent('我要去上海看病，医保怎么弄')?.taskId).toBe('medical.filing');
  });

  it('把「交水费」理解为生活缴费', () => {
    expect(ruleIntent('帮我交一下水费')?.taskId).toBe('utility.pay');
  });

  it('完全不相关时返回 null，交给澄清流程', () => {
    expect(ruleIntent('今天天气怎么样')).toBeNull();
  });

  it('打分结果按相关度排序', () => {
    const scored = scoreTasks('低保复核');
    expect(scored[0]?.taskId).toBe('allowance.renew');
    expect(scored.every((c, i) => i === 0 || c.score <= (scored[i - 1]?.score ?? 0))).toBe(true);
  });

  it('澄清时给出候选事项', () => {
    const suggestions = topSuggestions('我要办点事');
    expect(suggestions.length).toBe(3);
  });
});

describe('口语槽位抽取', () => {
  it('抽取人口与收入', () => {
    const slots = extractSlotsByRule('我家就我一个人，上个月领了九百八十块');
    expect(slots.householdSize).toBe('1');
  });

  it('抽取手机号与身份证', () => {
    const slots = extractSlotsByRule('电话是13800006021，身份证350102195804120023');
    expect(slots.phone).toBe('13800006021');
    expect(slots.idCard).toBe('350102195804120023');
  });

  it('抽取就医城市', () => {
    expect(extractSlotsByRule('我要去上海看病').visitCity).toBe('上海市');
  });

  it('抽不到时保持为空，绝不编造', () => {
    expect(extractSlotsByRule('帮我看看这个怎么办')).toEqual({});
  });
});
