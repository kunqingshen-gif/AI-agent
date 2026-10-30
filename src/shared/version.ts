/**
 * 版本号的唯一来源。
 *
 * 之前 0.9.0 硬编码在 app.ts 的两处（/healthz 与 /api/meta）+ package.json，
 * 三处靠人记着同步，改一处忘两处是迟早的事。现在代码里只认这一个常量，
 * 并由 tests/version.test.ts 断言它与 package.json 一致 —— 漂移会在 CI 里当场失败。
 */
export const VERSION = '0.9.2';
