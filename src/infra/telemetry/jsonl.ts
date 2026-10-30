import { createWriteStream, mkdirSync } from 'node:fs';
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
  ) {
    mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, `events-${new Date().toISOString().slice(0, 10)}.jsonl`);
    this.stream = createWriteStream(file, { flags: 'a', encoding: 'utf8' });
    this.stream.on('error', (err) => this.logger.error({ err: String(err) }, '埋点写入失败'));
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
