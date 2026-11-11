import { describe, expect, it } from 'vitest';
import {
  COLLAB_EXPIRED_REASON,
  COLLAB_TTL_MS,
  MAX_HINTS,
  closeCollab,
  collabRemainingMs,
  generateCollabCode,
  isCollabExpired,
  joinCollab,
  openCollab,
  pushHint,
} from '@core/domain/collab';

/**
 * 协办码的契约：
 *  1. 码要能靠嘴念清楚（没有 0/O、1/I）；
 *  2. 过期就不能接入，避免半夜有人拿旧码进来；
 *  3. 家人只能「说一句」，数据里没有「代按」这条路——护栏不因为家人在场而放宽。
 */

const NOW = Date.UTC(2026, 9, 30, 2, 0, 0);

function make() {
  return openCollab({ sessionId: 's1', screenTitle: '低保复核 · 填写信息', taskTitle: '低保复核', now: NOW });
}

describe('码本身', () => {
  it('六位，且不含念不清的字符', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateCollabCode();
      expect(code).toHaveLength(6);
      expect(code).toMatch(/^[2-9ACDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
      expect(code).not.toMatch(/[01OI]/);
    }
  });

  it('随机源固定时可复现，便于排障', () => {
    expect(generateCollabCode(() => 0)).toBe('222222');
    expect(generateCollabCode(() => 0.999)).toHaveLength(6);
  });
});

describe('接入与过期', () => {
  it('刚生成的码十分钟内有效', () => {
    const ticket = make();
    expect(isCollabExpired(ticket, NOW + 1000)).toBe(false);
    expect(isCollabExpired(ticket, NOW + COLLAB_TTL_MS + 1)).toBe(true);
  });

  it('家人接入后状态变为已接入，并记下是谁', () => {
    const joined = joinCollab(make(), '女儿', NOW + 5000);
    expect(joined.ok).toBe(true);
    if (joined.ok) {
      expect(joined.value.status).toBe('joined');
      expect(joined.value.helper).toBe('女儿');
    }
  });

  it('过期的码接不进来，并告诉用户怎么办', () => {
    const result = joinCollab(make(), '女儿', NOW + COLLAB_TTL_MS + 1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('过期');
      expect(result.reason).toContain('重新生成');
    }
  });

  it('已结束的协办不能复用', () => {
    const closed = closeCollab(make());
    const result = joinCollab(closed, '女儿', NOW + 1000);
    expect(result.ok).toBe(false);
  });

  it('剩余时间可以念给用户听，过期后归零而不是变成负数', () => {
    const ticket = make();
    expect(collabRemainingMs(ticket, NOW)).toBe(COLLAB_TTL_MS);
    expect(collabRemainingMs(ticket, NOW + COLLAB_TTL_MS - 4000)).toBe(4000);
    expect(collabRemainingMs(ticket, NOW + COLLAB_TTL_MS + 60_000)).toBe(0);
  });

  it('过期提示说清原因并指向下一步，不是一句「失败」', () => {
    const result = joinCollab(make(), '女儿', NOW + COLLAB_TTL_MS + 1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(COLLAB_EXPIRED_REASON);
      expect(result.reason).toContain('重新生成');
    }
  });
});

describe('家人的提示', () => {
  it('没人接入时发不出提示', () => {
    const result = pushHint(make(), '点右上角的返回', NOW + 1000);
    expect(result.ok).toBe(false);
  });

  it('接入后可以发，且带着是谁说的', () => {
    const joined = joinCollab(make(), '女儿', NOW + 1000);
    if (!joined.ok) throw new Error('应当接入成功');
    const hinted = pushHint(joined.value, '点右上角的返回', NOW + 2000);
    expect(hinted.ok).toBe(true);
    if (hinted.ok) {
      expect(hinted.value.hints).toHaveLength(1);
      expect(hinted.value.hints[0]?.from).toBe('女儿');
      expect(hinted.value.hints[0]?.text).toBe('点右上角的返回');
    }
  });

  it('提示有上限，太多老人会乱', () => {
    const ticket = joinCollab(make(), '女儿', NOW + 1000);
    if (!ticket.ok) throw new Error('应当接入成功');
    let current = ticket.value;
    for (let i = 0; i < MAX_HINTS; i += 1) {
      const next = pushHint(current, `第 ${i} 句提示`, NOW + 2000 + i);
      if (!next.ok) throw new Error('未到上限应当成功');
      current = next.value;
    }
    const overflow = pushHint(current, '再来一句', NOW + 9000);
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.reason).toContain('最多');
  });

  it('太长或空白的提示会被拒绝', () => {
    const joined = joinCollab(make(), '女儿', NOW + 1000);
    if (!joined.ok) throw new Error('应当接入成功');
    expect(pushHint(joined.value, '   ', NOW + 2000).ok).toBe(false);
    expect(pushHint(joined.value, '这'.repeat(41), NOW + 2000).ok).toBe(false);
  });

  it('重复的同一句不会刷屏', () => {
    const joined = joinCollab(make(), '女儿', NOW + 1000);
    if (!joined.ok) throw new Error('应当接入成功');
    const once = pushHint(joined.value, '别急，慢慢来', NOW + 2000);
    if (!once.ok) throw new Error('应当成功');
    const twice = pushHint(once.value, '别急，慢慢来', NOW + 3000);
    expect(twice.ok).toBe(true);
    if (twice.ok) expect(twice.value.hints).toHaveLength(1);
  });

  it('接入后过期，家人也发不出提示——时效不能只在接入那一刻生效', () => {
    const joined = joinCollab(make(), '女儿', NOW + 1000);
    if (!joined.ok) throw new Error('应当接入成功');
    const late = pushHint(joined.value, '点右上角的返回', NOW + COLLAB_TTL_MS + 1);
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.reason).toBe(COLLAB_EXPIRED_REASON);
  });

  it('提示里没有可执行字段——家人无法代按', () => {
    const joined = joinCollab(make(), '女儿', NOW + 1000);
    if (!joined.ok) throw new Error('应当接入成功');
    const hinted = pushHint(joined.value, '点提交', NOW + 2000);
    if (!hinted.ok) throw new Error('应当成功');
    const hint = hinted.value.hints[0];
    expect(hint).toBeDefined();
    expect(Object.keys(hint ?? {})).toEqual(['at', 'from', 'text']);
    expect(hint?.text).toBe('点提交'); // 只是「说」，不是「做」
  });
});
