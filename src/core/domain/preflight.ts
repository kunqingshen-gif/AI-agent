import type { ScreenId, SlotName, TaskId } from '@shared/types';
import type { MaterialRecord } from '@shared/household';
import { HOUSEHOLD, MATERIAL_LIBRARY, TASK_REQUIREMENTS } from '@shared/household';

/**
 * 办前体检：在用户点「提交」之前，先把退回理由找出来。
 *
 * 政务 App 的通行做法是「提交 → 3 个工作日 → 退回 → 补材料 → 再提交」，
 * 老人往往要跑两三趟才知道缺什么。这里把审核规则前移：
 * 用归集到的材料（含有效期、归属人）和档案槽位做一次模拟审核，
 * 明确回答三件事——**会不会被退回、为什么、现在该去补哪一份**。
 *
 * 边界：
 *  - 只对已收录材料要求的事项做体检，不凭想象编要求；
 *  - 结论是「依据本机材料的预判」，不冒充审批结果，文案里带「以受理窗口为准」；
 *  - 一次办成率是估算值，不做成假精确的 87.3%。
 */

export type PreflightLevel = 'blocker' | 'warning' | 'pass';

export interface PreflightItem {
  materialId: string;
  name: string;
  level: PreflightLevel;
  /** 一句话说清「会怎样」，不是术语 */
  detail: string;
  /** 剩余有效天数，仅在有有效期的材料上出现 */
  daysLeft?: number;
}

export type FixKind = 'renew' | 'obtain' | 'owner' | 'confirm';

export interface PreflightFix {
  label: string;
  kind: FixKind;
  /** 去哪里办、找谁办 */
  where: string;
  /** 可直接念给社区/窗口听的一句话 */
  script: string;
  /** 本产品能直接带过去的事项 */
  relatedTaskId?: TaskId;
  /** 演示版里能跳到的屏幕 */
  targetScreenId?: ScreenId;
}

export interface PreflightResult {
  taskId: TaskId;
  taskTitle: string;
  verdict: 'ready' | 'at-risk' | 'blocked';
  /** 0—100，材料就绪度 */
  score: number;
  /** 估算的一次办成率（百分比整数） */
  onePassRate: number;
  items: PreflightItem[];
  blockers: PreflightItem[];
  warnings: PreflightItem[];
  /** 给用户看的一句话结论 */
  summary: string;
  fixes: PreflightFix[];
  /** 本次预判依据的说明，供评审与审计看懂「凭什么这么说」 */
  basis: string;
}

export interface PreflightInput {
  taskId: TaskId;
  materials?: MaterialRecord[];
  /** 档案里已有的槽位值；缺的会提示「现场要确认」 */
  slots?: Partial<Record<SlotName, string>>;
  now?: Date;
}

const DAY_MS = 86_400_000;

