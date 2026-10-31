import { describe, expect, it, vi } from 'vitest';
import { AssistService } from '@core/application/assist-service';
import type { LlmPort, LlmRequest } from '@core/ports';
import { InMemoryTelemetry } from '@infra/telemetry/jsonl';
import type { Logger } from '@infra/logger';

/**
 * 结果反馈的契约。
 *
 * 在此之前，产品对「自己办得对不对」是完全没有信号的：
 * 提示词和事项库只能靠开发者拍脑袋改。这三档反馈是唯一的反向通道，
 * 所以它的行为必须钉死——尤其是「它说错了」不能被静默吞掉。
 */

class FakeLlm implements LlmPort {
  available = true;
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

const clock = { now: () => 1_700_000_000_000 };

function build() {
  const telemetry = new InMemoryTelemetry();
  const service = new AssistService(new FakeLlm(), telemetry, clock, silentLogger);
  const session = service.createSession({ displayName: '王秀兰' });
  return { service, telemetry, sessionId: session.id };
}

describe('结果反馈', () => {
  it('三档都能记，并同步进会话指标', () => {
    const { service, sessionId } = build();
    const m = service.recordFeedback(sessionId, 'worked');
    expect(m.feedback).toBe('worked');
    expect(service.metrics(sessionId).feedback).toBe('worked');
  });

  it('写进埋点，且带上当时的任务与走偏次数', () => {
    const { service, telemetry, sessionId } = build();
    service.recordFeedback(sessionId, 'wrong');
    const event = telemetry.events.find((e) => e.type === 'feedback.given');
    expect(event).toBeDefined();
    expect(event?.sessionId).toBe(sessionId);
    expect(event?.payload.verdict).toBe('wrong');
    /* 归因要看全过程，不只看最后一步——所以这两个字段必须一起记 */
    expect(event?.payload).toHaveProperty('wrongTurns');
    expect(event?.payload).toHaveProperty('stepsGuided');
  });

  it('改主意可以覆盖结论，但每一笔都留痕', () => {
    const { service, telemetry, sessionId } = build();
    service.recordFeedback(sessionId, 'failed');
    service.recordFeedback(sessionId, 'wrong');
    expect(service.metrics(sessionId).feedback).toBe('wrong');
    /* 埋点不去重：看得出「改主意」本身有多常见 */
    expect(telemetry.events.filter((e) => e.type === 'feedback.given')).toHaveLength(2);
  });

  it('备注只留前 200 字，埋点不是工单', () => {
    const { service, telemetry, sessionId } = build();
    service.recordFeedback(sessionId, 'wrong', '啊'.repeat(500));
    const event = telemetry.events.find((e) => e.type === 'feedback.given');
    expect(String(event?.payload.note)).toHaveLength(200);
  });

  it('会话不存在时明确报错，不静默吞掉', () => {
    const { service } = build();
    expect(() => service.recordFeedback('not-a-real-session', 'worked')).toThrow();
  });

  it('空备注不影响反馈本身', () => {
    const { service, telemetry, sessionId } = build();
    service.recordFeedback(sessionId, 'worked');
    const event = telemetry.events.find((e) => e.type === 'feedback.given');
    expect(event?.payload.note).toBeNull();
    expect(event?.payload.verdict).toBe('worked');
  });
});

describe('质量指标', () => {
  it('没有反馈时全为 0，不把「没说话」算成满意', () => {
    const { service } = build();
    expect(service.quality()).toEqual({ total: 0, worked: 0, failed: 0, wrong: 0, wrongRate: 0 });
  });

  it('按人头统计三档，并算出「说错了」占比', () => {
    const { service } = build();
    const a = service.createSession({});
    const b = service.createSession({});
    const c = service.createSession({});
    service.recordFeedback(a.id, 'worked');
    service.recordFeedback(b.id, 'wrong');
    service.recordFeedback(c.id, 'wrong');
    const q = service.quality();
    expect(q).toMatchObject({ total: 3, worked: 1, wrong: 2 });
    expect(q.wrongRate).toBeCloseTo(0.667, 2);
  });

  it('同一个人改主意只算一次，不重复计人头', () => {
    const { service } = build();
    const a = service.createSession({});
    service.recordFeedback(a.id, 'failed');
    service.recordFeedback(a.id, 'worked');
    const q = service.quality();
    expect(q.total).toBe(1);
    expect(q).toMatchObject({ worked: 1, failed: 0 });
  });
});
