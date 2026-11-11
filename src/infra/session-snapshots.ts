import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SessionSnapshot, SessionSnapshotPort } from '@core/ports';
import type { Logger } from './logger';

/**
 * 会话快照落到一个目录，一个会话一个 JSON 文件。
 *
 * 与档案落盘的区别：
 *  - 档案是「长期记忆」，被主动读取、参与措辞；快照只是「刚才办到哪」的副本，
 *    只有这个 sessionId 再次出现时才会读，读不到也不影响任何功能。
 *  - 因此它按目录分文件而不是塞进一个总表：单条会话说小也小，说大也大，
 *    一条写坏不该连累其他会话；懒加载时也只需读一个文件，不必解析整张表。
 *
 * 失败一律只记日志、不抛：快照是便利，不是必需品，写不进去不能让老人办不了事。
 */
export class JsonSessionSnapshots implements SessionSnapshotPort {
  constructor(
    private readonly dir: string,
    /** 有效期（小时）：中断太久还接着办，反而会让人对着一份过时的进度犯迷糊 */
    private readonly ttlHours: number,
    private readonly logger: Logger,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * 会话 id 来自 URL，必须当成不可信输入。
   * 只放行 UUID 形态，既挡住 `../` 这样的路径穿越，也顺带拒绝明显伪造的钥匙。
   */
  private fileOf(sessionId: string): string | null {
    if (!/^[0-9a-zA-Z-]{8,64}$/.test(sessionId)) return null;
    return path.join(this.dir, `${sessionId}.json`);
  }

  load(sessionId: string): SessionSnapshot | null {
    const file = this.fileOf(sessionId);
    if (!file) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as SessionSnapshot;
      if (!parsed || typeof parsed.id !== 'string' || parsed.id !== sessionId) return null;
      if (this.now() >= parsed.lastSeenAt + this.ttlHours * 3_600_000) {
        this.remove(sessionId);
        return null;
      }
      return parsed;
    } catch (error) {
      /* 文件不存在是常态（第一次访问或已被清理），不值得记一条告警 */
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn({ err: String(error), file }, '会话快照读取失败，按没有处理');
      }
      return null;
    }
  }

  save(snapshot: SessionSnapshot): void {
    const file = this.fileOf(snapshot.id);
    if (!file) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      /* 与档案同理：先写临时文件再改名，避免进程在中间被杀留下半个 JSON */
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
      renameSync(tmp, file);
    } catch (error) {
      this.logger.warn({ err: String(error), sessionId: snapshot.id }, '会话快照写入失败');
    }
  }

  remove(sessionId: string): void {
    const file = this.fileOf(sessionId);
    if (!file) return;
    try {
      rmSync(file, { force: true });
    } catch (error) {
      this.logger.warn({ err: String(error), file }, '会话快照清理失败');
    }
  }
}
