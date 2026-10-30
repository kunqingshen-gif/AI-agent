import { describe, expect, it } from 'vitest';
import { daysUntil, preflightCheck } from '@core/domain/preflight';
import { MATERIAL_LIBRARY } from '@shared/household';
import type { MaterialRecord } from '@shared/household';

/**
 * 办前体检的契约：
 *  1. 会退回的原因必须判成 blocker，措辞要说清「为什么」和「去哪儿办」；
 *  2. 「现在有效但办到一半会过期」必须判成 warning——这是用户自己想不到的一类；
 *  3. 材料齐了不能瞎报风险（误报会让老人白跑一趟，比不报更坏）；
 *  4. 没收录要求的事项不做体检，宁可不说，也不编要求。
 */

const NOW = new Date('2026-10-30T09:00:00+08:00');

function withMaterials(patch: Array<Partial<MaterialRecord> & { id: string }>): MaterialRecord[] {
  return MATERIAL_LIBRARY.map((material) => {
    const change = patch.find((p) => p.id === material.id);
    return change ? { ...material, ...change } : material;
  });
}

describe('日期换算', () => {
  it('按自然日算，不按小时', () => {
    expect(daysUntil('2026-10-30', NOW)).toBe(0);
    expect(daysUntil('2026-10-31', NOW)).toBe(1);
    expect(daysUntil('2026-11-20', NOW)).toBe(21);
    expect(daysUntil('2026-10-29', NOW)).toBe(-1);
  });
});

describe('低保复核体检', () => {
  const result = preflightCheck({ taskId: 'allowance.renew', now: NOW });

  it('默认档案会被退回，且指出是哪一份', () => {
    expect(result).not.toBeNull();
    expect(result?.verdict).toBe('blocked');
    expect(result?.blockers).toHaveLength(1);
    expect(result?.blockers[0]?.name).toBe('家庭收入证明');
    expect(result?.summary).toContain('家庭收入证明');
    expect(result?.summary).toContain('退回');
  });

  it('低保证明 21 天后到期，判为「办到一半会失效」而不是直接退回', () => {
    expect(result?.warnings).toHaveLength(1);
    const warning = result?.warnings[0];
    expect(warning?.name).toBe('最低生活保障证明');
    expect(warning?.level).toBe('warning');
    expect(warning?.daysLeft).toBe(21);
    expect(warning?.detail).toContain('45 天');
  });

  it('每条风险都给出可执行的补救路径，而不是只报错', () => {
    const labels = result?.fixes.map((fix) => fix.label) ?? [];
    expect(labels.some((label) => label.includes('家庭收入证明'))).toBe(true);
    expect(labels.some((label) => label.includes('续期'))).toBe(true);
    const obtain = result?.fixes.find((fix) => fix.kind === 'obtain');
    expect(obtain?.where).toContain('社区');
    expect(obtain?.script).toContain('家庭收入证明');
  });

  it('结论里写明这是预判，不冒充审批结果', () => {
    expect(result?.basis).toContain('以受理窗口为准');
  });
});

describe('不误报', () => {
  it('材料补齐、有效期足够长时判为可以一次办成', () => {
    const materials = withMaterials([
      { id: 'income', status: 'uploaded' },
      { id: 'dibao', expiresAt: '2027-06-30' },
    ]);
    const result = preflightCheck({ taskId: 'allowance.renew', materials, now: NOW });
    expect(result?.verdict).toBe('ready');
    expect(result?.blockers).toHaveLength(0);
    expect(result?.warnings).toHaveLength(0);
    expect(result?.score).toBe(100);
    expect(result?.onePassRate).toBeGreaterThanOrEqual(90);
    expect(result?.summary).toContain('一次办成');
  });

  it('材料已过期，判为 blocker 并给出去换新的路径', () => {
    const materials = withMaterials([{ id: 'income', status: 'uploaded' }, { id: 'dibao', expiresAt: '2026-10-01' }]);
    const result = preflightCheck({ taskId: 'allowance.renew', materials, now: NOW });
    expect(result?.verdict).toBe('blocked');
    expect(result?.blockers.some((item) => item.name === '最低生活保障证明')).toBe(true);
    expect(result?.fixes.some((fix) => fix.kind === 'renew')).toBe(true);
  });

  it('救助金打到家人卡上会被退回——这类问题老人几乎不会自己发现', () => {
    const materials = withMaterials([
      { id: 'income', status: 'uploaded' },
      { id: 'dibao', expiresAt: '2027-06-30' },
      { id: 'bank', owner: 'family' },
    ]);
    const result = preflightCheck({ taskId: 'allowance.renew', materials, now: NOW });
    expect(result?.verdict).toBe('blocked');
    expect(result?.blockers[0]?.name).toContain('社会保障卡');
    expect(result?.fixes.some((fix) => fix.kind === 'owner')).toBe(true);
  });

  it('档案里缺的槽位算「要确认一句」，不算材料不齐', () => {
    const materials = withMaterials([
      { id: 'income', status: 'uploaded' },
      { id: 'dibao', expiresAt: '2027-06-30' },
    ]);
    const result = preflightCheck({ taskId: 'medical.filing', materials, now: NOW, slots: {} });
    /* 就医城市、医院在档案里没有，但这不是「材料缺」 */
    expect(result?.blockers).toHaveLength(0);
    expect(result?.warnings.map((w) => w.name)).toContain('就医城市');
    expect(result?.verdict).toBe('at-risk');
  });

  it('没收录受理要求的事项不做体检', () => {
    expect(preflightCheck({ taskId: 'not.in.catalog' as never, now: NOW })).toBeNull();
  });
});
