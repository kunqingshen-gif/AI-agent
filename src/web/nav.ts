import type { ScreenId } from '@shared/types';

/**
 * 模拟应用内的跳转关系。
 *
 * 这层只是「演示用的假 App 路由」——真实产品里，跳转由对方 App 自己完成，
 * 我们只负责读屏与指路（见 docs/adr/0002）。
 */
export const NAV: Record<string, ScreenId> = {
  // 政务首页
  'home.grid.minzheng': 'gov.civil.list',
  'home.grid.yibao': 'wrong.insurance',
  'home.grid.shebao': 'pension.qualify.intro',
  'home.grid.gengduo': 'utility.bill',

  // 民政服务列表
  'civil.item.dibao-renew': 'civil.allowance.intro',
  'civil.item.temp': 'wrong.temp',
  'civil.item.dibao-apply': 'civil.allowance.intro',

  // 低保复核
  'intro.btn.apply': 'civil.allowance.form',
  'form.btn.submit': 'civil.allowance.face',
  'face.btn.start': 'civil.allowance.risk',
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
};

/** 头部返回箭头对应的上一级 */
export const PARENT: Partial<Record<ScreenId, ScreenId>> = {
  'gov.civil.list': 'gov.home',
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

/** 演示中未开放的事项，点击后给出提示而不是死路 */
export const UNOPENED_HINT = '这个事项本次演示没有开放，我们先办低保复核。';

export function resolveTarget(controlId: string): { next?: ScreenId; message?: string } {
  const next = NAV[controlId];
  return next ? { next } : { message: UNOPENED_HINT };
}
