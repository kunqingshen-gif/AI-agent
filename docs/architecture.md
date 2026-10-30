# 架构说明 · 随行帮办 AssistGuide

## 1. 系统上下文

```
┌──────────┐   语音/文字    ┌───────────────────────────┐   读屏/叠层   ┌──────────────┐
│  办事老人 │ ────────────▶ │      随行帮办 Agent        │ ◀─────────── │  目标政务 App │
└──────────┘   ◀──────────  │  意图 → 计划 → 引导 → 救援  │  ──────────▶ │  （演示端）   │
                            └────────────┬──────────────┘   高亮/指令    └──────────────┘
                                         │
                            ┌────────────┴────────────┐
                            │  大模型（DashScope）      │
                            │  仅用于理解与措辞         │
                            └─────────────────────────┘
                                         │ 失败降级
                            ┌────────────┴────────────┐
                            │  确定性流程引擎（本地）    │
                            └─────────────────────────┘
```

## 2. 分层与依赖方向

依赖只能向内：`server → application → domain`，`infra` 实现 `core/ports` 定义的接口。

| 层 | 目录 | 允许依赖 | 职责 |
| --- | --- | --- | --- |
| 领域层 | `src/core/domain` | 仅 `shared` | 任务知识库、流程决策、护栏规则、意图规则（纯函数，无 IO） |
| 应用层 | `src/core/application` | 领域 + 端口 | 编排用例、提示词、模型输出校验 |
| 端口 | `src/core/ports.ts` | 无 | `LlmPort` / `TelemetryPort` / `ClockPort` |
| 基础设施 | `src/infra` | 端口实现 | DashScope 适配、JSONL 埋点、pino 日志、环境配置 |
| 接口层 | `src/server` | 应用层 | Fastify 路由、zod 校验、限流、静态托管 |
| 表现层 | `src/web` | `shared` | 手机模拟器、Agent 控制台 |

## 3. 关键流程

### 3.1 一次意图请求（`POST /api/intent`）

```
Client ──▶ 路由(zod) ──▶ AssistService.interpret
                          │
                          ├─ 0. looksLikeQuestion() ──是──▶ answerQuestion()
                          │                                 ├─ 知识库命中 → 事实锚点
                          │                                 ├─ 模型作答（12s / 不熔断）
                          │                                 └─ sanitizeAnswer（危险祈使句拒绝）
                          │                                 └─ 返回 mode=answer + relatedTaskId
                          ├─ 1. 模型识别已收录事项 ──命中──▶ catalog flow
                          ├─ 2. 规则兜底 ──────────命中──▶ catalog flow
                          └─ 3. 都没命中 → planUnknown()
                                 │
                                 ├─ 模型按屏幕白名单排步骤（15s / 不熔断）
                                 ├─ zod 结构校验 ───失败──▶ 未收录话术 + plan.rejected
                                 ├─ 屏幕契约（屏幕/控件必须真实存在）──失败──▶ 同上
                                 ├─ 语义相关（这屏跟这件事是不是一码事）──不符──▶ 就地截断
                                 ├─ 护栏并集（推断 ∪ 模型自报，只增不减）
                                 └─ 生成 custom.* 流程 ──▶ 进入与 catalog 完全相同的引导循环
```

关键点：**规划与执行是两件事**。模型只产出「步骤草案」，`plan.ts` 决定它能不能变成可执行流程。
校验不过不是「重试到过为止」，而是直接退回「这件事我暂时答不上来」——宁可承认不会，不可指错一步。

问答通道（第 0 步）先于意图识别，是一个有意的排序：老人问「低保复核要带什么材料」时，
规则同样能命中「低保复核」，但用户要的是答案而不是流程。**回答与引导共用 `relatedTaskId` 作为转接点**：
答完之后界面给出「直接带着我办」，把同一次会话从问答切到逐屏引导，无需重述。

### 3.2 一次引导请求（`POST /api/guide`）

```
Client ──▶ 路由(zod 校验) ──▶ AssistService.guide
                                 │
                                 ├─ 1. 合并槽位、写入当前屏幕
                                 ├─ 2. 自动推进：上一节点是否已被走通
                                 ├─ 3. guide-engine.decide()  ← 确定性决策（唯一解）
                                 │       ├─ 屏幕偏离？ → back + 纠偏话术
                                 │       ├─ 命中护栏？ → human-confirm
                                 │       └─ 否则   → tap / input + 目标控件
                                 ├─ 4. 需要模型改写？
                                 │       ├─ 护栏节点      → 跳过（模板不可改）
                                 │       ├─ 命中缓存      → 直接返回
                                 │       └─ 否则调模型 → zod 校验 → 高危词过滤 → 长度裁剪
                                 │                        └─ 任一不过 → 回退模板
                                 ├─ 5. 组装动作（含 reason / confidence / latency / prefill）
                                 └─ 6. 埋点 guide.issued
Client ◀── GuideAction JSON
```

