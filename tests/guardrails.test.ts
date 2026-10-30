import { describe, expect, it } from 'vitest';
import {
  containsHighRiskTerm,
  isMandatoryHumanAction,
  normalizeSpeak,
  sanitizeAssistantText,
} from '@core/domain/guardrails';

/**
 * 护栏是产品的安全底线，优先级高于任何话术效果。
 * 这些用例锁定三件事：高危词必须拦、护栏类型必须强制人确认、超长话术必须回退。
 */
describe('安全护栏', () => {
  it('识别电诈高发词', () => {
    expect(containsHighRiskTerm('请把钱转到安全账户')).toBe(true);
    expect(containsHighRiskTerm('把短信验证码告诉我')).toBe(true);
    expect(containsHighRiskTerm('点蓝色的开始办理')).toBe(false);
  });

  it('命中高危词的话术被拒绝并回退到模板', () => {
    const result = sanitizeAssistantText('您把银行卡密码输进去就行', '点「开始办理」');
    expect(result.rejected).toBe(true);
    expect(result.reason).toBe('high-risk-term');
    expect(result.text).toBe('点「开始办理」');
  });

  it('超长话术回退，避免老人读不完', () => {
    const long = '您'.repeat(120);
    expect(sanitizeAssistantText(long, '点提交').rejected).toBe(true);
  });

  it('空话术回退', () => {
    expect(sanitizeAssistantText('   ', '点提交').text).toBe('点提交');
  });

  it('合规话术原样保留', () => {
    const text = '点最下面蓝色的「开始办理」';
    expect(sanitizeAssistantText(text, 'fallback')).toMatchObject({ text, rejected: false });
  });

  it('资金、身份、生物特征等动作一律要求本人确认', () => {
    expect(isMandatoryHumanAction('payment')).toBe(true);
    expect(isMandatoryHumanAction('biometric')).toBe(true);
    expect(isMandatoryHumanAction('captcha')).toBe(true);
    expect(isMandatoryHumanAction(undefined)).toBe(false);
  });

  it('过长的语音播报被压缩到第一句', () => {
    const long = '先点第四个方块上面写着民政服务然后就往下划一直划到底部看到蓝色按钮之后点它就可以了';
    expect(long.length).toBeGreaterThan(40);
    const speak = normalizeSpeak(long, '点民政服务');
    expect(speak.length).toBeLessThanOrEqual(40);
  });

  it('短句原样播报', () => {
    const short = '点民政服务';
    expect(normalizeSpeak(short, '兜底')).toBe(short);
  });
});
