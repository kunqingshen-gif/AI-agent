import { describe, expect, it } from 'vitest';
import { detectDialect, normalizeUtterance, screenVocabulary, speechLangOf } from '../src/web/speech-fix';

describe('语音归一：方言', () => {
  it('粤语「唔识点样办」被翻成「想办」，而不是一句会被当成提问的「不会怎么办」', () => {
    const result = normalizeUtterance('我唔识点样办低保复核');
    expect(result.dialect).toBe('粤语');
    expect(result.text).toBe('我想办低保复核');
    expect(result.text).not.toContain('怎么办');
    expect(result.fixes.every((fix) => fix.via === 'dialect')).toBe(true);
  });

  it('四川话「啥子」能认出，没认出来的方言不硬猜', () => {
    expect(detectDialect('我要办啥子业务')).toBe('四川话');
    expect(detectDialect('我要办低保复核')).toBeNull();
    expect(normalizeUtterance('我要办低保复核').text).toBe('我要办低保复核');
  });
});

describe('语音归一：同音与老人叫法', () => {
  it('把听错的「高领津贴」改回「高龄津贴」', () => {
    const result = normalizeUtterance('我要办高领津贴');
    expect(result.text).toBe('我要办高龄津贴');
    expect(result.fixes[0]).toMatchObject({ from: '高领津贴', to: '高龄津贴', via: 'lexicon' });
  });

  it('这一页上写着标准词时，校正理由记为「看得见的」', () => {
    const result = normalizeUtterance('我要办高领津贴', { screenText: screenVocabulary('mine.elder') });
    expect(result.text).toBe('我要办高龄津贴');
    expect(result.fixes[0]?.via).toBe('screen');
  });

  it('只改确定的词，不碰正常说法', () => {
    expect(normalizeUtterance('我买了一件高领毛衣').text).toBe('我买了一件高领毛衣');
    expect(normalizeUtterance('老人钱到了没有').text).toBe('高龄津贴到了没有');
  });

  it('档案里的常用方言优先于自动判断', () => {
    const result = normalizeUtterance('我要办事', { dialect: '粤语' });
    expect(result.dialect).toBe('粤语');
  });
});

describe('语音归一：听得见的前提是说得对', () => {
  it('粤语用 zh-HK 语言包，其余不假装支持', () => {
    expect(speechLangOf('粤语')).toBe('zh-HK');
    expect(speechLangOf('四川话')).toBe('zh-CN');
    expect(speechLangOf(undefined)).toBe('zh-CN');
  });

  it('屏幕词表真的包含这一页上的字', () => {
    const words = screenVocabulary('mine.elder');
    expect(words).toContain('高龄');
    expect(words.length).toBeGreaterThan(10);
  });
});
