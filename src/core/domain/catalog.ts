import type { FlowId, GuardrailKind, ScreenId, SlotName, TaskId, TaskSpecSummary } from '@shared/types';

/**
 * 任务知识库（Task Catalog）
 *
 * 每个事项由「业务事实」+「确定性流程图」构成：
 *  - 业务事实：受理条件、材料、时限、常见坑，供 LLM 生成话术时引用（RAG-lite）
 *  - 流程图：有序节点，每个节点声明「在哪个屏幕、让用户动哪个控件、动了之后到哪」，
 *    这是规则引擎的确定性路径，也是 LLM 输出必须通过的白名单
 */

export type NodeKind = 'tap' | 'input' | 'human-confirm' | 'read';

export interface FlowNode {
  id: string;
  screenId: ScreenId;
  /** 目标控件；input 类节点由 slot 反查表单控件，可为空 */
  targetControlId?: string;
  kind: NodeKind;
  /** 给模型理解这个节点要干什么（不直接展示给用户） */
  intent: string;
  /** 规则引擎兜底话术 */
  instruction: string;
  speak: string;
  /** 完成本节点后应到达的屏幕 */
  successScreen: ScreenId;
  guardrail?: GuardrailKind;
  /** 依赖的槽位：若未就绪则本节点暂不执行 */
  slot?: SlotName;
}

export interface TaskFlow {
  /** 已收录事项为 TaskId；AI 现场规划的临时事项为 custom.xxx */
  taskId: FlowId;
  title: string;
  category: string;
  /** 触发词，用于规则层意图识别与展示 */
  hotkey: string;
  /** 受理条件与材料，供话术引用 */
  facts: string[];
  requiredDocs: string[];
  deadline?: string;
  baselineSteps: number;
  baselineMs: number;
  pitfalls: string[];
  entryScreen: ScreenId;
  terminalScreen: ScreenId;
  /** 该事项的「看起来像但走错」页面，用于纠偏话术 */
  trapScreens: ScreenId[];
  nodes: FlowNode[];
}

