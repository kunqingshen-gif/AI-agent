import { z } from 'zod';

/**
 * 配置集中校验：缺失即启动失败（fail fast），避免运行期才发现环境不对。
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default('127.0.0.1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  LLM_BASE_URL: z.string().url().default('https://dashscope.aliyuncs.com/compatible-mode/v1'),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default('qwen-plus'),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(0),

  GUARDRAIL_MODE: z.enum(['strict', 'assistive']).default('strict'),
  DATA_DIR: z.string().default('./.data'),
});

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  host: string;
  logLevel: string;
  llm: {
    baseUrl: string;
    apiKey?: string;
    model: string;
    timeoutMs: number;
    maxRetries: number;
  };
  guardrailMode: 'strict' | 'assistive';
  dataDir: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`配置校验失败 → ${detail}`);
  }
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    llm: {
      baseUrl: e.LLM_BASE_URL,
      ...(e.LLM_API_KEY ? { apiKey: e.LLM_API_KEY } : {}),
      model: e.LLM_MODEL,
      timeoutMs: e.LLM_TIMEOUT_MS,
      maxRetries: e.LLM_MAX_RETRIES,
    },
    guardrailMode: e.GUARDRAIL_MODE,
    dataDir: e.DATA_DIR,
  };
}

export function defaultProfile(): {
  displayName: string;
  age: number;
  region: string;
  digitalLiteracy: 'low';
  livingAlone: boolean;
  dialect: '普通话';
} {
  return {
    displayName: '王秀兰',
    age: 68,
    region: '福建省福州市鼓楼区',
    digitalLiteracy: 'low',
    livingAlone: true,
    dialect: '普通话',
  };
}
