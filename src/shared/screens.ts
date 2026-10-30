import type { Control, ScreenBlock, ScreenId, ScreenModel } from './types';

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

/**
 * 底部导航三件套。
 *
 * 这一组在所有页面复用同一个 id，是因为它们是「同一台手机的同一条导航栏」——
 * 用户不管在哪一层，抬头都能看见、都能点，不会出现「进了详情页就出不来」。
 */
export const APP_TABS: Control[] = [c('tab.index', '首页', 'tab'), c('tab.service', '服务', 'tab'), c('tab.mine', '我的', 'tab')];

const TABS = (): Control[] => APP_TABS;

const CORE_SCREENS = {
  /* ─────────── 政务服务平台 · 首页 ─────────── */
  'gov.home': {
    id: 'gov.home',
    app: '政务服务平台',
    /*
     * 这里不写任何真实产品名。
     *
     * 本产品是**外挂**在政务 App 旁边的向导，不是那个 App 本身。
     * 把别人的商标写进自己的界面标题，属于商标性使用（不是「用于对比说明」的
     * 合理使用），既有无谓的法律风险，也会让评委误以为我们在复刻官方应用。
     * 界面上统一叫「政务服务」，并在手机下方标注「演示模拟」。
     */
    title: '政务服务 · 首页',
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
    tabs: TABS(),
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
      { type: 'notice', id: 'service.notice', tone: 'info', text: '本月新增：高龄老人津贴「免申即享」试点，符合条件的老人无需申请，津贴直接发放到社保卡。' },
    ],
    tabs: TABS(),
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
        type: 'list',
        id: 'mine.actions',
        items: [c('mine.action.font', '字体调大', 'listItem', '点一下，字就变大'), c('mine.action.help', '联系客服', 'listItem', '12345 热线 · 社区帮办员')],
      },
      { type: 'notice', id: 'mine.notice', tone: 'warn', text: '您的低保证明 11 月 20 日到期，只剩 21 天。低保复核审核要 45 天，建议先续期再提交，免得办到一半失效。' },
    ],
    tabs: TABS(),
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
    tabs: TABS(),
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
    tabs: TABS(),
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
    semantics: '缴费成功页，展示缴费金额与订单号，并提供返回首页的入口。',
    blocks: [{ type: 'result', id: 'utility.done.result', title: '缴费成功', lines: ['金额：128.40 元', '订单号：SF20261029008812'] }],
  },
} satisfies Record<string, ScreenModel>;

/* ────────────────────────── 服务大厅的第二层：主题专区 ────────────────────────── */

/**
 * 主题专区的数据描述。
 *
 * 服务大厅的宫格、人生阶段、全部服务，点进去都是「同类事项的清单页」，
 * 结构完全一样，只有标题和条目不同。与其手写十几份样板，不如描述数据、统一生成——
 * 屏幕模型的形状一旦统一，Agent 读屏也就稳定。
 */
interface TopicSpec {
  id: ScreenId;
  title: string;
  semantics: string;
  /** 分区标题，告诉用户这页是按什么分的 */
  lead: string;
  items: Array<{ key: string; label: string; hint?: string }>;
  notice?: { tone: 'info' | 'warn' | 'danger'; text: string };
}

