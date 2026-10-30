import type { SlotName, TaskId } from './types';

/**
 * 「我家的档案」——本产品所有个人化判断的唯一数据源。
 *
 * 为什么单独抽一层：闽政通式产品的每个事项各问一遍「你的身份证、户口簿、收入」，
 * 用户永远在重复提交同一批材料，也永远不知道自己那份证明什么时候过期。
 * 把这些事实收敛成一份可复用的档案后，AI 才可能在「还没打开表单」的时候
 * 就回答「您这次会不会被退回」。
 *
 * 演示数据取自福州鼓楼区一位 78 岁独居老人，与屏幕库里的文案保持一致；
 * 真实产品中这一层对应省政务数据共享平台的就绪接口。
 */

export type MaterialStatus = 'verified' | 'uploaded' | 'missing';

export interface MaterialRecord {
  id: string;
  name: string;
  status: MaterialStatus;
  /** 有效期截止日（ISO 日期）；缺省表示长期有效，不需要换证 */
  expiresAt?: string;
  /** 材料登记在谁名下。「打到谁的卡上」「谁的户口」这类要求靠它判断 */
  owner: 'self' | 'family';
  /** 开具/核验渠道，用于生成「去哪儿补」的具体指引 */
  issuer: string;
  note?: string;
}

export const MATERIAL_LIBRARY: MaterialRecord[] = [
  {
    id: 'idcard',
    name: '居民身份证',
    status: 'verified',
    expiresAt: '2032-06-30',
    owner: 'self',
    issuer: '公安人口库（已核验）',
    note: '公安库核验通过，无需重复上传',
  },
  {
    id: 'hukou',
    name: '居民户口簿',
    status: 'uploaded',
    owner: 'self',
    issuer: '鼓楼区公安分局',
    note: '2026-03-12 上传，登记家庭人口 1 人',
  },
  {
    id: 'dibao',
    name: '最低生活保障证明',
    status: 'uploaded',
    expiresAt: '2026-11-20',
    owner: 'self',
    issuer: '鼓楼区民政局',
    note: '每年需重新开具，逾期提交会被退回',
  },
  {
    id: 'bank',
    name: '社会保障卡（金融账户）',
    status: 'verified',
    owner: 'self',
    issuer: '中国农业银行福州鼓楼支行',
    note: '尾号 6621，救助金发放到此账户',
  },
  {
    id: 'income',
    name: '家庭收入证明',
    status: 'missing',
    owner: 'self',
    issuer: '社区居委会（需盖章）',
    note: '低保复核新增要求，此前未提交过',
  },
];

/** 家庭与个人情况。表单里能自动带出的都来自这里，用户不必再手打一遍 */
export const HOUSEHOLD: {
  name: string;
  age: number;
  region: string;
  householdSize: string;
  monthlyIncome: string;
  phone: string;
} = {
  name: '陈依妹',
  age: 78,
  region: '福州市鼓楼区',
  householdSize: '1',
  monthlyIncome: '1180',
  phone: '138****6621',
};

export interface MaterialRequirement {
  materialId: string;
  /** 缺了直接退回 */
  required: boolean;
  /** 必须是本人名下（救助金、待遇类事项不能打在子女卡上） */
  mustBeSelf?: boolean;
  /**
   * 办理周期内不能过期。审核 + 复核通常要 30—60 天，
   * 一份 61 天后到期的证明「现在有效」，但很可能在审核途中失效——
   * 这正是最容易被忽略、也最容易被退回的一类问题。
   */
  mustStayValidDays?: number;
}

export interface TaskRequirement {
  title: string;
  /** 本次办理的审核周期（天），用于「办完之前会不会过期」的判断 */
  reviewDays: number;
  materials: MaterialRequirement[];
  /** 表单必填槽位，缺了算「还要您补一句」而不是「材料不齐」 */
  slots: SlotName[];
}

/**
 * 事项 → 材料要求。
 *
 * 只录入演示版真正接了流程的四个事项；未收录的事项不做体检，
 * 免得凭想象编出一套「要求」，那比不体检更坏。
 */
export const TASK_REQUIREMENTS: Partial<Record<TaskId, TaskRequirement>> = {
  'allowance.renew': {
    title: '最低生活保障（低保）对象定期复核',
    reviewDays: 45,
    materials: [
      { materialId: 'idcard', required: true, mustBeSelf: true, mustStayValidDays: 45 },
      { materialId: 'hukou', required: true },
      { materialId: 'dibao', required: true, mustStayValidDays: 45 },
      { materialId: 'income', required: true },
      { materialId: 'bank', required: true, mustBeSelf: true },
    ],
    slots: ['householdSize', 'monthlyIncome'],
  },
  'pension.qualify': {
    title: '养老金领取资格认证',
    reviewDays: 15,
    materials: [
      { materialId: 'idcard', required: true, mustBeSelf: true },
      { materialId: 'bank', required: true, mustBeSelf: true },
    ],
    slots: [],
  },
  'medical.filing': {
    title: '异地就医备案',
    reviewDays: 10,
    materials: [
      { materialId: 'idcard', required: true, mustBeSelf: true },
      { materialId: 'hukou', required: false },
    ],
    slots: ['visitCity', 'hospital'],
  },
  'utility.pay': {
    title: '生活缴费',
    reviewDays: 0,
    materials: [],
    slots: [],
  },
};

/** 供 UI 展示的「我的档案」摘要 */
export function householdFacts(now: Date = new Date()): Array<{ label: string; value: string }> {
  const valid = MATERIAL_LIBRARY.filter((m) => m.status !== 'missing').length;
  return [
    { label: '家庭人口', value: `${HOUSEHOLD.householdSize} 人` },
    { label: '月收入', value: `¥${HOUSEHOLD.monthlyIncome}` },
    { label: '已归集材料', value: `${valid} / ${MATERIAL_LIBRARY.length} 份` },
    { label: '核验时间', value: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}` },
  ];
}
