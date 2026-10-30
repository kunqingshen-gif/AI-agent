import type { LifeScan } from '@core/domain/lifecycle';

/**
 * 一件常办的事：老人认得出「低保复核」，说不出「我要办低保复核」。
 *
 * 类型放在这里而不是组件里：测试要单独引用它，
 * 一引用 .tsx 就得给测试配 JSX，没必要。
 */
export interface QuickTask {
  label: string;
  hint: string;
  /** 点下去真正发给 Agent 的那句话——比标签啰嗦，但模型更容易识别 */
  utterance: string;
}

/** 起手页最多摆几件：摆多了又变成清单，老人还是要挑，等于没省事 */
export const MAX_QUICK_TASKS = 3;

/**
 * 把「刚扫到的待办」变成起手页那几张大按钮。
 *
 * 两条规矩：
 *   ① 只挑能一句话就办起来的（有 relatedTaskId），否则点下去只是跳一圈；
 *   ② 保持扫描的紧迫度顺序，最急的排第一——老人先按最上面那个就对了。
 *
 * 抽成纯函数是为了能测：这三张卡如果哪天变成写死的示例，
 * 「认得出自己的事」这个卖点就没了。
 */
export function quickTasksFrom(scan: LifeScan | null): QuickTask[] {
  if (!scan) return [];
  return scan.entries
    .filter((entry) => Boolean(entry.relatedTaskId))
    .slice(0, MAX_QUICK_TASKS)
    .map((entry) => ({
      label: entry.title,
      hint: `${entry.phrase} · ${entry.actionLabel}`,
      utterance: `我要办${entry.title}`,
    }));
}