const TOPIC_SPECS = [
  {
    id: 'gov.all',
    title: '全部服务',
    semantics: '全部服务总入口，按主题分组的完整清单，含社会救助、社会保险、医保、户籍、教育、公积金、税务，并可直接进入四条已接入流程。',
    lead: '按主题找',
    items: [
      { key: 'utility', label: '生活缴费', hint: '水费、电费、燃气 · 可在线缴纳' },
      { key: 'minzheng', label: '民政与救助', hint: '低保、特困、临时救助、高龄津贴' },
      { key: 'shebao', label: '社会保险', hint: '养老、工伤、失业、社保卡' },
      { key: 'yibao', label: '医疗保险', hint: '参保、异地就医、报销' },
      { key: 'huji', label: '户籍与身份证', hint: '户口簿、迁入迁出、居住证' },
      { key: 'edu', label: '教育服务', hint: '入学、学籍、助学贷款' },
      { key: 'gongjijin', label: '公积金', hint: '提取、贷款、缴存明细' },
      { key: 'shuwu', label: '税务服务', hint: '个税、发票、完税证明' },
    ],
    notice: { tone: 'info', text: '清单里找不到，直接说一句要办的事，我帮您找入口。' },
  },
  {
    id: 'topic.shebao',
    title: '社会保险',
    semantics: '社会保险专区，含养老待遇资格认证、社保卡挂失、缴费记录查询、关系转移等事项。',
    lead: '社保高频事项',
    items: [
      { key: 'pension', label: '养老待遇领取资格认证', hint: '每年一次 · 刷脸即可' },
      { key: 'card', label: '社会保障卡挂失', hint: '丢失后先挂失再补办' },
      { key: 'record', label: '社保缴费记录查询', hint: '近五年缴费明细' },
      { key: 'transfer', label: '养老保险关系转移', hint: '跨省就业时办理' },
      { key: 'injury', label: '工伤保险待遇申领', hint: '需先做工伤认定' },
    ],
    notice: { tone: 'warn', text: '资格认证逾期会暂停发放养老金，建议每年固定一个月办理。' },
  },
  {
    id: 'topic.huji',
    title: '户籍与身份证',
    semantics: '户籍与身份证专区，含户口簿补办、户籍证明、迁出迁入、身份证换领、居住证办理。',
    lead: '户籍高频事项',
    items: [
      { key: 'book', label: '居民户口簿补办', hint: '遗失或损坏后办理' },
      { key: 'cert', label: '户籍证明开具', hint: '就学、公证等场景使用' },
      { key: 'move', label: '户口迁出迁入', hint: '需迁入地准迁证' },
      { key: 'idcard', label: '居民身份证换领', hint: '到期前六个月可办' },
      { key: 'resident', label: '居住证办理', hint: '连续居住满半年' },
    ],
  },
  {
    id: 'topic.gongjijin',
    title: '公积金',
    semantics: '住房公积金专区，含提取、贷款、缴存明细查询与异地转移接续。',
    lead: '公积金高频事项',
    items: [
      { key: 'withdraw', label: '住房公积金提取', hint: '租房、购房、退休均可提取' },
      { key: 'loan', label: '公积金贷款申请', hint: '需连续缴存满六个月' },
      { key: 'query', label: '缴存明细查询', hint: '按月查看单位与个人缴存额' },
      { key: 'transfer', label: '异地转移接续', hint: '换城市工作时办理' },
    ],
  },
  {
    id: 'topic.shuwu',
    title: '税务服务',
    semantics: '税务服务专区，含个人所得税查询、发票查验、完税证明开具。',
    lead: '办税高频事项',
    items: [
      { key: 'tax', label: '个人所得税记录查询', hint: '收入与已缴税额' },
      { key: 'invoice', label: '发票查验', hint: '输入发票代码与号码' },
      { key: 'proof', label: '完税证明开具', hint: '贷款、公证常用' },
      { key: 'declare', label: '专项附加扣除填报', hint: '赡养老人、大病医疗' },
    ],
  },
  {
    id: 'topic.birth',
    title: '出生一件事',
    semantics: '出生一件事联办页，一次填报可联办出生医学证明、新生儿户口登记、城乡居民医保参保、生育津贴申领、预防接种证。',
    lead: '一次填报，五件事一起办',
    items: [
      { key: 'cert', label: '出生医学证明', hint: '出生后一个月内申领' },
      { key: 'hukou', label: '新生儿户口登记', hint: '随父或随母登记' },
      { key: 'insurance', label: '城乡居民医保参保', hint: '出生当年免费参保' },
      { key: 'allowance', label: '生育津贴申领', hint: '需参保满规定月数' },
      { key: 'vaccine', label: '预防接种证办理', hint: '与户口登记联办' },
    ],
    notice: { tone: 'info', text: '联办需要父母双方身份证、结婚证与出生医学证明，缺一项会退回补正。' },
  },
  {
    id: 'topic.school',
    title: '上学一件事',
    semantics: '上学一件事联办页，含义务教育入学报名、学籍查询、生源地助学贷款、学生资助申请、学区查询。',
    lead: '入学与资助',
    items: [
      { key: 'enroll', label: '义务教育入学报名', hint: '每年 5—7 月，按学区报名' },
      { key: 'student', label: '学籍信息查询', hint: '需学生本人实名' },
      { key: 'loan', label: '生源地助学贷款', hint: '学生与共同借款人需到场' },
      { key: 'aid', label: '学生资助申请', hint: '家庭经济困难学生' },
      { key: 'school', label: '学校与学区查询', hint: '按地址查对口学校' },
    ],
  },
  {
    id: 'topic.work',
    title: '工作一件事',
    semantics: '工作一件事联办页，含就业登记、职工社保参保、技能培训报名、失业保险金申领。',
    lead: '就业与参保',
    items: [
      { key: 'register', label: '就业登记', hint: '入职或灵活就业时登记' },
      { key: 'insurance', label: '职工社会保险参保', hint: '由单位申报或个人参保' },
      { key: 'training', label: '职业技能培训报名', hint: '政府补贴项目免费' },
      { key: 'unemployment', label: '失业保险金申领', hint: '需缴满一年且非本人意愿失业' },
    ],
  },
  {
    id: 'topic.retire',
    title: '退休一件事',
    semantics: '退休一件事联办页，含养老待遇申领、待遇领取资格认证、医保关系转移、退休证办理。',
    lead: '退休前后要办的事',
    items: [
      { key: 'pension', label: '养老待遇申领', hint: '达到法定退休年龄时办理' },
      { key: 'qualify', label: '待遇领取资格认证', hint: '退休后每年一次' },
      { key: 'medical', label: '医保关系转移', hint: '异地安置时办理' },
      { key: 'cert', label: '退休证办理', hint: '部分场景需要纸质证明' },
    ],
    notice: { tone: 'warn', text: '资格认证逾期会暂停发放养老金，认证后恢复并补发。' },
  },
  {
    id: 'topic.pass',
    title: '身后一件事',
    semantics: '身后一件事联办页，含待遇停发申报、丧葬补助申领、账户注销、遗产查询，建议家属陪同办理。',
    lead: '家属可代为办理',
    items: [
      { key: 'stop', label: '待遇停发申报', hint: '避免多领需退回' },
      { key: 'funeral', label: '丧葬补助申领', hint: '需死亡证明与火化证明' },
      { key: 'account', label: '社保与银行账户注销', hint: '先结清再注销' },
      { key: 'heritage', label: '遗产与存款查询', hint: '需继承关系证明' },
    ],
    notice: { tone: 'info', text: '这一组事项对家属情绪影响大，建议由家人陪同、一次只办一件。' },
  },
] satisfies TopicSpec[];