关键点：**第 3 步与第 4 步严格分离**。对已收录事项，模型只在第 4 步接触「措辞」，拿不到「决策权」；
未收录事项的决策权在 `plan.ts` 校验之后才交给模型排出的流程。两者共用同一个 `guide-engine`，
所以「谁排的路」不改变执行逻辑，只改变 `reason` 里的来源标注（`AI 规划路径｜…`）。

### 3.3 会话状态

```ts
interface SessionState {
  id, profile, intent, flow,
  completed: Set<string>,       // 已完成的流程节点
  slots: Record<SlotName,string>, // 已获得的业务参数
  screenId, startedAt, lastSeenAt,
  stepsGuided, wrongTurns, guardrailsTriggered, handoffs, finished
}
```

推进规则：
- `tap` / `human-confirm` 节点：当客户端上报的 `screenId === node.successScreen` 时标记完成；
- **点击事件**：当 `tappedControlId === node.targetControlId` 时也算完成——有些入口点下去没有下一页
  （演示库未收录、或对方 App 停在当前页），只认「屏幕变了没有」会把人卡在原地被反复要求点同一个地方；
- `input` 节点：当对应槽位非空时视为完成（不依赖点击）；
- `read` 节点：播报即完成。

该设计以**可观测的屏幕、槽位与点击事件**推断进度；点击事件只用于「我指的那个控件被点了」这一判断，
不接受客户端上报「我完成了哪一步」这类不可验证的声明。

## 4. 数据模型

### 4.1 屏幕模型（前后端共享契约）

```ts
ScreenModel = { id, app, title, semantics, blocks[], tabs[], traps[] }
ScreenBlock = search | grid | list | text | notice | form | actions | dialog | result
Control     = { id, label, role, hint?, risky? }
```

`semantics` 是给模型读的自然语言描述（例如「民政服务事项列表，共 24 项，目标位于第 18 项，不在首屏」），它让模型在不出决策的前提下，仍能生成「往下划」这类符合现场的动作描述。

## 5. 扩展点

| 需求 | 改动位置 | 是否触碰引擎 |
| --- | --- | --- |
| 新增事项 | `domain/catalog.ts` 加 `TaskFlow` + `shared/screens.ts` 加屏幕 | 否（纯数据） |
| 事项不新增、只扩充屏幕库 | 只加 `screens.ts` 的屏幕 | 否（AI 规划会自动发现新屏幕） |
| 换模型供应商 | 实现 `LlmPort`，在 `server/index.ts` 装配 | 否 |
| 接入真机无障碍 | 以 `AccessibilityService` 输出替换 `SCREENS` | 否（接口语义对齐） |
| 埋点换 ClickHouse | 实现 `TelemetryPort` | 否 |
| 会话迁 Redis | 抽出 `SessionStore` 端口 | 小幅 |

## 6. 部署

- **演示/单机**：`npm run build && npm start`，Fastify 单端口（8787）同时提供 API 与静态前端。
- **开发**：`npm run dev`，Vite（5173）代理 `/api` 至 8787，支持 HMR。
- **生产建议**：Node 进程多副本 + Redis 会话 + 网关限流；模型调用加熔断与配额。

## 7. 取舍记录

| 取舍 | 选择 | 理由 |
| --- | --- | --- |
| 决策归模型还是规则 | 已收录事项归规则，未收录事项归模型 + 契约校验 | 前者可测试、可复现；后者处理开放集合，但必须过屏幕契约与语义闸门，否则退回「不会」 |
| 屏幕数据来源 | 数据驱动而非截图 OCR | 结构化节点比像素更稳、更快、可校验；OCR 作为降级方案保留 |
| 规划的语义判断 | 二字字符重叠（启发式） | 能挡住跨事项错配，不引入额外依赖；生产应改为事项编码硬约束，已在说明书 7.4 如实说明 |
| 状态存储 | 进程内存 | 演示规模够用，零依赖；已标注替换路径 |
| 前端框架 | React + 原生 CSS | 无 UI 库依赖，包体 172KB，样式完全可控 |
| 数据库 | 不使用 | 参赛版无持久化需求，JSONL 埋点足够复盘（按天分片，保留 7 天） |

## 8. 观测

结构化日志（pino）+ 业务埋点（JSONL）双通道：

- `session.started` / `intent.parsed` / `guide.issued` / `guardrail.blocked` / `rescue.triggered` / `task.completed` / `llm.fallback` / `llm.error`
- 每条含 `sessionId` 与时间戳，可还原一次完整会话的决策链路（`Agent 决策轨迹` 面板即取自同一数据源）。

敏感字段（`slots.idCard` / `slots.phone` / `slots.name`）在日志层统一 redact。
