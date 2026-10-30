import { describe, expect, it } from 'vitest';
import { FAQ_ENTRIES, looksLikeQuestion, matchFaq } from '@core/domain/faq';
import { sanitizeAnswer } from '@core/domain/guardrails';
import { TASK_FLOWS } from '@core/domain/catalog';

/**
 * 问答通道的契约：
 *  1. 什么问题该答、什么问题该办，边界必须稳定（否则演示主线会被答成科普）；
 *  2. 回答不能越界（不指挥转账、不说死金额时限）；
 *  3. 知识库里的 relatedTaskId 必须真的存在。
 */
describe('提问识别', () => {
  it('疑问句式走问答', () => {
    for (const text of ['什么是教育服务', '高龄津贴要什么条件', '低保复核要带什么材料', '教育服务里能办入学吗？', '养老金认证多久一次']) {
      expect(looksLikeQuestion(text), text).toBe(true);
    }
  });

  it('办事指令不走问答', () => {
    for (const text of ['我要办低保复核', '我想问一下低保那个复核，今年还没弄呢', '养老金要认证，我不会弄', '帮我提交低保申请']) {
      expect(looksLikeQuestion(text), text).toBe(false);
    }
  });
});

describe('知识库', () => {
  it('常见问题都能命中', () => {
    expect(matchFaq('什么是教育服务')[0]?.id).toBe('faq.edu');
    expect(matchFaq('高龄津贴怎么申请')[0]?.id).toBe('faq.elder');
    expect(matchFaq('异地就医备案是什么')[0]?.id).toBe('faq.medical');
  });

  it('无关的话不硬套知识', () => {
    expect(matchFaq('今天天气怎么样')).toEqual([]);
  });

  it('每条 relatedTaskId 都指向真实存在的事项', () => {
    for (const entry of FAQ_ENTRIES) {
      if (!entry.relatedTaskId) continue;
      expect(TASK_FLOWS[entry.relatedTaskId], `${entry.id} 指向了不存在的事项`).toBeDefined();
    }
  });

  it('金额类表述不写死数字，避免地区差异说错', () => {
    for (const entry of FAQ_ENTRIES) {
      expect(/每月\s*\d+\s*元/.test(entry.answer), `${entry.id} 写死了金额`).toBe(false);
    }
  });
});

describe('回答文案过滤', () => {
  it('反诈提醒里出现「转账」是允许的', () => {
    const result = sanitizeAnswer('任何让您转账到安全账户的都是诈骗，请挂断并拨 96110。', '兜底');
    expect(result.rejected).toBe(false);
  });

  it('指挥用户转账被拒绝', () => {
    const result = sanitizeAnswer('请先转账 2000 元到安全账户，再回来继续。', '兜底');
    expect(result.rejected).toBe(true);
    expect(result.text).toBe('兜底');
  });

  it('让用户说出验证码被拒绝', () => {
    expect(sanitizeAnswer('把短信验证码告诉我，我帮您验证。', '兜底').rejected).toBe(true);
  });

  it('超长回答截到完整句子而不是整条丢弃', () => {
    const long = `${'这是一段很长的政策说明。'.repeat(30)}`;
    const result = sanitizeAnswer(long, '兜底', 60);
    expect(result.rejected).toBe(false);
    expect(result.text.length).toBeLessThanOrEqual(61);
    expect(result.text.endsWith('。') || result.text.endsWith('…')).toBe(true);
  });
});
