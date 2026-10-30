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

### 3.1 一次引导请求（`POST /api/guide`）

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

关键点：**第 3 步与第 4 步严格分离**。模型只在第 4 步接触「措辞」，它拿不到「决策权」。这使系统同时具备两种性质：模型越强，话术越自然；模型越差，系统越接近确定性程序。

### 3.2 会话状态

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
- `input` 节点：当对应槽位非空时视为完成（不依赖点击）；
- `read` 节点：播报即完成。

该设计使服务端无需信任客户端上报的「我点了什么」，只依据**可观测的屏幕与槽位**推断进度。

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
| 决策归模型还是规则 | 规则 | 可测试、可复现、不跑偏；模型负责长尾措辞 |
| 屏幕数据来源 | 数据驱动而非截图 OCR | 结构化节点比像素更稳、更快、可校验；OCR 作为降级方案保留 |
| 状态存储 | 进程内存 | 演示规模够用，零依赖；已标注替换路径 |
| 前端框架 | React + 原生 CSS | 无 UI 库依赖，包体 171KB，样式完全可控 |
| 数据库 | 不使用 | 参赛版无持久化需求，JSONL 埋点足够复盘 |

## 8. 观测

结构化日志（pino）+ 业务埋点（JSONL）双通道：

- `session.started` / `intent.parsed` / `guide.issued` / `guardrail.blocked` / `rescue.triggered` / `task.completed` / `llm.fallback` / `llm.error`
- 每条含 `sessionId` 与时间戳，可还原一次完整会话的决策链路（`Agent 决策轨迹` 面板即取自同一数据源）。

敏感字段（`slots.idCard` / `slots.phone` / `slots.name`）在日志层统一 redact。
