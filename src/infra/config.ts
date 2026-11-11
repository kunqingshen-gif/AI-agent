import { z } from 'zod';

/**
 * 配置集中校验：缺失即启动失败（fail fast），避免运行期才发现环境不对。
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8787),
  /*
   * 默认 0.0.0.0 而不是 127.0.0.1：容器/云环境里只听本机等于外部访问不到。
   * 本机开发在 .env 里显式写 HOST=127.0.0.1 把口子收回去——
   * 默认值服务于「能不能跑起来」，安全边界交给部署配置，不该反过来。
   */
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  LLM_BASE_URL: z.string().url().default('https://dashscope.aliyuncs.com/compatible-mode/v1'),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default('qwen-plus'),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(0),

  GUARDRAIL_MODE: z.enum(['strict', 'assistive']).default('strict'),
  DATA_DIR: z.string().default('./.data'),
  /** 提示词配置文件；不存在则用内置默认值，格式错则启动失败 */
  PROMPTS_FILE: z.string().default('./config/prompts.json'),
  /**
   * 长期档案有效期（天）。
   * 定这个数的理由：老人办的多是周期性事项（低保年审、养老金认证一年一次），
   * 太短等于每次都要重新问一遍，太长又会让三年前的信息冒充「了解这个人」。
   */
  PROFILE_TTL_DAYS: z.coerce.number().int().min(1).max(3650).default(180),
  /**
   * 会话快照有效期（小时）。
   * 比档案短得多：它服务的是「刚才被打断，接着办」，一天前的进度已经没有意义。
   */
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),
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
  /** 提示词配置文件路径（不存在则用内置默认值） */
  promptsFile: string;
  /** 长期档案有效期（天） */
  profileTtlDays: number;
  /** 会话快照有效期（小时） */
  sessionTtlHours: number;
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
    promptsFile: e.PROMPTS_FILE,
    profileTtlDays: e.PROFILE_TTL_DAYS,
    sessionTtlHours: e.SESSION_TTL_HOURS,
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
