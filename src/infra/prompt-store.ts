import { readFileSync, existsSync } from 'node:fs';
import { z } from 'zod';
import { DEFAULT_PROMPTS, type PromptSet } from '@core/application/prompts';
import type { Logger } from './logger';

/**
 * 从外部 JSON 读提示词，覆盖出厂默认值。
 *
 * ## 三条设计约束
 *
 * 1. **文件不存在不算错误**——直接使用内置默认值。评测机、CI、别人克隆
 *    仓库第一次跑，不能因为少一个可选文件就起不来。
 *
 * 2. **文件存在但格式不对必须报错**，不许静默退回默认值。
 *    这一条比上一条重要得多：如果业务人员改了 JSON 漏了个括号，
 *    系统悄悄用回旧提示词，他会以为改动没效果，然后在错误的方向上
 *    排查半天。宁可启动失败，也不能让人改了个寂寞。
 *
 * 3. **允许只覆盖一部分**——比如只想改「办事引导」那一段，就只写 `guide`。
 *    其余字段继续用默认值。业务人员不需要抄一份完整文件。
 *
 * ## 为什么不热重载
 *
 * 提示词是「行为定义」，中途换掉会让同一单前后两句话风格不一致。
 * 改完重启，是这里刻意保留的粗糙——真要热更新，得配版本化与灰度，
 * 那是下一步的事，不是现在糊一个 watcher 就算完。
 */
const PromptFileSchema = z.object({
  version: z.string().trim().min(1).max(40),
  guide: z.string().min(20).optional(),
  intent: z.string().min(20).optional(),
  slot: z.string().min(20).optional(),
  question: z.string().min(20).optional(),
  plan: z.string().min(20).optional(),
});

export interface LoadedPrompts {
  prompts: PromptSet;
  /** 来源：file 表示读了外部文件，builtin 表示全用默认值 */
  source: 'file' | 'builtin';
  path: string;
}

export function loadPromptSet(filePath: string, logger?: Logger): LoadedPrompts {
  if (!existsSync(filePath)) {
    return { prompts: DEFAULT_PROMPTS, source: 'builtin', path: filePath };
  }

  const raw = readFileSync(filePath, 'utf8');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`提示词文件不是合法 JSON：${filePath}（${(err as Error).message}）`);
  }

  const parsed = PromptFileSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`提示词文件格式不对：${filePath}｜${first?.path.join('.')}：${first?.message}`);
  }

  const merged: PromptSet = {
    version: parsed.data.version,
    guide: parsed.data.guide ?? DEFAULT_PROMPTS.guide,
    intent: parsed.data.intent ?? DEFAULT_PROMPTS.intent,
    slot: parsed.data.slot ?? DEFAULT_PROMPTS.slot,
    question: parsed.data.question ?? DEFAULT_PROMPTS.question,
    plan: parsed.data.plan ?? DEFAULT_PROMPTS.plan,
  };

  logger?.info({ version: merged.version, path: filePath }, '提示词已从外部配置加载');
  return { prompts: merged, source: 'file', path: filePath };
}
