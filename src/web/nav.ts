import type { ScreenId } from '@shared/types';

/**
 * 模拟应用内的跳转关系。
 *
 * 这层只是「演示用的假 App 路由」——真实产品里，跳转由对方 App 自己完成，
 * 我们只负责读屏与指路（见 docs/adr/0002）。
 *
 * 设计上刻意做成「不留死路」：服务大厅的每个宫格都能点进对应主题专区，
 * 专区里的每个条目要么通向已接入的真实流程，要么通向一页说明与人工求助。
 * 老人点下去总有反馈，不会出现「点了没反应，以为手机坏了」。
 */
export const NAV: Record<string, ScreenId> = {
  // 底部导航（所有页面共用同一组标签 id，任何一层都能互达）
  'tab.index': 'gov.home',
  'tab.service': 'gov.service',
  'tab.mine': 'gov.mine',

  // 政务首页 · 十二宫格
  'home.grid.minzheng': 'gov.civil.list',
  'home.grid.jiaoyu': 'gov.edu.list',
  'home.grid.yibao': 'wrong.insurance',
  'home.grid.shebao': 'topic.shebao',
  'home.grid.gongjijin': 'topic.gongjijin',
  'home.grid.huji': 'topic.huji',
  'home.grid.shuiwu': 'topic.shuwu',
  'home.grid.gengduo': 'gov.all',

  // 全部服务 · 生活缴费（水费流程从首页「更多服务」进来后要落在这里）
  'gov.all.item.utility': 'utility.bill',

  // 服务大厅 · 我的常用
  'service.item.dibao-renew': 'civil.allowance.intro',
  'service.item.pension': 'pension.qualify.intro',
  'service.item.utility': 'utility.bill',

  // 服务大厅 · 按人生阶段找
  'service.topic.birth': 'topic.birth',
  'service.topic.school': 'topic.school',
  'service.topic.work': 'topic.work',
  'service.topic.retire': 'topic.retire',
  'service.topic.pass': 'topic.pass',

  // 服务大厅 · 主题宫格
  'service.grid.shebao': 'topic.shebao',
  'service.grid.yibao': 'wrong.insurance',
  'service.grid.minzheng': 'gov.civil.list',
  'service.grid.huji': 'topic.huji',
  'service.grid.edu': 'gov.edu.list',
  'service.grid.gongjijin': 'topic.gongjijin',
  'service.grid.shuiwu': 'topic.shuwu',
  'service.grid.gengduo': 'gov.all',

  // 全部服务 · 主题分组
  'gov.all.item.minzheng': 'gov.civil.list',
  'gov.all.item.shebao': 'topic.shebao',
  'gov.all.item.yibao': 'wrong.insurance',
  'gov.all.item.huji': 'topic.huji',
  'gov.all.item.edu': 'gov.edu.list',
  'gov.all.item.gongjijin': 'topic.gongjijin',
  'gov.all.item.shuwu': 'topic.shuwu',

  // 主题专区里能直接接上已接入流程的条目
  'topic.shebao.item.pension': 'pension.qualify.intro',
  'topic.retire.item.qualify': 'pension.qualify.intro',
  'topic.work.item.insurance': 'topic.shebao',
  'topic.school.item.enroll': 'gov.edu.list',
  'topic.school.item.student': 'gov.edu.list',
  'topic.school.item.loan': 'gov.edu.list',
  'topic.school.item.aid': 'gov.edu.list',
  'topic.school.item.school': 'gov.edu.list',

  // 我的 · 办件
  'mine.item.dibao': 'civil.allowance.intro',
  'mine.item.elder': 'mine.elder',

  // 我的 · 材料
  'mine.doc.idcard': 'mine.doc.idcard',
  'mine.doc.hukou': 'mine.doc.hukou',
  'mine.doc.dibao': 'mine.doc.dibao',
  'mine.doc.bank': 'mine.doc.bank',

  // 我的 · 家人代办
  'mine.family.daughter': 'mine.family',

  // 民政服务列表
  'civil.item.dibao-renew': 'civil.allowance.intro',
  'civil.item.temp': 'wrong.temp',
  'civil.item.dibao-apply': 'civil.allowance.intro',
  'civil.item.elder': 'mine.elder',

  // 低保复核
  'intro.btn.apply': 'civil.allowance.form',
  'form.btn.submit': 'civil.allowance.face',
  'face.btn.start': 'civil.allowance.risk',
  'intro.btn.progress': 'gov.todo',
  'temp.btn.apply': 'gov.todo',
  'risk.btn.confirm': 'civil.allowance.done',
  'risk.btn.cancel': 'civil.allowance.face',
  'done.btn.home': 'gov.home',

  // 误入页
  'temp.btn.back': 'gov.civil.list',
  'insurance.item.remote': 'medical.filing.form',

  // 资格认证
  'pension.intro.btn.start': 'pension.qualify.face',
  'pension.face.btn.start': 'pension.qualify.done',

  // 异地就医
  'medical.btn.submit': 'medical.filing.done',

  // 缴费
  'bill.btn.pay': 'utility.pay.confirm',
  'pay.btn.confirm': 'utility.done',
  'pay.btn.cancel': 'utility.bill',

  // 我的 · 办件与材料页里的回路
  'elder.btn.back': 'gov.mine',
};