const allowanceFlow: TaskFlow = {
  taskId: 'allowance.renew',
  title: '最低生活保障（低保）对象定期复核',
  category: '民政救助',
  hotkey: '低保 复核 复审 年审 最低生活保障',
  facts: [
    '正在享受低保待遇的对象每半年需参加一次资格复核',
    '复核内容为家庭人口、收入、财产三项变动',
    '逾期未复核会暂停发放低保金，补办后可恢复',
    '低保复核与「临时救助申请」是两个不同事项，不要走错',
  ],
  requiredDocs: ['居民身份证', '居民户口簿', '近三个月收入证明或银行流水', '社会保障卡或银行账户'],
  deadline: '2026年11月30日',
  baselineSteps: 12,
  baselineMs: 520000,
  pitfalls: [
    '首页误点「医保服务」，进去后没有任何低保入口',
    '在民政服务 24 项长列表里误点「临时救助申请」',
    '表单 5 个必填项，漏一项就会被打回重填',
    '人脸核验失败三次后不知道该找谁',
  ],
  entryScreen: 'gov.home',
  terminalScreen: 'civil.allowance.done',
  trapScreens: ['wrong.insurance', 'wrong.temp'],
  nodes: [
    {
      id: 'a1',
      screenId: 'gov.home',
      targetControlId: 'home.grid.minzheng',
      kind: 'tap',
      intent: '从政务首页进入民政服务专区',
      instruction: '先点第 4 个方块，写着「民政服务」的那个。',
      speak: '点民政服务，第四个方块。',
      successScreen: 'gov.civil.list',
    },
    {
      id: 'a2',
      screenId: 'gov.civil.list',
      targetControlId: 'civil.item.dibao-renew',
      kind: 'tap',
      intent: '在民政服务列表中定位「最低生活保障对象定期复核」',
      instruction: '往下划，找「最低生活保障对象定期复核」这一行，点它。',
      speak: '往下滑，找最低生活保障对象定期复核。',
      successScreen: 'civil.allowance.intro',
    },
    {
      id: 'a3',
      screenId: 'civil.allowance.intro',
      targetControlId: 'intro.btn.apply',
      kind: 'tap',
      intent: '阅读须知后开始办理',
      instruction: '这页是告诉您要带什么材料，看最后一行日期，然后点最下面蓝色的「开始办理」。',
      speak: '看完点开始办理。',
      successScreen: 'civil.allowance.form',
    },
    {
      id: 'a4',
      screenId: 'civil.allowance.form',
      kind: 'input',
      slot: 'name',
      intent: '填写申请人姓名',
      instruction: '第一个格子写您的名字。我帮您填好了，您核对一下对不对。',
      speak: '第一个格子，写名字。',
      successScreen: 'civil.allowance.form',
    },
    {
      id: 'a5',
      screenId: 'civil.allowance.form',
      kind: 'input',
      slot: 'idCard',
      intent: '填写身份证号',
      instruction: '第二个格子是身份证 18 位号码，我照档案填，您看最后四位对不对。',
      speak: '第二个格子，身份证号。',
      successScreen: 'civil.allowance.form',
    },
    {
      id: 'a6',
      screenId: 'civil.allowance.form',
      kind: 'input',
      slot: 'phone',
      intent: '填写联系电话',
      instruction: '第三个格子填电话，办好了会发短信到这个号码。',
      speak: '第三个格子，写电话。',
      successScreen: 'civil.allowance.form',
    },
    {
      id: 'a7',
      screenId: 'civil.allowance.form',
      kind: 'input',
      slot: 'householdSize',
      intent: '填写家庭共同生活人口数',
      instruction: '第四个格子问「家里几口人一起过」，把您自己也数进去。',
      speak: '第四个格子，家里几口人。',
      successScreen: 'civil.allowance.form',
    },
    {
      id: 'a8',
      screenId: 'civil.allowance.form',
      kind: 'input',
      slot: 'monthlyIncome',
      intent: '填写家庭上月总收入',
      instruction: '第五个格子填上个月家里一共进了多少钱，写数字就行。',
      speak: '第五个格子，上个月一共多少钱。',
      successScreen: 'civil.allowance.form',
    },
    {
      id: 'a9',
      screenId: 'civil.allowance.form',
      targetControlId: 'form.btn.submit',
      kind: 'tap',
      intent: '提交复核申请',
      instruction: '都填好了，点最底下蓝底的「提交复核申请」。',
      speak: '点提交。',
      successScreen: 'civil.allowance.face',
    },
    {
      id: 'a10',
      screenId: 'civil.allowance.face',
      targetControlId: 'face.btn.start',
      kind: 'human-confirm',
      guardrail: 'biometric',
      intent: '人脸识别必须本人完成，AI 不代为操作',
      instruction: '这一步要照您的脸，必须您自己按「开始核验」。把口罩摘了，我等着。',
      speak: '摘口罩，自己按开始核验。',
      successScreen: 'civil.allowance.risk',
    },
    {
      id: 'a11',
      screenId: 'civil.allowance.risk',
      targetControlId: 'risk.btn.confirm',
      kind: 'human-confirm',
      guardrail: 'identity',
      intent: '风控弹窗要求确认本人操作',
      instruction: '弹出来的是安全提示，问我是不是您本人。是您本人，您自己点左边的「确认是本人操作」。',
      speak: '是您本人，就点确认。',
      successScreen: 'civil.allowance.done',
    },
    {
      id: 'a12',
      screenId: 'civil.allowance.done',
      kind: 'read',
      intent: '播报受理结果并提示后续',
      instruction: '办好了。受理编号 FZ2026102900371，11 月 12 号前出结果，会发短信给您。这页您截个图，或者我帮您存下来。',
      speak: '办好了，结果会发短信。',
      successScreen: 'civil.allowance.done',
    },
  ],
};