function buildTopicScreen(spec: TopicSpec): ScreenModel {
  const blocks: ScreenBlock[] = [
    { type: 'search', id: `${spec.id}.search`, placeholder: `在${spec.title}里搜索` },
    { type: 'text', id: `${spec.id}.lead`, title: spec.lead, paragraphs: [] },
    {
      type: 'list',
      id: `${spec.id}.list`,
      items: spec.items.map((item) => c(`${spec.id}.item.${item.key}`, item.label, 'listItem', item.hint)),
    },
  ];
  if (spec.notice) blocks.push({ type: 'notice', id: `${spec.id}.notice`, tone: spec.notice.tone, text: spec.notice.text });
  return { id: spec.id, app: '政务服务平台', title: spec.title, semantics: spec.semantics, blocks, tabs: TABS() };
}

function topicScreen(id: ScreenId): ScreenModel {
  const spec = TOPIC_SPECS.find((item) => item.id === id);
  if (!spec) throw new Error(`主题页缺少数据：${id}`);
  return buildTopicScreen(spec);
}

/* ────────────────────────── 我的：办件、材料、家人代办 ────────────────────────── */

interface DocSpec {
  id: ScreenId;
  title: string;
  name: string;
  status: string;
  lines: string[];
  notice?: { tone: 'info' | 'warn'; text: string };
}

