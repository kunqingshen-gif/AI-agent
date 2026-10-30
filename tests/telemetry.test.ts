import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlTelemetry } from '@infra/telemetry/jsonl';
import type { Logger } from '@infra/logger';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

/**
 * 埋点按天分片本身是对的，但「只写不删」在长期运行的服务上等于慢性磁盘泄漏。
 * 这里锁住清理边界：过期的删、当天的留、别人的文件绝不碰。
 */
describe('埋点轮转', () => {
  const dirs: string[] = [];

  function tempDir(): string {
    const dir = mkdtempSync(join(process.cwd(), '.tmp-telemetry-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('启动时清掉超过保留期的分片，保留期内的不动', () => {
    const dir = tempDir();
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(join(dir, 'events-2020-01-01.jsonl'), '{}\n');
    writeFileSync(join(dir, `events-${today}.jsonl`), '{}\n');

    const telemetry = new JsonlTelemetry(dir, silentLogger, 7);
    const left = readdirSync(dir);
    expect(left).not.toContain('events-2020-01-01.jsonl');
    expect(left).toContain(`events-${today}.jsonl`);
    expect(left.filter((f) => f === `events-${today}.jsonl`)).toHaveLength(1);
    void telemetry.close();
  });

  it('不碰非本类命名的文件', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'notes.txt'), 'keep me');
    writeFileSync(join(dir, 'events-old.jsonl'), 'keep me too');

    void new JsonlTelemetry(dir, silentLogger, 7).close();
    const left = readdirSync(dir);
    expect(left).toContain('notes.txt');
    expect(left).toContain('events-old.jsonl');
  });

  it('retentionDays<=0 时关闭清理', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'events-2020-01-01.jsonl'), '{}\n');
    void new JsonlTelemetry(dir, silentLogger, 0).close();
    expect(readdirSync(dir)).toContain('events-2020-01-01.jsonl');
  });
});