const pensionFlow: TaskFlow = {
  taskId: 'pension.qualify',
  title: '养老保险待遇领取资格认证',
  category: '社会保险',
  hotkey: '养老金 认证 资格认证 社保认证 领养老金',
  facts: ['每年需完成一次资格认证，周期 12 个月', '逾期未认证将暂停发放养老金', '可由家属协助，但活体检测须本人完成'],
  requiredDocs: ['居民身份证'],
  baselineSteps: 8,
  baselineMs: 380000,
  pitfalls: ['很多老人把「认证」理解成「去社保局排队」', '活体检测对光线和动作要求高，容易失败'],
  entryScreen: 'gov.home',
  terminalScreen: 'pension.qualify.done',
  trapScreens: ['wrong.temp'],
  nodes: [
    {
      id: 'p1',
      screenId: 'gov.home',
      targetControlId: 'home.grid.shebao',
      kind: 'tap',
      intent: '进入社保服务',
      instruction: '点第 1 个方块「社保服务」。',
      speak: '点社保服务。',
      successScreen: 'pension.qualify.intro',
    },
    {
      id: 'p2',
      screenId: 'pension.qualify.intro',
      targetControlId: 'pension.intro.btn.start',
      kind: 'tap',
      intent: '开始资格认证',
      instruction: '这页是说明，看最下面，点「开始认证」。',
      speak: '点开始认证。',
      successScreen: 'pension.qualify.face',
    },
    {
      id: 'p3',
      screenId: 'pension.qualify.face',
      targetControlId: 'pension.face.btn.start',
      kind: 'human-confirm',
      guardrail: 'biometric',
      intent: '活体检测须本人完成',
      instruction: '要眨眼张嘴，必须您自己按。对着亮的地方，别背光。',
      speak: '自己按，对着亮的地方。',
      successScreen: 'pension.qualify.done',
    },
    {
      id: 'p4',
      screenId: 'pension.qualify.done',
      kind: 'read',
      intent: '播报认证结果',
      instruction: '认证成功，明年 10 月 29 号之前再认证一次就行。',
      speak: '认证成功了。',
      successScreen: 'pension.qualify.done',
    },
  ],
};

const medicalFlow: TaskFlow = {
  taskId: 'medical.filing',
  title: '异地就医备案',
  category: '医疗保险',
  hotkey: '异地 就医 备案 外地看病 医保报销 住院 看病 转诊',
  facts: ['异地就医前完成备案，可直接结算，否则需先垫付再回参保地报销', '备案有效期通常为一年', '需上传居住证明或转诊证明'],
  requiredDocs: ['身份证或医保电子凭证', '居住证明 / 转诊证明'],
  baselineSteps: 9,
  baselineMs: 460000,
  pitfalls: ['「备案」和「报销」是两件事，先备案才能直接结算', '就医地选到区县一级，选错会影响结算'],
  entryScreen: 'gov.home',
  terminalScreen: 'medical.filing.done',
  trapScreens: ['wrong.temp'],
  nodes: [
    {
      id: 'm1',
      screenId: 'gov.home',
      targetControlId: 'home.grid.yibao',
      kind: 'tap',
      intent: '进入医保服务专区',
      instruction: '点第 2 个方块「医保服务」。这次是对的。',
      speak: '点医保服务。',
      successScreen: 'wrong.insurance',
    },
    {
      id: 'm2',
      screenId: 'wrong.insurance',
      targetControlId: 'insurance.item.remote',
      kind: 'tap',
      intent: '进入异地就医备案',
      instruction: '点第二行「异地就医备案」。',
      speak: '点异地就医备案。',
      successScreen: 'medical.filing.form',
    },
    {
      id: 'm3',
      screenId: 'medical.filing.form',
      kind: 'input',
      slot: 'visitCity',
      intent: '选择就医地',
      instruction: '第一栏选您要去看病的城市。',
      speak: '第一栏，选城市。',
      successScreen: 'medical.filing.form',
    },
    {
      id: 'm4',
      screenId: 'medical.filing.form',
      targetControlId: 'medical.btn.submit',
      kind: 'human-confirm',
      guardrail: 'identity',
      intent: '提交备案，涉及身份与医保信息',
      instruction: '都填好了，您自己按「提交备案」。',
      speak: '自己按提交。',
      successScreen: 'medical.filing.done',
    },
    {
      id: 'm5',
      screenId: 'medical.filing.done',
      kind: 'read',
      intent: '播报备案结果与有效期',
      instruction: '备案生效了，有效期一年。在上海定点医院看病，出院就能直接结算，不用先垫钱。',
      speak: '备案好了，能直接结算。',
      successScreen: 'medical.filing.done',
    },
  ],
};

