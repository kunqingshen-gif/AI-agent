import { createWriteStream, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { TelemetryEvent, TelemetryPort } from '@core/ports';
import type { Logger } from '../logger';

/**
 * 埋点落地为 JSONL（按天分文件），便于事后做「完成率 / 迷路率 / 护栏拦截率」统计，
 * 也便于在答辩现场用 tail -f 直接展示 Agent 的实时行为链路。
 *
 * 选型说明：演示阶段不引入数据库，单机顺序写入即可；生产替换为 Kafka/ClickHouse 时，
 * 只需换掉本类，应用层无感（依赖的是 TelemetryPort 接口）。
 */
export class JsonlTelemetry implements TelemetryPort {
  private readonly stream: ReturnType<typeof createWriteStream>;
  private readonly counters: Record<string, number> = {};
  private readonly writes: Promise<void>[] = [];

  constructor(
    dataDir: string,
    private readonly logger: Logger,
    /** 保留天数：按天分片但从不清理，长期运行会把磁盘写满 */
    retentionDays = 7,
  ) {
    mkdirSync(dataDir, { recursive: true });
    JsonlTelemetry.prune(dataDir, retentionDays, logger);
    const file = path.join(dataDir, `events-${new Date().toISOString().slice(0, 10)}.jsonl`);
    this.stream = createWriteStream(file, { flags: 'a', encoding: 'utf8' });
    this.stream.on('error', (err) => this.logger.error({ err: String(err) }, '埋点写入失败'));
  }

  /**
   * 启动时清掉过期的分片。
   * 只认 `events-YYYY-MM-DD.jsonl` 这一种命名，别的文件一律不碰 ——
   * 数据目录可能被人放了别的东西，清理逻辑不该越权。
   */
  private static prune(dataDir: string, retentionDays: number, logger: Logger): void {
    if (retentionDays <= 0) return;
    const cutoff = Date.now() - retentionDays * 86_400_000;
    try {
      for (const name of readdirSync(dataDir)) {
        const matched = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
        if (!matched?.[1]) continue;
        const at = Date.parse(`${matched[1]}T00:00:00Z`);
        if (!Number.isFinite(at) || at >= cutoff) continue;
        try {
          unlinkSync(path.join(dataDir, name));
        } catch (error) {
          logger.warn({ file: name, err: String(error) }, '过期埋点清理失败，跳过');
        }
      }
    } catch (error) {
      /* 目录不可读不该阻断服务启动 */
      logger.warn({ dataDir, err: String(error) }, '埋点目录扫描失败');
    }
  }

  record(event: TelemetryEvent): void {
    this.counters[event.type] = (this.counters[event.type] ?? 0) + 1;
    const line = `${JSON.stringify(event)}\n`;
    if (!this.stream.write(line)) {
      // 背压时排队，避免丢事件
      this.writes.push(new Promise((resolve) => this.stream.once('drain', () => resolve())));
    }
  }

  async summary(): Promise<Record<string, number>> {
    await Promise.all(this.writes.splice(0));
    return { ...this.counters };
  }

  async close(): Promise<void> {
    await this.summary();
    await new Promise<void>((resolve) => this.stream.end(resolve));
  }
}

/** 测试与本地开发用的内存实现 */
export class InMemoryTelemetry implements TelemetryPort {
  readonly events: TelemetryEvent[] = [];

  record(event: TelemetryEvent): void {
    this.events.push(event);
  }

  async summary(): Promise<Record<string, number>> {
    return this.events.reduce<Record<string, number>>((acc, e) => {
      acc[e.type] = (acc[e.type] ?? 0) + 1;
      return acc;
    }, {});
  }
}
