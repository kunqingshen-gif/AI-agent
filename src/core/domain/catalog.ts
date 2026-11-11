import { z } from 'zod';
import type { FlowId, GuardrailKind, ScreenId, SlotName, TaskId, TaskSpecSummary } from '@shared/types';
import { TASK_IDS } from '@shared/types';
import catalogJson from './task-catalog.json';

/**
 * 任务知识库（Task Catalog）
 *
 * 每个事项由「业务事实」+「确定性流程图」构成：
 *  - 业务事实：受理条件、材料、时限、常见坑，供 LLM 生成话术时引用（RAG-lite）
 *  - 流程图：有序节点，每个节点声明「在哪个屏幕、让用户动哪个控件、动了之后到哪」，
 *    这是规则引擎的确定性路径，也是 LLM 输出必须通过的白名单
 *
 * ## 数据在 JSON 里，代码里只剩校验
 *
 * 事项与材料清单是「业务内容」，不是程序逻辑；写进 TS 会让每次改材料都像改代码。
 * 现在它们住在 `task-catalog.json`：改材料、改话术、加一个事项，只动数据。
 * 但数据必须能被信任，所以载入时用 zod 硬校验——少一个字段、把 kind 拼错，
 * 启动即失败，而不是等老人走到那一步才发现「下一步」指了个不存在的地方。
 *
 * 取舍：JSON 随构建打进产物，所以「改数据」仍要重新 `npm run build`，
 * 但不碰类型、不碰流程代码，也不再需要理解 TS。真正热更新要配版本与灰度，留给下一轮。
 */

export type NodeKind = 'tap' | 'input' | 'human-confirm' | 'read';

export interface FlowNode {
  id: string;
  screenId: ScreenId;
  /** 目标控件；input 类节点由 slot 反查表单控件，可为空 */
  targetControlId?: string;
  kind: NodeKind;
  /** 给模型理解这个节点要干什么（不直接展示给用户） */
  intent: string;
  /** 规则引擎兜底话术 */
  instruction: string;
  speak: string;
  /** 完成本节点后应到达的屏幕 */
  successScreen: ScreenId;
  guardrail?: GuardrailKind;
  /** 依赖的槽位：若未就绪则本节点暂不执行 */
  slot?: SlotName;
}

export interface TaskFlow {
  /** 已收录事项为 TaskId；AI 现场规划的临时事项为 custom.xxx */
  taskId: FlowId;
  title: string;
  category: string;
  /** 触发词，用于规则层意图识别与展示 */
  hotkey: string;
  /** 受理条件与材料，供话术引用 */
  facts: string[];
  requiredDocs: string[];
  deadline?: string;
  baselineSteps: number;
  baselineMs: number;
  pitfalls: string[];
  entryScreen: ScreenId;
  terminalScreen: ScreenId;
  /** 该事项的「看起来像但走错」页面，用于纠偏话术 */
  trapScreens: ScreenId[];
  nodes: FlowNode[];
}

/**
 * 数据文件的结构约束。
 *
 * 这里不校验 screenId / targetControlId 是否真实存在——那要读 SCREENS，
 * 而屏幕契约另有 `tests/catalog.test.ts` 逐条比对；本层只保证「结构完整、
 * 枚举合法、话术不空」，两类校验各管一段，失败信息才指得准。
 */
const NodeSchema = z.object({
  id: z.string().min(1),
  screenId: z.string().min(1),
  targetControlId: z.string().min(1).optional(),
  kind: z.enum(['tap', 'input', 'human-confirm', 'read']),
  intent: z.string().min(1),
  instruction: z.string().min(1),
  speak: z.string().min(1),
  successScreen: z.string().min(1),
  guardrail: z.enum(['payment', 'identity', 'biometric', 'captcha', 'legal-consent', 'sensitive-info']).optional(),
  slot: z.string().min(1).optional(),
});

const FlowSchema = z.object({
  taskId: z.enum(['allowance.renew', 'pension.qualify', 'medical.filing', 'utility.pay']),
  title: z.string().min(1),
  category: z.string().min(1),
  hotkey: z.string().min(1),
  facts: z.array(z.string().min(1)).min(1),
  requiredDocs: z.array(z.string().min(1)).min(1),
  deadline: z.string().min(1).optional(),
  baselineSteps: z.number().int().positive(),
  baselineMs: z.number().int().positive(),
  pitfalls: z.array(z.string().min(1)),
  entryScreen: z.string().min(1),
  terminalScreen: z.string().min(1),
  trapScreens: z.array(z.string().min(1)),
  nodes: z.array(NodeSchema).min(1),
});

const CatalogSchema = z.object({
  version: z.string().min(1),
  flows: z.array(FlowSchema).min(1),
});

function loadCatalog(): { version: string; flows: TaskFlow[] } {
  const parsed = CatalogSchema.safeParse(catalogJson);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    /* 数据坏了就别启动：宁可部署期失败，也不要让老人走到一半发现路是断的 */
    throw new Error(
      `事项库数据格式不对：src/core/domain/task-catalog.json｜${first?.path.join('.')}：${first?.message}`,
    );
  }
  /* 四件事必须一件不少：少一条会在运行时退化成 undefined，而不是启动失败 */
  const missing = TASK_IDS.filter((id) => !parsed.data.flows.some((flow) => flow.taskId === id));
  if (missing.length > 0) {
    throw new Error(`事项库缺少事项：${missing.join('、')}（src/core/domain/task-catalog.json）`);
  }
  return {
    version: parsed.data.version,
    /* zod 只保证结构；屏幕 id 的联合类型由契约测试兜底，此处收窄 */
    flows: parsed.data.flows as unknown as TaskFlow[],
  };
}

const catalog = loadCatalog();

/** 当前事项库版本，便于把「这句话说错了」归因到某一版数据 */
export const CATALOG_VERSION = catalog.version;

export const TASK_FLOWS: Record<TaskId, TaskFlow> = catalog.flows.reduce<Record<TaskId, TaskFlow>>(
  (acc, flow) => {
    acc[flow.taskId as TaskId] = flow;
    return acc;
  },
  {} as Record<TaskId, TaskFlow>,
);

export const TASK_LIST: TaskSpecSummary[] = Object.values(TASK_FLOWS).map((flow): TaskSpecSummary => ({
  taskId: flow.taskId as TaskId,
  title: flow.title,
  category: flow.category,
  hotkey: flow.hotkey,
  requiredDocs: flow.requiredDocs,
  baselineSteps: flow.baselineSteps,
  baselineMs: flow.baselineMs,
  pitfalls: flow.pitfalls,
}));

/** 敏感词：出现这些词时，无论模型说什么都必须走人工 */
export const HIGH_RISK_TERMS = ['转账', '汇款', '点击链接', '银行卡密码', '短信验证码', '安全账户'];
