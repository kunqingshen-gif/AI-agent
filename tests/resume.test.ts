import { describe, expect, it, vi } from 'vitest';
import { AssistService } from '@core/application/assist-service';
import type { LlmPort, LlmRequest } from '@core/ports';
import { InMemoryTelemetry } from '@infra/telemetry/jsonl';
import type { Logger } from '@infra/logger';
import type { AssistRequest, ScreenId } from '@shared/types';

/**
 * 断点续办的契约：
 *  1. 快照必须说出「办的是哪件事、停在第几步」，前端才摆得回去；
 *  2. 没开始办就不要编造进度；
 *  3. 会话不在了返回 null，由调用方退回首页，而不是抛错。
 */

class FakeLlm implements LlmPort {
  available = true;
  model = 'fake-model';
  health = { available: true, healthy: true };

  async complete(_req: LlmRequest): Promise<string> {
    void _req;
    return JSON.stringify({ taskId: 'allowance.renew', confidence: 0.92, restated: '低保复核' });
  }
}

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const clock = { now: () => 1_700_000_000_000 };

function build() {
  return new AssistService(new FakeLlm(), new InMemoryTelemetry(), clock, silentLogger);
}

const guideReq = (sessionId: string, screenId: ScreenId): AssistRequest => ({
  sessionId,
  screenId,
  slots: {},
  attemptsOnScreen: 0,
  asksForHelp: false,
});

describe('断点快照', () => {
  it('办到一半时，能说出事项、屏幕与第几步', async () => {
    const service = build();
    const session = service.createSession();
    await service.interpret(session.id, '我想问一下低保那个复核');
    await service.guide(session.id, guideReq(session.id, 'gov.home'));

    const snap = service.sessionSnapshot(session.id);
    expect(snap).not.toBeNull();
    expect(snap?.screenId).toBe('gov.home');
    expect(snap?.resume?.taskId).toBe('allowance.renew');
    expect(snap?.resume?.taskTitle).toContain('低保');
    expect(snap?.resume?.total).toBe(12);
    expect(snap?.resume?.index).toBe(1);
    expect(snap?.resume?.stepLabel).toBe('第 1 步 / 共 12 步');
    expect(snap?.resume?.finished).toBe(false);
  });

  it('换了屏幕之后，快照跟着走，不会把人送回起点', async () => {
    const service = build();
    const session = service.createSession();
    await service.interpret(session.id, '我想问一下低保那个复核');
    await service.guide(session.id, guideReq(session.id, 'gov.home'));
    await service.guide(session.id, guideReq(session.id, 'gov.civil.list'));

    const snap = service.sessionSnapshot(session.id);
    expect(snap?.screenId).toBe('gov.civil.list');
    expect(snap?.resume?.index).toBe(2);
  });

  it('还没开始办时不编造进度', () => {
    const service = build();
    const session = service.createSession();
    const snap = service.sessionSnapshot(session.id);
    expect(snap?.resume).toBeNull();
    expect(snap?.screenId).toBe('gov.home');
  });

  it('会话不在了返回 null，而不是抛错', () => {
    expect(build().sessionSnapshot('no-such-session')).toBeNull();
  });
});
