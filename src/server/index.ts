import 'dotenv/config';
import { loadConfig } from '@infra/config';
import { createLogger } from '@infra/logger';
import { DashScopeLlm, DisabledLlm } from '@infra/llm/dashscope';
import { JsonlTelemetry } from '@infra/telemetry/jsonl';
import { loadPromptSet } from '@infra/prompt-store';
import { AssistService } from '@core/application/assist-service';
import { buildApp } from './app';

/**
 * 进程入口：只做装配（composition root），不含业务逻辑。
 * 依赖倒置在这里落地 —— 应用层拿到的是接口，具体实现由本文件挑选。
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const telemetry = new JsonlTelemetry(config.dataDir, logger);

  const llm = config.llm.apiKey ? new DashScopeLlm(config.llm, logger) : new DisabledLlm();
  if (!llm.available) {
    logger.warn('未配置 LLM_API_KEY，已启用纯规则引擎降级模式（演示仍可完整跑通）');
  }

  /*
   * 提示词从外部配置加载。
   *
   * 读到就用文件里的，读不到就用内置默认值；**格式错则直接启动失败**——
   * 业务人员改漏一个括号，必须当场知道，而不是悄悄用回旧提示词再困惑「怎么没效果」。
   */
  const loaded = loadPromptSet(config.promptsFile, logger);
  if (loaded.source === 'builtin') {
    logger.info({ path: config.promptsFile }, '未找到提示词配置，使用内置默认值');
  } else {
    logger.info({ version: loaded.prompts.version }, '提示词已生效');
  }

  const service = new AssistService(llm, telemetry, { now: () => Date.now() }, logger, {
    prompts: loaded.prompts,
  });
  const app = await buildApp({ config, logger, service, telemetry });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, '开始优雅退出');
    await app.close();
    await telemetry.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
  logger.info(
    { port: config.port, host: config.host, env: config.nodeEnv, model: llm.model, guardrail: config.guardrailMode },
    '随行帮办 API 已启动',
  );
}

main().catch((error) => {
  console.error('启动失败：', error);
  process.exit(1);
});
