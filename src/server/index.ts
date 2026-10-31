import 'dotenv/config';
import dns from 'node:dns';
import path from 'node:path';
import { loadConfig } from '@infra/config';
import { createLogger } from '@infra/logger';
import type { Logger } from '@infra/logger';
import { DashScopeLlm, DisabledLlm } from '@infra/llm/dashscope';
import { JsonlTelemetry } from '@infra/telemetry/jsonl';
import { loadPromptSet } from '@infra/prompt-store';
import { JsonProfileStore } from '@infra/profile-store';
import type { LlmPort } from '@core/ports';
import { AssistService } from '@core/application/assist-service';
import { buildApp } from './app';

/*
 * 必须在任何 fetch 之前执行。
 *
 * 实测症状：本机 Node 22 默认 verbatim（IPv6 优先），到模型服务的 IPv6 通路不通，
 * 首个出网连接会卡满 undici 的 10 秒连接超时（UND_ERR_CONNECT_TIMEOUT）后失败，
 * 紧接着的第二次只要 400ms。表现就是「刚启动的第一句话必然卡十秒然后失败」。
 *
 * 诚实说明：强制 IPv4 优先后多数情况首次即成功，但并非每次都灵——
 * 真正兜住它的是下面两件事：网络层失败自动多试一次 + 启动预热。
 * 这一行留着，是因为 IPv6 优先在这里从来没有好处，只有代价。
 */
dns.setDefaultResultOrder('ipv4first');

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

  /*
   * 长期档案：跨会话记住「怎么称呼、多大年纪、话该密还是该疏」。
   *
   * 它和提示词、埋点放在同一层（基础设施），因为换存储介质时只换这一行。
   */
  const profiles = new JsonProfileStore(
    path.join(config.dataDir, 'profiles.json'),
    config.profileTtlDays,
    logger,
  );

  const service = new AssistService(llm, telemetry, { now: () => Date.now() }, logger, {
    prompts: loaded.prompts,
    profiles,
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

  /*
   * 启动预热：用一次极小的真实调用，把 DNS、TLS、连接池提前跑通。
   *
   * 不预热的代价是它落在评委面前的第一句话上——老人说完「我想办高龄津贴」，
   * 屏幕先卡十秒。预热失败只记日志、不拦启动：它是为了第一次快，不是为了拦住服务。
   */
  if (llm.available) void warmup(llm, logger);
}

async function warmup(llm: LlmPort, logger: Logger): Promise<void> {
  const startedAt = Date.now();
  try {
    await llm.complete(
      { system: '你是连通性探针，只回复 OK。', user: 'OK', maxTokens: 4, bestEffort: true },
      'warmup',
    );
    logger.info({ latencyMs: Date.now() - startedAt }, '模型通道预热完成');
  } catch (error) {
    logger.warn({ err: String(error) }, '模型通道预热失败，首次引导可能偏慢');
  }
}

main().catch((error) => {
  console.error('启动失败：', error);
  process.exit(1);
});