function buildDocScreen(spec: DocSpec): ScreenModel {
  const blocks: ScreenBlock[] = [
    { type: 'text', id: `${spec.id}.info`, title: spec.name, paragraphs: [`状态：${spec.status}`, ...spec.lines] },
  ];
  if (spec.notice) blocks.push({ type: 'notice', id: `${spec.id}.notice`, tone: spec.notice.tone, text: spec.notice.text });
  blocks.push({
    type: 'actions',
    id: `${spec.id}.actions`,
    items: [c(`${spec.id}.btn.view`, '看原件', 'button'), c(`${spec.id}.btn.reupload`, '重新上传', 'button')],
  });
  return {
    id: spec.id,
    app: '政务服务平台',
    title: spec.title,
    semantics: `材料详情页：${spec.name}，当前${spec.status}，可查看原件或重新上传，底部有导航栏。`,
    blocks,
    tabs: TABS(),
  };
}

const DOC_SPECS = [
  {
    id: 'mine.doc.idcard',
    title: '居民身份证',
    name: '居民身份证',
    status: '已核验',
    lines: ['有效期至 2032-06', '公安库核验通过，无需重复上传'],
  },
  {
    id: 'mine.doc.hukou',
    title: '居民户口簿',
    name: '居民户口簿',
    status: '已上传',
    lines: ['上传时间：2026-03-12', '登记家庭人口：1 人', '户号：350102****0113'],
  },
  {
    id: 'mine.doc.dibao',
    title: '低保证明',
    name: '最低生活保障证明',
    status: '已上传',
    lines: ['开具单位：福州市鼓楼区民政局', '开具时间：2026-03-12', '有效期至 2026-11-20'],
    notice: { tone: 'warn' as const, text: '这份证明 11 月 20 日到期。低保复核审核约 45 天，现在提交会办到一半失效，建议先续期。' },
  },
  {
    id: 'mine.doc.bank',
    title: '本人银行卡',
    name: '社会保障卡金融账户',
    status: '已绑定',
    lines: ['开户行：中国农业银行福州鼓楼支行', '卡号尾号：6621', '低保金与津贴发放到此账户'],
  },
] satisfies DocSpec[];

function docScreen(id: ScreenId): ScreenModel {
  const spec = DOC_SPECS.find((item) => item.id === id);
  if (!spec) throw new Error(`材料页缺少数据：${id}`);
  return buildDocScreen(spec);
}

