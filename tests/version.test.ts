import { describe, expect, it } from 'vitest';
import { VERSION } from '@shared/version';
import pkg from '../package.json';

/**
 * 版本号漂移守卫。
 * 允许这里失败、不允许线上版本号对不上——/healthz 与 /api/meta 的 version 是运维
 * 判断「跑的是哪个构建」的唯一依据，它错了比没有还糟。
 */
describe('版本号单一来源', () => {
  it('代码内常量与 package.json 一致', () => {
    expect(VERSION).toBe(pkg.version);
  });

  it('符合 semver', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });
});
