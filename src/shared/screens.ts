import type { Control, ScreenModel } from './types';

/**
 * 屏幕库（演示环境）
 *
 * 设计要点：这里描述的不是「页面长什么样」，而是「页面上有什么可被读取的东西」。
 * 前端按 block 渲染，Agent 按 block 读屏，两端共享同一模型 —— 因此不存在
 * 「演示时 AI 假装看得见」的问题。
 *
 * 生产环境中该结构由无障碍节点树映射生成（见 docs/adr/0002），字段语义保持一致。
 */

const c = (id: string, label: string, role: Control['role'], hint?: string, risky?: boolean): Control => ({
  id,
  label,
  role,
  ...(hint ? { hint } : {}),
  ...(risky ? { risky } : {}),
});

export const SCREENS: Record<ScreenModel['id'], ScreenModel> = {
  /* ─────────── 政务服务平台 · 首页 ─────────── */
  'gov.home': {
    id: 'gov.home',
    app: '政务服务平台',
    title: '闽政通 · 首页',
    semantics: '省级政务服务应用首页，顶部为搜索框，中部为十二宫格高频服务入口，底部为导航栏。',
    blocks: [
      { type: 'search', id: 'home.search', placeholder: '搜索您要办的事，如：低保、医保' },
      {
        type: 'grid',
        id: 'home.grid',
        columns: 4,
        items: [
          c('home.grid.shebao', '社保服务', 'icon'),
          c('home.grid.yibao', '医保服务', 'icon'),
          c('home.grid.gongjijin', '公积金', 'icon'),
          c('home.grid.minzheng', '民政服务', 'icon'),
          c('home.grid.huji', '户籍办理', 'icon'),
          c('home.grid.jiaoyu', '教育服务', 'icon'),
          c('home.grid.shuiwu', '税务服务', 'icon'),
          c('home.grid.jiaotong', '交通出行', 'icon'),
          c('home.grid.zhufang', '住房保障', 'icon'),
          c('home.grid.canjiren', '残疾人服务', 'icon'),
          c('home.grid.shengyu', '生育服务', 'icon'),
          c('home.grid.gengduo', '更多服务', 'icon'),
        ],
      },
      { type: 'notice', id: 'home.notice', tone: 'info', text: '系统维护公告：10月31日 00:00-02:00 部分服务暂停' },
    ],
    tabs: [c('tab.index', '首页', 'tab'), c('tab.service', '服务', 'tab'), c('tab.mine', '我的', 'tab')],
    traps: ['误点「医保服务」，进入后无低保入口', '误点「更多服务」，进入全部服务长列表，需二次查找'],
  },

  /* ─────────── 民政服务列表 ─────────── */
  /* ─────────── 服务大厅（底部「服务」标签） ─────────── */
  'gov.service': {
    id: 'gov.service',
    app: '政务服务平台',
    title: '服务大厅',
    semantics: '全部政务服务入口，按主题与人生阶段分区，顶部有搜索框，底部为导航栏。',
    blocks: [
      { type: 'search', id: 'service.search', placeholder: '搜索服务名称，如：低保、认证' },
      { type: 'text', id: 'service.mine.title', title: '我的常用', paragraphs: [] },
      {
        type: 'list',
        id: 'service.recent',
        items: [
          c('service.item.dibao-renew', '最低生活保障对象定期复核', 'listItem', '最近使用 · 每半年一次'),
          c('service.item.pension', '养老待遇资格认证', 'listItem', '最近使用 · 刷脸即可'),
          c('service.item.utility', '生活缴费', 'listItem', '最近使用 · 水费/电费/燃气'),
        ],
      },
      { type: 'text', id: 'service.topic.title', title: '按人生阶段找', paragraphs: [] },
      {
        type: 'list',
        id: 'service.topic',
        items: [
          c('service.topic.birth', '出生一件事', 'listItem', '出生医学证明、户口登记、医保参保'),
          c('service.topic.school', '上学一件事', 'listItem', '入学报名、学籍、助学贷款'),
          c('service.topic.work', '工作一件事', 'listItem', '就业登记、社保参保、技能培训'),
          c('service.topic.retire', '退休一件事', 'listItem', '养老待遇申领、医保关系转移'),
          c('service.topic.pass', '身后一件事', 'listItem', '待遇停发、丧葬补助、账户注销'),
        ],
      },
      {
        type: 'grid',
        id: 'service.grid',
        columns: 4,
        items: [
          c('service.grid.shebao', '社保服务', 'icon'),
          c('service.grid.yibao', '医保服务', 'icon'),
          c('service.grid.minzheng', '民政服务', 'icon'),
          c('service.grid.huji', '户籍办理', 'icon'),
          c('service.grid.edu', '教育服务', 'icon'),
          c('service.grid.gongjijin', '公积金', 'icon'),
          c('service.grid.shuiwu', '税务服务', 'icon'),
          c('service.grid.gengduo', '全部服务', 'icon'),
        ],
      },
      { type: 'notice', id: 'service.notice', tone: 'info', text: '本月新增：高龄老人津贴「免申即享」试点，符合条件的老人无需申请，津贴直接发放到社保卡。' },
    ],
    tabs: [c('tab.index', '首页', 'tab'), c('tab.service', '服务', 'tab'), c('tab.mine', '我的', 'tab')],
    traps: ['「上学一件事」里没有低保入口，误点后需返回'],
  },

  /* ─────────── 我的（底部「我的」标签） ─────────── */
  'gov.mine': {
    id: 'gov.mine',
    app: '政务服务平台',
    title: '我的',
    semantics: '个人中心：实名信息、我的办件进度、我的材料、家人代办与设置入口，底部为导航栏。',
    blocks: [
      {
        type: 'profile',
        id: 'mine.profile',
        name: '王秀兰',
        badge: '已实名认证',
        meta: ['身份证 3501********0023', '福州市鼓楼区 · 低保在册对象'],
        stats: [
          { label: '办件', value: '2' },
          { label: '材料', value: '4' },
          { label: '家人代办', value: '1' },
        ],
      },
      { type: 'text', id: 'mine.todo.title', title: '我的办件', paragraphs: [] },
      {
        type: 'list',
        id: 'mine.todo',
        items: [
          c('mine.item.dibao', '最低生活保障对象定期复核', 'listItem', '待提交 · 11月30日截止'),
          c('mine.item.elder', '高龄老人津贴申请', 'listItem', '审核中 · 已提交 3 天'),
        ],
      },
      { type: 'text', id: 'mine.docs.title', title: '我的材料', paragraphs: [] },
      {
        type: 'list',
        id: 'mine.docs',
        items: [
          c('mine.doc.idcard', '居民身份证', 'listItem', '已核验 · 有效期至 2032-06'),
          c('mine.doc.hukou', '户口簿', 'listItem', '已上传'),
          c('mine.doc.dibao', '低保证明', 'listItem', '已上传 · 由民政局开具'),
          c('mine.doc.bank', '本人银行卡', 'listItem', '已绑定 · 尾号 6621'),
        ],
      },
      { type: 'text', id: 'mine.family.title', title: '家人代办', paragraphs: [] },
      {
        type: 'list',
        id: 'mine.family',
        items: [c('mine.family.daughter', '女儿 王丽', 'listItem', '已授权代办 · 可代查办件进度')],
      },
      {
        type: 'actions',
        id: 'mine.actions',
        items: [c('mine.action.font', '字体调大', 'link'), c('mine.action.help', '联系客服', 'link')],
      },
      { type: 'notice', id: 'mine.notice', tone: 'warn', text: '您的低保证明将于 12 月 31 日到期，到期前可在「我的材料」里重新上传。' },
    ],
    tabs: [c('tab.index', '首页', 'tab'), c('tab.service', '服务', 'tab'), c('tab.mine', '我的', 'tab')],
    traps: [],
  },

  /* ─────────── 教育服务列表 ─────────── */
  'gov.edu.list': {
    id: 'gov.edu.list',
    app: '政务服务平台',
    title: '教育服务',
    semantics: '教育服务事项列表，按学段与办事类型排列，含入学报名、学籍、助学贷款等，共 8 项。',
    blocks: [
      { type: 'search', id: 'edu.search', placeholder: '在教育服务中搜索' },
      {
        type: 'list',
        id: 'edu.list',
        items: [
          c('edu.item.enroll', '义务教育入学报名', 'listItem', '每年 5—7 月，按学区报名'),
          c('edu.item.student', '学籍信息查询', 'listItem', '需学生本人实名'),
          c('edu.item.loan', '生源地助学贷款', 'listItem', '学生与共同借款人需到场'),
          c('edu.item.aid', '学生资助申请', 'listItem', '家庭经济困难学生'),
          c('edu.item.teacher', '教师资格认定', 'listItem', '需普通话与考试成绩'),
          c('edu.item.exam', '考试报名与成绩查询', 'listItem', '中考、高考、成人高考'),
          c('edu.item.school', '学校与学区查询', 'listItem', '按地址查对口学校'),
          c('edu.item.fee', '教育收费公示', 'listItem', '各学段收费标准'),
        ],
      },
      { type: 'notice', id: 'edu.notice', tone: 'info', text: '2026 年秋季入学报名将于 5 月 6 日开放，可提前在「我的材料」里准备好户口簿与房产证明。' },
    ],
    traps: [],
  },

  'gov.civil.list': {
    id: 'gov.civil.list',
    app: '政务服务平台',
    title: '民政服务',
    semantics: '民政服务事项列表，共 24 项，「最低生活保障对象定期复核」位于第 18 项，不在首屏。',
    blocks: [
      { type: 'search', id: 'civil.search', placeholder: '在民政服务中搜索' },
      {
        type: 'list',
        id: 'civil.list',
        items: [
          c('civil.item.marriage', '结婚登记预约', 'listItem', '内地居民结婚登记'),
          c('civil.item.divorce', '离婚登记预约', 'listItem'),
          c('civil.item.adopt', '收养登记', 'listItem'),
          c('civil.item.funeral', '殡葬服务查询', 'listItem'),
          c('civil.item.elder', '高龄老人津贴申请', 'listItem', '80 周岁以上'),
          c('civil.item.temp', '临时救助申请', 'listItem', '因突发事件导致基本生活困难'),
          c('civil.item.medical-aid', '医疗救助申请', 'listItem'),
          c('civil.item.disaster', '灾后救助申请', 'listItem'),
          c('civil.item.street', '流浪乞讨人员救助', 'listItem'),
          c('civil.item.orphan', '孤儿基本生活保障', 'listItem'),
          c('civil.item.disabled', '困难残疾人生活补贴', 'listItem'),
          c('civil.item.nursing', '重度残疾人护理补贴', 'listItem'),
          c('civil.item.charity', '慈善组织查询', 'listItem'),
          c('civil.item.social-org', '社会组织查询', 'listItem'),
          c('civil.item.donation', '捐赠信息查询', 'listItem'),
          c('civil.item.volunteer', '志愿服务记录', 'listItem'),
          c('civil.item.community', '社区服务设施查询', 'listItem'),
          c('civil.item.dibao-renew', '最低生活保障对象定期复核', 'listItem', '低保对象每半年一次的资格复核'),
          c('civil.item.dibao-apply', '最低生活保障申请', 'listItem', '新申请低保'),
          c('civil.item.dibao-query', '低保金发放查询', 'listItem'),
          c('civil.item.wubao', '特困人员救助供养', 'listItem'),
          c('civil.item.burial', '惠民殡葬补贴', 'listItem'),
          c('civil.item.guardian', '监护权确认', 'listItem'),
          c('civil.item.consult', '民政政策咨询', 'listItem'),
        ],
      },
    ],
    traps: ['误点「临时救助申请」（同样带「救助」字样），进入后才发现不是复核'],
  },

  /* ─────────── 低保复核 · 办理须知 ─────────── */
  'civil.allowance.intro': {
    id: 'civil.allowance.intro',
    app: '政务服务平台',
    title: '最低生活保障对象定期复核',
    semantics: '办理须知页，长文本说明受理条件、所需材料、办理时限，页面底部有「开始办理」与「查看进度」两个按钮。',
    blocks: [
      {
        type: 'text',
        id: 'intro.text',
        title: '受理条件',
        paragraphs: [
          '正在享受最低生活保障待遇的对象，应当每半年参加一次资格复核。',
          '复核内容包括家庭人口变动、家庭收入变动、家庭财产变动情况。',
          '逾期未参加复核的，将暂停发放最低生活保障金。',
        ],
      },
      {
        type: 'text',
        id: 'intro.docs',
        title: '所需材料',
        paragraphs: ['1. 本人居民身份证（原件拍照）', '2. 居民户口簿', '3. 近三个月收入证明或银行流水', '4. 本人社会保障卡或银行账户'],
      },
      { type: 'notice', id: 'intro.notice', tone: 'warn', text: '本次复核截止日期：2026年11月30日，逾期将暂停发放。' },
      {
        type: 'actions',
        id: 'intro.actions',
        items: [c('intro.btn.apply', '开始办理', 'button'), c('intro.btn.progress', '查看办理进度', 'link')],
      },
    ],
  },

  /* ─────────── 低保复核 · 表单 ─────────── */
  'civil.allowance.form': {
    id: 'civil.allowance.form',
    app: '政务服务平台',
    title: '填写复核信息',
    semantics: '复核信息填报表单，共 6 个字段，其中 5 个必填。填写完毕后点击底部「提交复核申请」。',
    blocks: [
      {
        type: 'form',
        id: 'form.allowance',
        fields: [
          { id: 'form.name', label: '申请人姓名', placeholder: '请输入身份证上的姓名', required: true, kind: 'text', slot: 'name' },
          { id: 'form.idcard', label: '身份证号', placeholder: '18 位身份证号码', required: true, kind: 'idcard', slot: 'idCard' },
          { id: 'form.phone', label: '联系电话', placeholder: '用于接收办理结果通知', required: true, kind: 'phone', slot: 'phone' },
          { id: 'form.household', label: '家庭共同生活人口数', placeholder: '含申请人本人', required: true, kind: 'number', slot: 'householdSize' },
          { id: 'form.income', label: '家庭上月总收入（元）', placeholder: '各项收入合计', required: true, kind: 'number', slot: 'monthlyIncome' },
          { id: 'form.address', label: '现居住地址', placeholder: '选填，与户籍不一致时填写', required: false, kind: 'text' },
        ],
      },
      { type: 'notice', id: 'form.notice', tone: 'warn', text: '请如实填报，虚报瞒报将承担相应法律责任。' },
      { type: 'actions', id: 'form.actions', items: [c('form.btn.submit', '提交复核申请', 'button', '提交后进入实名核验')] },
    ],
    traps: ['必填项未填完直接提交，返回红色错误提示'],
  },

  /* ─────────── 低保复核 · 人脸核验 ─────────── */
  'civil.allowance.face': {
    id: 'civil.allowance.face',
    app: '政务服务平台',
    title: '实名核验',
    semantics: '人脸识别页，提示用户将脸部置于取景框内，底部有「开始核验」按钮。',
    blocks: [
      { type: 'text', id: 'face.tip', title: '请完成人脸核验', paragraphs: ['为保证是本人办理，需要进行人脸识别。', '请摘下口罩和帽子，正对手机，光线充足。'] },
      { type: 'actions', id: 'face.actions', items: [c('face.btn.start', '开始核验', 'button', '调起摄像头', true), c('face.btn.help', '遇到问题？', 'link')] },
    ],
    traps: ['连续多次核验失败后，页面提示「核验失败，请稍后重试」'],
  },

  /* ─────────── 低保复核 · 风控确认 ─────────── */
  'civil.allowance.risk': {
    id: 'civil.allowance.risk',
    app: '政务服务平台',
    title: '安全确认',
    semantics: '风控弹窗覆盖在核验页之上，要求用户确认「是本人操作」，两个按钮：确认是本人 / 不是我。',
    blocks: [
      {
        type: 'dialog',
        id: 'risk.dialog',
        title: '安全提示',
        text: '为保障您的账户与资金安全，请确认本次操作由本人完成。如非本人操作，请立即取消并联系 12345。',
        items: [c('risk.btn.confirm', '确认是本人操作', 'button', undefined, true), c('risk.btn.cancel', '不是我，取消', 'button')],
      },
    ],
  },

  /* ─────────── 低保复核 · 完成 ─────────── */
  'civil.allowance.done': {
    id: 'civil.allowance.done',
    app: '政务服务平台',
    title: '提交成功',
    semantics: '受理成功页，展示受理编号、预计办结时间与后续提示。',
    blocks: [
      {
        type: 'result',
        id: 'done.result',
        title: '复核申请已受理',
        lines: ['受理编号：FZ2026102900371', '预计办结时间：2026年11月12日前', '结果将通过短信通知，也可在「我的办件」中查询'],
      },
      { type: 'notice', id: 'done.notice', tone: 'info', text: '复核期间低保金正常发放，无需重复申请。' },
      { type: 'actions', id: 'done.actions', items: [c('done.btn.home', '返回首页', 'button'), c('done.btn.share', '把结果告诉家人', 'link')] },
    ],
  },

  /* ─────────── 陷阱页：医保服务 ─────────── */
  'wrong.insurance': {
    id: 'wrong.insurance',
    app: '医保服务平台',
    title: '医保服务',
    semantics: '这是医保服务专区的首页，只有参保登记、异地就医、费用报销等医保事项，没有低保复核入口。',
    blocks: [
      {
        type: 'list',
        id: 'insurance.list',
        items: [
          c('insurance.item.register', '参保登记', 'listItem'),
          c('insurance.item.remote', '异地就医备案', 'listItem'),
          c('insurance.item.claim', '医疗费用报销', 'listItem'),
          c('insurance.item.balance', '个人账户余额查询', 'listItem'),
          c('insurance.item.chronic', '门诊慢特病认定', 'listItem'),
        ],
      },
      { type: 'notice', id: 'insurance.notice', tone: 'info', text: '低保、特困等救助事项请前往「民政服务」办理。' },
    ],
  },

  /* ─────────── 陷阱页：临时救助 ─────────── */
  'wrong.temp': {
    id: 'wrong.temp',
    app: '政务服务平台',
    title: '临时救助申请',
    semantics: '这是「临时救助申请」的说明页，面向因突发事件导致基本生活困难的新申请对象，与低保定期复核是两件不同的事。',
    blocks: [
      {
        type: 'text',
        id: 'temp.text',
        title: '临时救助申请',
        paragraphs: ['临时救助面向因火灾、交通事故、突发重病等原因导致基本生活陷入困境的家庭。', '已享受最低生活保障的对象，无需重复申请临时救助。'],
      },
      { type: 'actions', id: 'temp.actions', items: [c('temp.btn.apply', '开始申请', 'button'), c('temp.btn.back', '返回列表', 'link')] },
    ],
  },

  /* ─────────── 资格认证 ─────────── */
  'pension.qualify.intro': {
    id: 'pension.qualify.intro',
    app: '政务服务平台',
    title: '养老保险待遇领取资格认证',
    semantics: '资格认证说明页，每年需认证一次，底部有「开始认证」按钮。',
    blocks: [
      {
        type: 'text',
        id: 'pension.intro.text',
        title: '认证说明',
        paragraphs: ['领取企业职工基本养老保险待遇的人员，每年需完成一次资格认证。', '认证周期为 12 个月，逾期未认证将暂停发放养老金。'],
      },
      { type: 'actions', id: 'pension.intro.actions', items: [c('pension.intro.btn.start', '开始认证', 'button')] },
    ],
  },
  'pension.qualify.face': {
    id: 'pension.qualify.face',
    app: '政务服务平台',
    title: '人脸认证',
    semantics: '人脸认证页，需要通过活体检测。',
    blocks: [
      { type: 'text', id: 'pension.face.tip', title: '活体检测', paragraphs: ['请正视屏幕，按提示完成眨眼、张嘴动作。'] },
      { type: 'actions', id: 'pension.face.actions', items: [c('pension.face.btn.start', '开始认证', 'button', undefined, true)] },
    ],
  },
  'pension.qualify.done': {
    id: 'pension.qualify.done',
    app: '政务服务平台',
    title: '认证成功',
    semantics: '认证成功页，展示下次认证时间。',
    blocks: [
      { type: 'result', id: 'pension.done.result', title: '资格认证已完成', lines: ['认证时间：2026年10月29日', '下次认证截止：2027年10月29日'] },
    ],
  },

  /* ─────────── 异地就医备案 ─────────── */
  'medical.filing.form': {
    id: 'medical.filing.form',
    app: '医保服务平台',
    title: '异地就医备案',
    semantics: '异地就医备案表单，需填写就医地、联系电话，并上传转诊证明或居住证明。',
    blocks: [
      {
        type: 'form',
        id: 'medical.form',
        fields: [
          { id: 'medical.city', label: '就医地', placeholder: '请选择省份城市', required: true, kind: 'select', slot: 'visitCity', options: ['上海市', '北京市', '广州市', '杭州市', '成都市'] },
          { id: 'medical.hospital', label: '就诊医院', placeholder: '选填，可稍后修改', required: false, kind: 'text', slot: 'hospital' },
          { id: 'medical.phone', label: '联系电话', placeholder: '接收备案结果', required: true, kind: 'phone', slot: 'phone' },
          { id: 'medical.proof', label: '居住或转诊证明', placeholder: '拍照上传', required: true, kind: 'upload' },
        ],
      },
      { type: 'actions', id: 'medical.form.actions', items: [c('medical.btn.submit', '提交备案', 'button')] },
    ],
  },
  'medical.filing.done': {
    id: 'medical.filing.done',
    app: '医保服务平台',
    title: '备案成功',
    semantics: '备案成功页，展示备案有效期。',
    blocks: [{ type: 'result', id: 'medical.done.result', title: '异地就医备案已生效', lines: ['备案有效期：2026年10月29日至2027年10月28日', '在上海定点医院可直接结算'] }],
  },

  /* ─────────── 生活缴费（支付护栏演示） ─────────── */
  'utility.bill': {
    id: 'utility.bill',
    app: '生活缴费',
    title: '水费账单',
    semantics: '水费账单详情页，展示应缴金额、用水量、账期，底部按钮为「立即缴费」。',
    blocks: [
      { type: 'text', id: 'bill.text', title: '本期账单', paragraphs: ['户号：3501****8823', '账期：2026年9月', '用水量：14 吨', '应缴金额：128.40 元', '缴费截止：2026年11月10日'] },
      { type: 'actions', id: 'bill.actions', items: [c('bill.btn.pay', '立即缴费 128.40 元', 'button', '将跳转支付', true)] },
    ],
  },
  'utility.pay.confirm': {
    id: 'utility.pay.confirm',
    app: '生活缴费',
    title: '确认支付',
    semantics: '支付确认页，展示收款方与金额，需要输入支付密码。',
    blocks: [
      { type: 'text', id: 'pay.text', title: '支付信息', paragraphs: ['收款方：福州市自来水有限公司', '金额：128.40 元', '付款方式：社会保障卡金融账户'] },
      { type: 'notice', id: 'pay.notice', tone: 'danger', text: '请输入 6 位支付密码完成付款。' },
      { type: 'actions', id: 'pay.actions', items: [c('pay.btn.confirm', '确认支付', 'button', undefined, true), c('pay.btn.cancel', '取消', 'button')] },
    ],
  },
  'utility.done': {
    id: 'utility.done',
    app: '生活缴费',
    title: '缴费成功',
    semantics: '缴费成功页。',
    blocks: [{ type: 'result', id: 'utility.done.result', title: '缴费成功', lines: ['金额：128.40 元', '订单号：SF20261029008812'] }],
  },
};

/** 屏幕可达性：用于校验「Agent 指向的控件是否真实存在」 */
export const SCREEN_CONTROL_INDEX: Record<string, Set<string>> = Object.fromEntries(
  Object.values(SCREENS).map((screen) => {
    const ids = new Set<string>();
    for (const block of screen.blocks) {
      if (block.type === 'grid' || block.type === 'list' || block.type === 'actions') {
        block.items.forEach((item) => ids.add(item.id));
      } else if (block.type === 'dialog') {
        block.items.forEach((item) => ids.add(item.id));
      } else if (block.type === 'form') {
        block.fields.forEach((field) => ids.add(field.id));
      } else if (block.type === 'search') {
        ids.add(block.id);
      }
    }
    (screen.tabs ?? []).forEach((tab) => ids.add(tab.id));
    return [screen.id, ids];
  }),
);

export function getScreen(id: string): ScreenModel | undefined {
  return (SCREENS as Record<string, ScreenModel>)[id];
}

export function controlExists(screenId: string, controlId: string): boolean {
  return SCREEN_CONTROL_INDEX[screenId]?.has(controlId) ?? false;
}