/** 头部返回箭头对应的上一级（导航栈为空时的兜底） */
export const PARENT: Partial<Record<ScreenId, ScreenId>> = {
  'gov.service': 'gov.home',
  'gov.mine': 'gov.home',
  'gov.all': 'gov.service',
  'gov.edu.list': 'gov.service',
  'gov.civil.list': 'gov.service',
  'gov.todo': 'gov.service',
  'topic.shebao': 'gov.service',
  'topic.huji': 'gov.service',
  'topic.gongjijin': 'gov.service',
  'topic.shuwu': 'gov.service',
  'topic.birth': 'gov.service',
  'topic.school': 'gov.service',
  'topic.work': 'gov.service',
  'topic.retire': 'gov.service',
  'topic.pass': 'gov.service',
  'mine.elder': 'gov.mine',
  'mine.doc.idcard': 'gov.mine',
  'mine.doc.hukou': 'gov.mine',
  'mine.doc.dibao': 'gov.mine',
  'mine.doc.bank': 'gov.mine',
  'mine.family': 'gov.mine',
  'civil.allowance.intro': 'gov.civil.list',
  'civil.allowance.form': 'civil.allowance.intro',
  'civil.allowance.face': 'civil.allowance.form',
  'civil.allowance.risk': 'civil.allowance.face',
  'wrong.insurance': 'gov.home',
  'wrong.temp': 'gov.civil.list',
  'pension.qualify.intro': 'gov.home',
  'pension.qualify.face': 'pension.qualify.intro',
  'medical.filing.form': 'wrong.insurance',
  'utility.bill': 'gov.home',
  'utility.pay.confirm': 'utility.bill',
  'civil.allowance.done': 'gov.home',
  'pension.qualify.done': 'gov.home',
  'medical.filing.done': 'gov.home',
  'utility.done': 'gov.home',
};

/**
 * 每个屏幕归属哪个底部标签。
 *
 * 详情页也保留底部导航，是刻意的：老人从服务大厅点进「高龄津贴」之后，
 * 只要抬头就能回首页或去我的，不用记住返回箭头在哪。
 */
export const TAB_OF: Partial<Record<ScreenId, string>> = {
  'gov.home': 'tab.index',
  'gov.service': 'tab.service',
  'gov.mine': 'tab.mine',
  'gov.all': 'tab.service',
  'gov.civil.list': 'tab.service',
  'gov.edu.list': 'tab.service',
  'topic.shebao': 'tab.service',
  'topic.huji': 'tab.service',
  'topic.gongjijin': 'tab.service',
  'topic.shuwu': 'tab.service',
  'topic.birth': 'tab.service',
  'topic.school': 'tab.service',
  'topic.work': 'tab.service',
  'topic.retire': 'tab.service',
  'topic.pass': 'tab.service',
  'mine.elder': 'tab.mine',
  'mine.doc.idcard': 'tab.mine',
  'mine.doc.hukou': 'tab.mine',
  'mine.doc.dibao': 'tab.mine',
  'mine.doc.bank': 'tab.mine',
  'mine.family': 'tab.mine',
  'gov.todo': 'tab.service',
  'civil.allowance.intro': 'tab.service',
  'civil.allowance.form': 'tab.service',
  'civil.allowance.face': 'tab.service',
  'civil.allowance.risk': 'tab.service',
  'civil.allowance.done': 'tab.service',
  'wrong.insurance': 'tab.service',
  'wrong.temp': 'tab.service',
  'pension.qualify.intro': 'tab.service',
  'pension.qualify.face': 'tab.service',
  'pension.qualify.done': 'tab.service',
  'medical.filing.form': 'tab.service',
  'medical.filing.done': 'tab.service',
  'utility.bill': 'tab.service',
  'utility.pay.confirm': 'tab.service',
  'utility.done': 'tab.service',
};

/**
 * 演示中未开放的入口，点击后给出提示而不是死路。
 *
 * 注意措辞：不能说「我们先办低保复核」——用户办的可能不是低保（比如高龄津贴）。
 * 提示要说清两件事：后面那页没接进来（诚实）、下一步我会给你材料清单（有出路）。
 */
export const UNOPENED_HINT = '这个入口后面那页还没接进演示版。我把要带的东西念给您，真卡住了就点「我卡住了」。';

/**
 * 列表类入口的兜底：没有专门页面时进说明页。
 *
 * 为什么不是弹提示：弹提示两秒就消失，老人会以为没点上；
 * 进一页写清楚「这件事没接入、你可以回去了」，才是能读完的反馈。
 */
/**
 * 由界面自己处理、不换页的控件：字号切换、客服弹窗、说明页返回。
 *
 * 单独列出来，是为了让「无死路」的契约测试知道这几个不需要目标屏幕——
 * 否则测试会把它们当成漏配的入口。
 */
export const UI_ACTIONS = new Set([
  'mine.action.font',
  'mine.action.help',
  'elder.btn.hotline',
  'todo.btn.hotline',
  'todo.btn.back',
  'done.btn.share',
  'face.btn.help',
]);

const LIST_LIKE = /\.(item|grid|doc|family|action|topic)\./;

/** 是否属于「浏览类入口」——点它是想看，不是操作流程里的下一步 */
export function isBrowseControl(controlId: string): boolean {
  return LIST_LIKE.test(controlId) || controlId === 'todo.btn.back';
}

export function resolveTarget(controlId: string): { next?: ScreenId; message?: string } {
  const next = NAV[controlId];
  if (next) return { next };
  if (LIST_LIKE.test(controlId)) return { next: 'gov.todo' };
  return { message: UNOPENED_HINT };
}
