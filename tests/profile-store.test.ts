import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonProfileStore } from '@infra/profile-store';
import type { Logger } from '@infra/logger';

/**
 * 长期档案的契约。
 *
 * 这份档案决定「怎么跟这位老人说话」，所以三件事必须钉死：
 * 记的东西能不能改、过没过期、会不会悄悄存在不该存的地方。
 * 顺带一条底线：档案坏了不能让老人办不了事。
 */

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const dirs: string[] = [];

function makeStore(ttlDays = 30, nowMs = 1_700_000_000_000) {
  const dir = mkdtempSync(path.join(tmpdir(), 'profile-store-'));
  dirs.push(dir);
  const file = path.join(dir, 'profiles.json');
  const clock = { now: nowMs };
  const store = new JsonProfileStore(file, ttlDays, silentLogger, () => clock.now);
  return { store, file, clock };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('档案存储', () => {
  it('存进去能读回来，改了「怎么讲」不会把称呼一起清掉', () => {
    const { store } = makeStore();
    store.save('device-0001', { displayName: '王秀兰', age: 68 });
    const saved = store.save('device-0001', { digitalLiteracy: 'high' });
    expect(saved.memory.displayName).toBe('王秀兰');
    expect(saved.memory.digitalLiteracy).toBe('high');
    expect(store.load('device-0001')?.memory.age).toBe(68);
  });

  it('空值不覆盖旧值：清空输入框不等于删掉这条记忆', () => {
    const { store } = makeStore();
    store.save('device-0002', { displayName: '王秀兰' });
    const saved = store.save('device-0002', { displayName: '' });
    expect(saved.memory.displayName).toBe('王秀兰');
  });

  it('过了有效期就读不到，并且从盘上清掉', () => {
    const { store, clock } = makeStore(30);
    store.save('device-0003', { displayName: '王秀兰' });
    /* 临到期前一天还认得 */
    clock.now += 29 * 86_400_000;
    expect(store.load('device-0003')).not.toBeNull();
    /* 过了就当作不认识 */
    clock.now += 2 * 86_400_000;
    expect(store.load('device-0003')).toBeNull();
    expect(store.forget('device-0003')).toBe(false);
  });

  it('忘记之后真的读不到', () => {
    const { store } = makeStore();
    store.save('device-0004', { displayName: '王秀兰' });
    expect(store.forget('device-0004')).toBe(true);
    expect(store.load('device-0004')).toBeNull();
  });

  it('文件坏掉时按空档案继续，不抛错也不清空原文件', () => {
    const { store, file } = makeStore();
    writeFileSync(file, '{ 这不是 JSON', 'utf8');
    expect(() => store.load('device-0005')).not.toThrow();
    expect(store.load('device-0005')).toBeNull();
    /* 坏了还能继续用：老人这时候只是丢了个性化，不该连事都办不了 */
    const saved = store.save('device-0005', { displayName: '王秀兰' });
    expect(saved.memory.displayName).toBe('王秀兰');
  });

  it('没有档案的陌生设备不会凭空读到一份', () => {
    const { store } = makeStore();
    expect(store.load('device-never-seen')).toBeNull();
  });
});
