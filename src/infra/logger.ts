import pino from 'pino';

/**
 * 结构化日志。所有对外字段在写入前脱敏（身份证、手机号、姓名），
 * 满足个人信息保护要求，也让日志可以直接投喂给课程答辩/评委演示。
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'slots.idCard',
  'slots.phone',
  'slots.name',
  'intent.slots.idCard',
  'intent.slots.phone',
  'intent.slots.name',
];

export function createLogger(level: string) {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: '[已脱敏]' },
    base: { service: 'xingsui-banban' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = ReturnType<typeof createLogger>;

/** 手机号/身份证掩码，用于返回给前端展示 */
export function maskPhone(phone: string): string {
  return phone.length >= 7 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : '***';
}

export function maskIdCard(id: string): string {
  return id.length >= 8 ? `${id.slice(0, 4)}**********${id.slice(-4)}` : '***';
}

export function maskName(name: string): string {
  return name.length <= 1 ? '*' : `${name[0]}${'*'.repeat(name.length - 1)}`;
}