const MY_SCREENS = {
  'mine.elder': {
    id: 'mine.elder',
    app: '政务服务平台',
    title: '高龄老人津贴申请',
    semantics: '办件进度页：高龄老人津贴申请审核中，展示办件编号、申请时间、预计办结与津贴标准，底部有联系客服与返回我的。',
    blocks: [
      {
        type: 'text',
        id: 'elder.text',
        title: '审核中',
        paragraphs: ['办件编号：FZ2026102700158', '申请时间：2026年10月27日', '预计办结：2026年11月8日前', '津贴标准：80—89 周岁每人每月 100 元'],
      },
      { type: 'notice', id: 'elder.notice', tone: 'info', text: '审核期间不用再跑窗口。结果会发短信，也可以在这里查。' },
      {
        type: 'actions',
        id: 'elder.actions',
        items: [c('elder.btn.hotline', '进度有疑问，问客服', 'button'), c('elder.btn.back', '返回我的', 'link')],
      },
    ],
    tabs: TABS(),
  },

  'mine.family': {
    id: 'mine.family',
    app: '政务服务平台',
    title: '家人代办',
    semantics: '家人代办授权页：已授权女儿王丽代办，列出授权范围（可代查办件、代填表单，不含刷脸与支付），底部有新增代办人与解除授权。',
    blocks: [
      {
        type: 'text',
        id: 'family.owner',
        title: '女儿 王丽',
        paragraphs: ['已实名 · 手机号 138****6021', '授权时间：2026年3月12日', '最近代办：2026年10月28日 帮您查低保复核进度'],
      },
      {
        type: 'text',
        id: 'family.scope',
        title: '她能替您做什么',
        paragraphs: ['可以：查办件进度、接收结果通知、帮您填表与上传材料', '不可以：代替您刷脸、代替您输支付密码'],
      },
      { type: 'notice', id: 'family.notice', tone: 'info', text: '授权随时可以取消。取消后她看不到您的办件信息。' },
      {
        type: 'actions',
        id: 'family.actions',
        items: [c('family.action.add', '新增代办人', 'button'), c('family.action.revoke', '解除授权', 'button', undefined, true)],
      },
    ],
    tabs: TABS(),
  },

  'gov.todo': {
    id: 'gov.todo',
    app: '政务服务平台',
    title: '这一项还没接入',
    semantics: '演示范围说明页：当前入口对应的事项尚未接入本次演示，页面提供人工求助与返回，用户不会卡在死路上。',
    blocks: [
      {
        type: 'text',
        id: 'todo.text',
        title: '这件事暂时没有接入演示',
        paragraphs: [
          '演示版完整接入了四条流程：低保复核、养老待遇资格认证、异地就医备案、生活缴费。',
          '其他入口在真实产品里由对方 App 自己完成，我只负责读屏和指路，不会替您乱点。',
          '您现在有三个选择：返回上一页继续找、打 12345 让人带着办、或者把要办的事说给我听。',
        ],
      },
      { type: 'notice', id: 'todo.notice', tone: 'info', text: '您可以返回上一页继续找，或者把要办的事说给我听，我帮您判断该去哪个入口。' },
      {
        type: 'actions',
        id: 'todo.actions',
        items: [c('todo.btn.hotline', '打 12345 问', 'button'), c('todo.btn.back', '回到上一页', 'button')],
      },
    ],
    tabs: TABS(),
  },
} satisfies Record<string, ScreenModel>;

const RAW_SCREENS: Record<ScreenModel['id'], ScreenModel> = {
  ...CORE_SCREENS,
  ...MY_SCREENS,
  'gov.all': topicScreen('gov.all'),
  'topic.shebao': topicScreen('topic.shebao'),
  'topic.huji': topicScreen('topic.huji'),
  'topic.gongjijin': topicScreen('topic.gongjijin'),
  'topic.shuwu': topicScreen('topic.shuwu'),
  'topic.birth': topicScreen('topic.birth'),
  'topic.school': topicScreen('topic.school'),
  'topic.work': topicScreen('topic.work'),
  'topic.retire': topicScreen('topic.retire'),
  'topic.pass': topicScreen('topic.pass'),
  'mine.doc.idcard': docScreen('mine.doc.idcard'),
  'mine.doc.hukou': docScreen('mine.doc.hukou'),
  'mine.doc.dibao': docScreen('mine.doc.dibao'),
  'mine.doc.bank': docScreen('mine.doc.bank'),
};

/**
 * 底部导航是「这台手机的固定部件」，不是某一页的内容。
 *
 * 所以统一在这里补：任何一页——包括表单、风控弹窗、结果页——抬头都能看见
 * 首页/服务/我的。老人不需要记住返回箭头在哪，也不会「进了死胡同出不来」。
 */
export const SCREENS: Record<ScreenModel['id'], ScreenModel> = Object.fromEntries(
  Object.entries(RAW_SCREENS).map(([id, screen]) => [id, screen.tabs?.length ? screen : { ...screen, tabs: APP_TABS }]),
) as Record<ScreenModel['id'], ScreenModel>;

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
