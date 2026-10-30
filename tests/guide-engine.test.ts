import { describe, expect, it } from 'vitest';
import { decide } from '@core/domain/guide-engine';
import { TASK_FLOWS } from '@core/domain/catalog';
import type { SlotName } from '@shared/types';

const allowance = TASK_FLOWS['allowance.renew'];
const FILLED: Partial<Record<SlotName, string>> = {
  name: '王秀兰',
  idCard: '350102195804120023',
  phone: '13800006021',
  householdSize: '1',
  monthlyIncome: '980',
};
/** 低保流程里，走到某一步之前必须完成的节点 */
const BEFORE_FORM = ['a1', 'a2', 'a3'];

function run(params: {
  screenId: Parameters<typeof decide>[0]['screenId'];
  slots?: Partial<Record<SlotName, string>>;
  completed?: string[];
  attempts?: number;
  asksForHelp?: boolean;
}) {
  return decide({
    flow: allowance,
    screenId: params.screenId,
    slots: params.slots ?? {},
    completed: new Set(params.completed ?? []),
    attemptsOnScreen: params.attempts ?? 0,
    asksForHelp: params.asksForHelp ?? false,
  });
}

describe('确定性引导引擎', () => {
  it('首步指向民政服务入口', () => {
    const decision = run({ screenId: 'gov.home' });
    expect(decision.kind).toBe('tap');
    expect(decision.targetControlId).toBe('home.grid.minzheng');
    expect(decision.progress.index).toBe(1);
  });

  it('完成一个节点后自动推进到下一步', () => {
    const decision = run({ screenId: 'gov.civil.list', completed: ['a1'] });
    expect(decision.targetControlId).toBe('civil.item.dibao-renew');
    expect(decision.progress.index).toBe(2);
  });

  it('走的不是本流程的页面时要求返回，并带上可念的话术', () => {
    const decision = run({ screenId: 'wrong.insurance' });
    expect(decision.kind).toBe('back');
    expect(decision.rescue.triggered).toBe(true);
    expect(decision.rescue.kind).toBe('wrong-screen');
    expect(decision.instruction).toContain('医保');
    expect(decision.rescue.script).toBeTruthy();
  });

  it('误入临时救助时给出针对性的解释而不是通用话术', () => {
    const decision = run({ screenId: 'wrong.temp' });
    expect(decision.instruction).toContain('临时救助');
    expect(decision.instruction).toContain('复核');
  });

  it('人脸核验节点强制降级为本人确认', () => {
    const decision = run({ screenId: 'civil.allowance.face', completed: [...BEFORE_FORM, 'a9'], slots: FILLED });
    expect(decision.kind).toBe('human-confirm');
    expect(decision.guardrail).toBe('biometric');
    expect(decision.reason).toContain('biometric');
  });

  it('风控弹窗同样要求本人确认', () => {
    const decision = run({
      screenId: 'civil.allowance.risk',
      completed: [...BEFORE_FORM, 'a9', 'a10'],
      slots: FILLED,
    });
    expect(decision.guardrail).toBe('identity');
  });

  it('已填写的槽位会被跳过，引导停在第一个空项', () => {
    const decision = run({
      screenId: 'civil.allowance.form',
      completed: BEFORE_FORM,
      slots: { name: '王秀兰' },
    });
    expect(decision.kind).toBe('input');
    expect(decision.prefillSlot).toBe('idCard');
  });

  it('五项都填好后引导到提交按钮', () => {
    const decision = run({
      screenId: 'civil.allowance.form',
      completed: BEFORE_FORM,
      slots: FILLED,
    });
    expect(decision.targetControlId).toBe('form.btn.submit');
  });

  it('在同一屏反复乱点会触发救援', () => {
    const decision = run({ screenId: 'civil.allowance.intro', completed: ['a1', 'a2'], attempts: 3 });
    expect(decision.rescue.triggered).toBe(true);
    expect(decision.rescue.script).toContain('低保');
  });

  it('全部节点完成后进入收尾态', () => {
    const allNodes = allowance.nodes.map((n) => n.id);
    const decision = run({ screenId: 'civil.allowance.done', completed: allNodes, slots: FILLED });
    expect(decision.completed).toBe(true);
    expect(decision.kind).toBe('read');
  });

  it('切到底部标签不算走错，话术允许先看看别的', () => {
    for (const [screenId, name] of [
      ['gov.service', '服务大厅'],
      ['gov.mine', '我的'],
      ['gov.home', '首页'],
    ] as const) {
      const decision = run({ screenId, completed: ['a1'] });
      expect(decision.kind).toBe('back');
      expect(decision.instruction).toContain(name);
      expect(decision.instruction).toContain('返回');
      expect(decision.instruction).not.toContain('离开了办理页面');
      expect(decision.rescue.kind).toBe('stuck');
    }
  });

  it('进错专区仍然明确纠偏', () => {
    const decision = run({ screenId: 'wrong.insurance', completed: ['a1'] });
    expect(decision.instruction).toContain('医保服务');
    expect(decision.rescue.kind).toBe('wrong-screen');
  });
});
