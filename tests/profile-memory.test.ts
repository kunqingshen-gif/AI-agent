import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AssistService } from '@core/application/assist-service';
import { JsonProfileStore } from '@infra/profile-store';
import { InMemoryTelemetry } from '@infra/telemetry/jsonl';
import type { LlmPort, LlmRequest } from '@core/ports';
import type { Logger } from '@infra/logger';

/**
 * 记忆分层的应用层契约。
 *
 * 要证的不是「存了个文件」，而是三件用户能感觉到的事：
 * 下次进来它还记得、我改了就立刻照新说法、我说忘掉就真的忘掉。
 * 记忆能力如果只体现在代码结构里，对评委和老人来说都等于没有。
 */

class FakeLlm implements LlmPort {
  available = false;
  model = 'fake-model';
  async complete(_req: LlmRequest): Promise<string> {
    return '{}';
  }
}

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const dirs: string[] = [];

function build() {
  const dir = mkdtempSync(path.join(tmpdir(), 'profile-memory-'));
  dirs.push(dir);
  const store = new JsonProfileStore(path.join(dir, 'profiles.json'), 180, silentLogger);
  const telemetry = new InMemoryTelemetry();
  const service = new AssistService(new FakeLlm(), telemetry, { now: () => 1_700_000_000_000 }, silentLogger, {
    profiles: store,
  });
  return { service, telemetry, store };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('记忆分层', () => {
  it('第二次进来自动认出上次那个说法', () => {
    const { service } = build();
    const first = service.openSession(undefined, 'device-a');
    expect(first.profileSource).toBe('session');
    service.updateMemory(first.id, { digitalLiteracy: 'low', displayName: '王阿姨' });

    const second = service.openSession(undefined, 'device-a');
    expect(second.profileSource).toBe('stored');
    expect(second.profile.digitalLiteracy).toBe('low');
    expect(second.profile.displayName).toBe('王阿姨');
  });

  it('这次明确说的，压过上次记住的', () => {
    const { service } = build();
    const first = service.openSession(undefined, 'device-b');
    service.updateMemory(first.id, { digitalLiteracy: 'low' });

    /* 用户这次带了「我会用手机」进来，不该被旧档案拉回去 */
    const second = service.openSession({ digitalLiteracy: 'high' }, 'device-b');
    expect(second.profile.digitalLiteracy).toBe('high');
  });

  it('改完立刻生效，不必重开会话', () => {
    const { service } = build();
    const session = service.openSession(undefined, 'device-c');
    const result = service.updateMemory(session.id, { digitalLiteracy: 'high' });
    expect(result?.view.memory.digitalLiteracy).toBe('high');
    /* 回给老人的那句话也要跟着变，否则他不知道改成了什么样 */
    expect(result?.message).toContain('直接说下一步');
    expect(service.getSession(session.id)?.profile.digitalLiteracy).toBe('high');
  });

  it('说忘掉就真的忘掉，会话退回默认档案', () => {
    const { service, store } = build();
    const session = service.openSession(undefined, 'device-d');
    service.updateMemory(session.id, { digitalLiteracy: 'high' });
    expect(store.load('device-d')).not.toBeNull();

    expect(service.forgetMemory(session.id)).toBe(true);
    expect(store.load('device-d')).toBeNull();
    expect(service.getSession(session.id)?.profile.digitalLiteracy).toBe('low');
    expect(service.profileView(session.id)?.source).toBe('session');
  });

  it('不留名也能用：不传档案编号就只活在这次会话里', () => {
    const { service, store } = build();
    const session = service.openSession({ displayName: '李大爷' });
    expect(session.ownerId).toBeUndefined();
    expect(service.updateMemory(session.id, { digitalLiteracy: 'medium' })?.view.source).toBe('session');
    /* 关键：没有编号就不该凭空造一条档案出来 */
    expect(store.load('undefined')).toBeNull();
  });

  it('改档案会留下埋点，改动是否生效可事后核对', () => {
    const { service, telemetry } = build();
    const session = service.openSession(undefined, 'device-e');
    service.updateMemory(session.id, { digitalLiteracy: 'medium' });
    const event = telemetry.events.find((e) => e.type === 'profile.updated');
    expect(event?.payload.digitalLiteracy).toBe('medium');
    expect(event?.payload.persisted).toBe(true);
  });
});
