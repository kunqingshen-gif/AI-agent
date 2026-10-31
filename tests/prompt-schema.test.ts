import { describe, expect, it } from 'vitest';
import { GuideOutputSchema, PlanOutputSchema } from '@core/application/prompts';

/**
 * 模型输出校验的处置原则。
 *
 * 背景：一次真实事故——让模型规划「高龄津贴」，它把只进日志的 reason 写了 240 字，
 * zod 判整份计划非法，于是老人听到「这件事我暂时答不上来」。
 * 一句解释打掉一份正确计划，这是校验器用错了力。
 *
 * 定下的规矩：**说话长短是文风问题，改；结构缺失是幻觉问题，拒。**
 */

const longReason = '该事项依据《社会救助暂行办法》与地方实施细则办理，'.repeat(12);

function plan(overrides: Record<string, unknown>) {
  return {
    plausible: true,
    title: '高龄津贴申领',
    coverage: 'partial',
    steps: [{ screenId: 'gov.home', goal: '进入办事页', instruction: '点屏幕最上面的搜索框' }],
    ...overrides,
  };
}

describe('规划输出校验', () => {
  it('只有解释写超字数时，计划照样成立，解释被截到 200 字', () => {
    const parsed = PlanOutputSchema.safeParse(plan({ reason: longReason }));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.reason?.length).toBeLessThanOrEqual(200);
      expect(parsed.data.steps).toHaveLength(1);
    }
  });

  it('给老人看的指令超字数时截断，而不是作废', () => {
    const instruction =
      '请您看屏幕最上面那一行，找到一个写着搜索两个字的长方形框，用手指轻轻点一下它，然后再点一次确认，' +
      '点开以后在输入框里打上高龄津贴四个字，最后按一下查询按钮，等结果出来我再说下一步怎么办。';
    expect(instruction.length).toBeGreaterThan(80);
    const parsed = GuideOutputSchema.safeParse({ instruction });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.instruction.length).toBeLessThanOrEqual(80);
      /* 截断后不能只剩标点或无意义的碎片 */
      expect(parsed.data.instruction.length).toBeGreaterThan(10);
    }
  });

  it('截断优先断在标点处，不把一句话砍成半截词', () => {
    const instruction = '先点搜索框，再输入高龄津贴，最后点一下查询按钮并等结果出来，别着急，慢慢来就好';
    const parsed = GuideOutputSchema.safeParse({ instruction });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.instruction.endsWith('，') || parsed.data.instruction.length <= 80).toBe(true);
    }
  });

  it('结构缺失仍然硬拒：没有步骤的计划不许过', () => {
    const parsed = PlanOutputSchema.safeParse(plan({ steps: [] }));
    expect(parsed.success).toBe(false);
  });

  it('屏幕 id 这类结构性字段不做截断，超长即拒', () => {
    const parsed = PlanOutputSchema.safeParse(
      plan({ steps: [{ screenId: 'x'.repeat(41), goal: '进入', instruction: '点一下' }] }),
    );
    expect(parsed.success).toBe(false);
  });
});
