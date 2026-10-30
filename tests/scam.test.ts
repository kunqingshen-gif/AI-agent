import { describe, expect, it } from 'vitest';
import { assessScam } from '@core/domain/scam';

/**
 * 反诈判别的契约，重点在「不误伤」：
 *  - 漏判的代价是倾家荡产，误判的代价是老人被吓得不敢用手机；
 *  - 所以正常办事的一句话必须判为 none，而真正的诈骗话术必须判为 high；
 *  - 已经转了钱要切换到止损路径，而不是继续讲「不要转账」。
 */

describe('高危话术', () => {
  it('冒充医保 + 安全账户，判高危并给出挂电话的指令', () => {
    const result = assessScam('刚才有人打电话说我的医保卡在上海违规使用，要我把钱转到安全账户');
    expect(result.level).toBe('high');
    expect(result.verdict).toContain('诈骗');
    expect(result.hits.map((hit) => hit.id)).toContain('safe-account');
    expect(result.advice[0]).toContain('挂掉');
    expect(result.hotlines.map((line) => line.phone)).toContain('96110');
  });

  it('索要验证码加账户冻结，按高危处理', () => {
    const result = assessScam('有人让我报验证码，说我的卡被冻结了');
    expect(result.level).toBe('high');
    expect(result.hits.map((hit) => hit.id)).toContain('code');
    expect(result.advice.join('')).toContain('验证码');
  });

  it('让您别告诉家里人，本身就是最强的信号之一', () => {
    const result = assessScam('他说这个案子要保密，不要告诉家里人，还要我下载一个软件');
    expect(result.level).toBe('high');
    expect(result.hits.map((hit) => hit.id)).toEqual(expect.arrayContaining(['secret', 'remote']));
  });
});

describe('不误伤', () => {
  it('正常办事的话一句都不能判成诈骗', () => {
    for (const text of ['我要办低保复核', '我要交水费', '什么是教育服务', '养老金要认证，我不会弄', '低保复核要带什么材料']) {
      const result = assessScam(text);
      expect(result.level, text).toBe('none');
      expect(result.advice.length, text).toBeGreaterThan(0);
    }
  });

  it('只提到机构名不构成风险', () => {
    const result = assessScam('我想问一下社保局在哪里');
    expect(result.level).toBe('none');
    expect(result.context).toContain('社保');
  });

  it('只说「转账」这一个词，判可疑而不是确定诈骗', () => {
    const result = assessScam('转账要怎么弄');
    expect(result.level).toBe('medium');
    expect(result.verdict).toContain('先别');
  });
});

describe('已经把钱给出去了', () => {
  it('识别为已发生，切换成止损路径', () => {
    const result = assessScam('我已经把钱转过去了，怎么办');
    expect(result.alreadyExposed).toBe(true);
    expect(result.level).toBe('high');
    expect(result.verdict).toContain('止损');
    expect(result.hotlines.map((line) => line.phone)).toContain('110');
    expect(result.advice[0]).toContain('110');
  });

  it('提醒二次诈骗——这是受害老人最容易被再骗一次的地方', () => {
    const result = assessScam('我已经把验证码给他了');
    expect(result.advice.join('')).toContain('第二次诈骗');
  });

  it('给家人的话要能直接发出去', () => {
    const result = assessScam('有人冒充公安局让我转账');
    expect(result.familyNote).toContain('骗子');
    expect(result.familyNote.length).toBeGreaterThan(15);
  });
});
