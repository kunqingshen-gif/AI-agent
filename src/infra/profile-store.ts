import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ProfileStorePort, StoredProfile } from '@core/ports';
import type { ProfileMemory } from '@shared/types';
import type { Logger } from './logger';

/**
 * 长期档案落地为一个 JSON 文件。
 *
 * 为什么不是数据库：演示阶段一个文件就够，而且能直接 cat 给评委看「我们到底记了什么」——
 * 记忆系统最该被审视的正是这一件事。将来换 Redis/数据库时只换本类，应用层无感。
 *
 * 与提示词配置的关键区别：提示词格式错必须启动失败（改坏了要当场知道），
 * 档案文件坏掉则**降级成空档案继续跑**——档案缺失不能让老人办不了事，
 * 同样是「配置」，一个要拦、一个要让，因为它们一个管行为、一个管便利。
 */
export class JsonProfileStore implements ProfileStorePort {
  private cache: Record<string, StoredProfile> | null = null;

  constructor(
    private readonly filePath: string,
    /** 有效期（天）：太久不来的老人，档案自然淡出，不拿过期信息冒充了解 */
    private readonly ttlDays: number,
    private readonly logger: Logger,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private readAll(): Record<string, StoredProfile> {
    if (this.cache) return this.cache;
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      this.cache =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, StoredProfile>)
          : {};
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      if (!missing) {
        /* 坏了就当没有，但要留一句日志：不然「记忆时好时坏」会变成玄学 */
        this.logger.warn({ err: String(error), path: this.filePath }, '档案文件读取失败，按空档案继续');
      }
      this.cache = {};
    }
    return this.cache;
  }

  private flush(all: Record<string, StoredProfile>): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    /* 先写临时文件再改名：直接覆盖写，进程在中间被杀就留下半个 JSON */
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8');
    renameSync(tmp, this.filePath);
  }

  load(ownerId: string): StoredProfile | null {
    const record = this.readAll()[ownerId];
    if (!record) return null;
    if (this.now() >= record.expiresAt) {
      /* 过期即删，不留着等下次再判一遍——过期数据留在盘上只是隐患 */
      this.forget(ownerId);
      this.logger.info({ ownerId }, '档案已过期，按没有处理');
      return null;
    }
    return record;
  }

  save(ownerId: string, memory: ProfileMemory): StoredProfile {
    const all = this.readAll();
    const at = this.now();
    const previous = all[ownerId];
    const record: StoredProfile = {
      /* 增量合并而不是整份替换：这次只改了「怎么讲」，不该把称呼一起清掉 */
      memory: { ...previous?.memory, ...stripEmpty(memory) },
      updatedAt: at,
      expiresAt: at + this.ttlDays * 86_400_000,
    };
    all[ownerId] = record;
    this.flush(all);
    return record;
  }

  forget(ownerId: string): boolean {
    const all = this.readAll();
    if (!(ownerId in all)) return false;
    delete all[ownerId];
    this.flush(all);
    return true;
  }
}

/** 空字符串/undefined 不覆盖旧值：用户清空了输入框，不该等于删掉这条记忆 */
function stripEmpty(memory: ProfileMemory): ProfileMemory {
  const out: ProfileMemory = {};
  for (const [key, value] of Object.entries(memory)) {
    if (value === undefined || value === '') continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}
