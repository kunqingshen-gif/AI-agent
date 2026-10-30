import type { ActionKind, GuardrailKind, RescueHint, ScreenId, SlotName } from '@shared/types';
import type { FlowNode, TaskFlow } from './catalog';
import { isMandatoryHumanAction } from './guardrails';

/**
 * 确定性引导引擎（Rule Engine）
 *
 * 职责：把「用户此刻在哪一屏 + 已经完成了什么」映射为「下一步该动哪个控件」。
 * 它是整个 Agent 的**正确性底座**：
 *  - 模型可用时，它提供决策依据与白名单；
 *  - 模型不可用/输出不可信时，它独立完成引导（降级路径）。
 */

export interface RuleInput {
  flow: TaskFlow;
  screenId: ScreenId;
  slots: Partial<Record<SlotName, string>>;
  /** 已完成的节点 id */
  completed: ReadonlySet<string>;
  /** 用户在当前屏已停留的交互次数，用于识别乱点 */
  attemptsOnScreen: number;
  asksForHelp: boolean;
}

export interface RuleDecision {
  kind: ActionKind;
  targetControlId?: string;
  instruction: string;
  speak: string;
  guardrail?: GuardrailKind;
  reason: string;
  stepLabel: string;
  progress: { index: number; total: number };
  rescue: RescueHint;
  completed: boolean;
  nodeId: string | null;
  /** 需要用户填写的槽位，前端据此提供一键预填 */
  prefillSlot?: SlotName;
}

const NO_RESCUE: RescueHint = { triggered: false, kind: 'none', message: '' };

function isSatisfied(node: FlowNode, slots: RuleInput['slots'], completed: ReadonlySet<string>): boolean {
  if (node.kind === 'input' && node.slot) {
    return Boolean(slots[node.slot]?.trim());
  }
  return completed.has(node.id);
}

function trapMessage(flow: TaskFlow, screenId: ScreenId): string | null {
  if (screenId === 'wrong.insurance') {
    return '您现在在「医保服务」里，这里没有办低保的地方。按左上角返回，我重新带您走。';
  }
  if (screenId === 'wrong.temp') {
    return '这是「临时救助申请」，是给还没吃低保的人用的。您本来就有低保，办的是「复核」，不是这个。按返回，回列表我指给您看。';
  }
  return flow.trapScreens.includes(screenId) ? '您现在走岔了。按左上角返回，我们回到刚才那一步。' : null;
}

export function decide(input: RuleInput): RuleDecision {
  const { flow, screenId, slots, completed } = input;
  const total = flow.nodes.length;
  const activeIndex = flow.nodes.findIndex((node) => !isSatisfied(node, slots, completed));

  /* 全部节点完成 */
  if (activeIndex === -1) {
    return {
      kind: 'read',
      instruction: `${flow.title}已经办完，您可以退出应用了。办件结果会通过短信通知。`,
      speak: '办完了，等短信就行。',
      reason: '流程图所有节点均已完成',
      stepLabel: '已完成',
      progress: { index: total, total },
      rescue: NO_RESCUE,
      completed: true,
      nodeId: null,
    };
  }

  const node = flow.nodes[activeIndex]!;
  const progress = { index: activeIndex + 1, total };

  /* 人走到了别的屏幕：先纠偏 */
  if (node.screenId !== screenId) {
    const trap = trapMessage(flow, screenId);
    const rescue: RescueHint = {
      triggered: true,
      kind: trap ? 'wrong-screen' : 'stuck',
      message: trap ?? '您离开了办理页面。按左上角返回，我们回到刚才那一步。',
      ...(trap
        ? {
            script: `您好，我在手机上办${flow.title}，现在找不到入口，页面停在别的服务里，能不能麻烦您告诉我从首页哪个位置进去？`,
          }
        : {}),
    };
    return {
      kind: 'back',
      instruction: rescue.message,
      speak: trap ? '走错了，按返回。' : '按左上角返回。',
      reason: `当前屏幕 ${screenId} 与应到达的 ${node.screenId} 不一致`,
      stepLabel: `第 ${progress.index} 步 / 共 ${total} 步`,
      progress,
      rescue,
      completed: false,
      nodeId: node.id,
    };
  }

  /* 乱点识别 */
  const floundering = input.attemptsOnScreen >= 3 || input.asksForHelp;
  const rescue: RescueHint = floundering
    ? {
        triggered: true,
        kind: 'stuck',
        message: '您别急，我再说一遍，慢慢来。',
        script: `您好，我是${'办事人'}的家属，正在办「${flow.title}」，卡在这一步不会操作，能不能电话里指导一下？`,
      }
    : NO_RESCUE;

  const guardrail = node.guardrail;
  const kind: ActionKind = isMandatoryHumanAction(guardrail) ? 'human-confirm' : node.kind === 'input' ? 'input' : node.kind;

  return {
    kind,
    ...(node.targetControlId ? { targetControlId: node.targetControlId } : {}),
    instruction: node.instruction,
    speak: node.speak,
    ...(guardrail ? { guardrail } : {}),
    reason:
      kind === 'human-confirm'
        ? `节点 ${node.id} 命中「${guardrail}」护栏，模型不得代操作，改为引导本人确认`
        : `依据流程图节点 ${node.id}（${node.intent}）`,
    stepLabel: `第 ${progress.index} 步 / 共 ${total} 步`,
    progress,
    rescue,
    completed: false,
    nodeId: node.id,
    ...(node.slot ? { prefillSlot: node.slot } : {}),
  };
}

/** 当前应处理的节点（不产生动作，供服务层判断是否可标记完成） */
export function activeNode(flow: TaskFlow, slots: RuleInput['slots'], completed: ReadonlySet<string>): FlowNode | null {
  const idx = flow.nodes.findIndex((node) => !isSatisfied(node, slots, completed));
  return idx === -1 ? null : flow.nodes[idx]!;
}
