import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPromptSet } from '@infra/prompt-store';
import { DEFAULT_PROMPTS } from '@core/application/prompts';

/**
 * 提示词配置加载的契约。
 *
 * 这里守的是「业务人员改配置」这件事真的成立：
 *  - 没配置文件时不能崩；
 *  - 改了必须生效（不是看着加载了、实际还用旧值）；
 *  - 改错了必须当场报错（不能悄悄用回默认值，让人以为改动无效）。
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'prompts-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const file = () => path.join(dir, 'prompts.json');
const write = (obj: unknown) => writeFileSync(file(), JSON.stringify(obj), 'utf8');

describe('提示词配置', () => {
  it('没有配置文件时用内置默认值，不报错', () => {
    const loaded = loadPromptSet(file());
    expect(loaded.source).toBe('builtin');
    expect(loaded.prompts).toEqual(DEFAULT_PROMPTS);
  });

  it('配置文件存在时整包生效', () => {
    write({ version: 'v2', guide: '新的引导话术，至少二十个字符，用来通过最小长度校验。' });
    const loaded = loadPromptSet(file());
    expect(loaded.source).toBe('file');
    expect(loaded.prompts.version).toBe('v2');
    expect(loaded.prompts.guide).toContain('新的引导话术');
  });

  it('只覆盖想改的字段，其余继续用默认值', () => {
    write({ version: 'v2', question: '这是新的问答口吻，写得足够长，才能通过最小长度校验。' });
    const loaded = loadPromptSet(file());
    expect(loaded.prompts.question).toContain('新的问答口吻');
    /* 没写的字段不能被清空——否则改一处、坏四处 */
    expect(loaded.prompts.intent).toBe(DEFAULT_PROMPTS.intent);
    expect(loaded.prompts.plan).toBe(DEFAULT_PROMPTS.plan);
  });

  it('JSON 语法错必须报错，不许静默退回默认值', () => {
    writeFileSync(file(), '{ "version": "v2", ', 'utf8');
    expect(() => loadPromptSet(file())).toThrow(/不是合法 JSON/);
  });

  it('缺 version 必须报错——没有版本号就归不了因', () => {
    write({ guide: '一段足够长的引导话术，用来验证缺少版本号时的行为。' });
    expect(() => loadPromptSet(file())).toThrow(/version/);
  });

  it('提示词太短会被拦下，避免误删成空串', () => {
    write({ version: 'v3', guide: '短' });
    expect(() => loadPromptSet(file())).toThrow(/guide/);
  });
});
