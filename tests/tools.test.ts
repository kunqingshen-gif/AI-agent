import { describe, expect, it } from 'vitest';
import { routeTool } from '@core/domain/tools';

/**
 * 工具路由的契约：
 *  1. 四种能力要能靠一句话进入，这是「不用先知道入口在哪」的前提；
 *  2. 不能抢原有的办事与问答链路——「帮我办低保复核」「低保要带什么材料」
 *     必须原样落到意图识别与知识库，否则主线会被工具面板吃掉；
 *  3. 风险优先：一句话同时像办事和像诈骗时，按诈骗处理。
 */

describe('四种能力的入口', () => {
  it('问「还差什么」进办前体检，并带上事项', () => {
    const route = routeTool('我这低保复核的材料还差什么');
    expect(route?.kind).toBe('preflight');
    expect(route?.taskId).toBe('allowance.renew');
    expect(route?.reason).toContain('缺什么');
  });

  it('问材料够不够也进体检', () => {
    expect(routeTool('我的材料齐了吗')?.kind).toBe('preflight');
    expect(routeTool('这次会不会被退回')?.kind).toBe('preflight');
  });

  it('问「有什么事要办」进守护日历', () => {
    expect(routeTool('我最近有什么事要办')?.kind).toBe('lifecycle');
    expect(routeTool('有什么快到期的吗')?.kind).toBe('lifecycle');
    expect(routeTool('我还有什么没办的')?.kind).toBe('lifecycle');
  });

  it('想让家人远程帮忙进协办', () => {
    expect(routeTool('我女儿能不能远程帮我弄')?.kind).toBe('collab');
    expect(routeTool('能不能叫我儿子一起看')?.kind).toBe('collab');
  });

  it('可疑来电进反诈', () => {
    const route = routeTool('刚才有人打电话说我医保卡涉案，让我转账');
    expect(route?.kind).toBe('scam');
    expect(route?.confidence).toBeGreaterThan(0.9);
  });
});

describe('不抢原有链路', () => {
  it('办事指令原样交给意图识别', () => {
    for (const text of ['帮我办低保复核', '我要办低保复核', '我想问一下低保那个复核，今年还没弄呢', '养老金要认证，我不会弄']) {
      expect(routeTool(text), text).toBeNull();
    }
  });

  it('知识型提问原样交给知识库', () => {
    for (const text of ['什么是教育服务', '低保复核要带什么材料', '高龄津贴什么条件']) {
      expect(routeTool(text), text).toBeNull();
    }
  });

  it('太短的话不做路由', () => {
    expect(routeTool('办')).toBeNull();
    expect(routeTool('   ')).toBeNull();
  });
});

describe('风险优先', () => {
  it('一句话同时像办事和像诈骗时，按诈骗处理', () => {
    const route = routeTool('有人打电话让我把低保的钱转到安全账户，我该不该办');
    expect(route?.kind).toBe('scam');
  });
});