function startOfDay(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

/** 距 ISO 日期还有几天；负数表示已经过期 */
export function daysUntil(iso: string, now: Date): number {
  const parts = iso.split('-').map(Number);
  const y = parts[0] ?? 1970;
  const m = parts[1] ?? 1;
  const d = parts[2] ?? 1;
  return Math.round((Date.UTC(y, m - 1, d) - startOfDay(now)) / DAY_MS);
}

function fmtDate(iso: string): string {
  const parts = iso.split('-');
  return `${parts[0] ?? ''} 年 ${Number(parts[1] ?? 0)} 月 ${Number(parts[2] ?? 0)} 日`;
}

/** 档案默认值：演示环境里这些值都已归集，所以用户不必手打 */
const DEFAULT_SLOTS: Partial<Record<SlotName, string>> = {
  name: HOUSEHOLD.name,
  householdSize: HOUSEHOLD.householdSize,
  monthlyIncome: HOUSEHOLD.monthlyIncome,
  region: HOUSEHOLD.region,
  phone: HOUSEHOLD.phone,
};

const SLOT_LABEL: Partial<Record<SlotName, string>> = {
  name: '姓名',
  idCard: '身份证号',
  phone: '手机号',
  householdSize: '家庭人口',
  monthlyIncome: '月收入',
  region: '户籍地',
  visitCity: '就医城市',
  hospital: '就诊医院',
};

export function preflightCheck(input: PreflightInput): PreflightResult | null {
  const requirement = TASK_REQUIREMENTS[input.taskId];
  if (!requirement) return null;

  const materials = input.materials ?? MATERIAL_LIBRARY;
  const slots = { ...DEFAULT_SLOTS, ...(input.slots ?? {}) };
  const now = input.now ?? new Date();
  const items: PreflightItem[] = [];
  const fixes: PreflightFix[] = [];

  for (const req of requirement.materials) {
    const material = materials.find((m) => m.id === req.materialId);
    if (!material) continue;

    if (material.status === 'missing') {
      /* 必需材料缺失：这是最常见的退回原因，必须前置说清 */
      if (req.required) {
        items.push({
          materialId: material.id,
          name: material.name,
          level: 'blocker',
          detail: `档案里没有这份材料，交上去会被退回。这一份要去${material.issuer}办。`,
        });
        fixes.push({
          label: `去开${material.name}`,
          kind: 'obtain',
          where: material.issuer,
          script: `您好，我要办低保复核，需要一份${material.name}，请问要带什么、多久能开出来？`,
        });
      } else {
        items.push({
          materialId: material.id,
          name: material.name,
          level: 'pass',
          detail: '不是必须材料，缺了不影响受理。',
        });
      }
      continue;
    }

    if (req.mustBeSelf && material.owner !== 'self') {
      items.push({
        materialId: material.id,
        name: material.name,
        level: 'blocker',
        detail: '这份材料登记在家人名下。救助金和待遇只能打到本人账户，用家人的会被退回。',
      });
      fixes.push({
        label: `换成您本人的${material.name}`,
        kind: 'owner',
        where: '发卡银行网点 / 社保卡服务窗口',
        script: '我要把救助金发放账户换成我本人的社保卡，需要带什么？',
      });
      continue;
    }

    if (material.expiresAt) {
      const daysLeft = daysUntil(material.expiresAt, now);
      if (daysLeft < 0) {
        items.push({
          materialId: material.id,
          name: material.name,
          level: 'blocker',
          detail: `这份材料 ${fmtDate(material.expiresAt)}到期，已经过期 ${Math.abs(daysLeft)} 天，提交必被退回。`,
          daysLeft,
        });
        fixes.push({
          label: `先换新的${material.name}`,
          kind: 'renew',
          where: material.issuer,
          script: `我的${material.name}过期了，要办低保复核，请问怎么补办最快？`,
        });
        continue;
      }
      if (req.mustStayValidDays && daysLeft < req.mustStayValidDays) {
        /*
         * 「现在有效」和「办完还有效」是两件事。
         * 审核要 45 天，材料 45 天内到期，中途失效照样退回——
         * 这一类问题用户几乎不可能自己想到，正是体检最该拦下的。
         */
        items.push({
          materialId: material.id,
          name: material.name,
          level: 'warning',
          detail: `现在还有效，但 ${fmtDate(material.expiresAt)}到期（还剩 ${daysLeft} 天），而这次审核大约要 ${req.mustStayValidDays} 天，可能办到一半失效。`,
          daysLeft,
        });
        fixes.push({
          label: `提前把${material.name}续期`,
          kind: 'renew',
          where: material.issuer,
          script: `我的${material.name}下个月到期，能不能现在就换新的，免得复核办到一半失效？`,
        });
        continue;
      }
      items.push({
        materialId: material.id,
        name: material.name,
        level: 'pass',
        detail: `有效，${fmtDate(material.expiresAt)}到期，覆盖整个审核周期。`,
        daysLeft,
      });
      continue;
    }

    items.push({
      materialId: material.id,
      name: material.name,
      level: 'pass',
      detail: material.status === 'verified' ? '已核验，长期有效。' : '已上传，长期有效。',
    });
  }

  /* 档案里拿不到的槽位：不是「材料不齐」，而是「现场要确认一句」 */
  for (const slot of requirement.slots) {
    const value = slots[slot];
    if (value && value.trim()) continue;
    items.push({
      materialId: `slot:${slot}`,
      name: SLOT_LABEL[slot] ?? slot,
      level: 'warning',
      detail: '档案里没有这一项，表单里要现场确认。我可以先按您上次说的填，您再核对。',
    });
    fixes.push({
      label: `确认${SLOT_LABEL[slot] ?? slot}`,
      kind: 'confirm',
      where: '在这台手机上直接确认',
      script: '',
    });
  }

  /* 输出顺序就是阅读顺序：先说会退回的，再说有风险的，最后才是已经合规的 */
  const LEVEL_RANK: Record<PreflightLevel, number> = { blocker: 0, warning: 1, pass: 2 };
  items.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);

  const blockers = items.filter((i) => i.level === 'blocker');
  const warnings = items.filter((i) => i.level === 'warning');
  const verdict: PreflightResult['verdict'] = blockers.length > 0 ? 'blocked' : warnings.length > 0 ? 'at-risk' : 'ready';

  const score = Math.max(0, Math.min(100, 100 - blockers.length * 35 - warnings.length * 12));
  const onePassRate = verdict === 'ready' ? 90 + Math.round(score * 0.08) : verdict === 'at-risk' ? 62 + Math.round(score * 0.12) : 20 + Math.round(score * 0.15);

  return {
    taskId: input.taskId,
    taskTitle: requirement.title,
    verdict,
    score,
    onePassRate: Math.min(96, onePassRate),
    items,
    blockers,
    warnings,
    summary: summaryOf(verdict, blockers, warnings),
    fixes,
    basis: `按「${requirement.title}」的受理要求，比对 ${requirement.materials.length} 份材料与 ${requirement.slots.length} 项档案信息；审核周期按 ${requirement.reviewDays} 天估算。结论为提交前预判，最终以受理窗口为准。`,
  };
}

function summaryOf(
  verdict: PreflightResult['verdict'],
  blockers: PreflightItem[],
  warnings: PreflightItem[],
): string {
  if (verdict === 'blocked') {
    const first = blockers[0];
    const rest = blockers.length > 1 ? `，另外还有 ${blockers.length - 1} 处要补` : '';
    return `「${first?.name ?? '材料'}」还没齐，现在提交会被退回${rest}。补齐再去，能少跑一趟。`;
  }
  if (verdict === 'at-risk') {
    const first = warnings[0];
    return `材料能交上去，但「${first?.name ?? '有一项'}」只剩 ${first?.daysLeft ?? 0} 天就到期，可能办到一半失效。建议先处理再提交。`;
  }
  return '材料齐、都在有效期内，现在提交可以一次办成，不用再来第二趟。';
}