const utilityFlow: TaskFlow = {
  taskId: 'utility.pay',
  title: '生活缴费（水费）',
  category: '生活服务',
  hotkey: '水费 电费 燃气 缴费 交费 欠费 账单',
  facts: ['缴费涉及资金支出，AI 只做金额与收款方核对，不代为支付', '可设置自动扣费，但需本人授权'],
  requiredDocs: ['户号'],
  baselineSteps: 6,
  baselineMs: 240000,
  pitfalls: ['假冒缴费短信里的链接是电诈高发场景', '老人常在「免密支付」环节被误导开通'],
  entryScreen: 'gov.home',
  terminalScreen: 'utility.done',
  trapScreens: [],
  nodes: [
    {
      id: 'u1',
      screenId: 'gov.home',
      targetControlId: 'home.grid.gengduo',
      kind: 'tap',
      intent: '进入更多服务',
      instruction: '点最后一个「更多服务」。',
      speak: '点更多服务。',
      successScreen: 'gov.all',
    },
    {
      /*
       * 这一步以前是缺的：首页点「更多服务」落在全部服务长清单上，
       * 而流程直接跳到了账单页，中间那一跳在界面上不存在——
       * 于是「下一步」按钮在这里会断掉，老人只能自己在一长串里找。
       */
      id: 'u2',
      screenId: 'gov.all',
      targetControlId: 'gov.all.item.utility',
      kind: 'tap',
      intent: '在全部服务里找到「生活缴费」',
      instruction: '找到「生活缴费」，点它。',
      speak: '点生活缴费。',
      successScreen: 'utility.bill',
    },
    {
      id: 'u3',
      screenId: 'utility.bill',
      targetControlId: 'bill.btn.pay',
      kind: 'human-confirm',
      guardrail: 'payment',
      intent: '缴费前核对金额与收款方',
      instruction: '本期水费 128 块 4 毛。钱的事我不替您按，您看清金额和户号，是您家的再点。',
      speak: '水费一百二十八块四，看清楚了您自己点。',
      successScreen: 'utility.pay.confirm',
    },
    {
      id: 'u4',
      screenId: 'utility.pay.confirm',
      targetControlId: 'pay.btn.confirm',
      kind: 'human-confirm',
      guardrail: 'payment',
      intent: '输入支付密码，绝对不可代操作',
      instruction: '要输密码了。密码我不看也不问，您自己按。按完这单就结了。',
      speak: '密码您自己按，我不看。',
      successScreen: 'utility.done',
    },
    {
      id: 'u5',
      screenId: 'utility.done',
      kind: 'read',
      intent: '播报缴费结果',
      instruction: '交完了，128 块 4 毛，订单号尾号 8812。',
      speak: '交完了。',
      successScreen: 'utility.done',
    },
  ],
};

export const TASK_FLOWS: Record<TaskId, TaskFlow> = {
  'allowance.renew': allowanceFlow,
  'pension.qualify': pensionFlow,
  'medical.filing': medicalFlow,
  'utility.pay': utilityFlow,
};

export const TASK_LIST: TaskSpecSummary[] = Object.values(TASK_FLOWS).map((flow): TaskSpecSummary => ({
  taskId: flow.taskId as TaskId,
  title: flow.title,
  category: flow.category,
  hotkey: flow.hotkey,
  requiredDocs: flow.requiredDocs,
  baselineSteps: flow.baselineSteps,
  baselineMs: flow.baselineMs,
  pitfalls: flow.pitfalls,
}));

/** 敏感词：出现这些词时，无论模型说什么都必须走人工 */
export const HIGH_RISK_TERMS = ['转账', '汇款', '点击链接', '银行卡密码', '短信验证码', '安全账户'];
