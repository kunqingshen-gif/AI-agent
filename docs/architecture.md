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

### 4.2 导航契约（演示端）

`shared/screens.ts` 只描述「屏上有什么」，跳转关系在 `web/nav.ts`，分三层：

| 机制 | 作用 |
| --- | --- |
| `NAV` | 控件 id → 目标屏幕，显式声明 |
| `resolveTarget` 兜底 | 未显式声明的列表/宫格条目落到 `gov.todo` 说明页，而不是弹一句提示 |
| `TAB_OF` | 屏幕归属哪个底部标签，用于高亮 |
| 导航栈（`App.tsx`） | 返回回到真实上一步，`PARENT` 仅在栈空时兜底 |

底部导航在 `SCREENS` 导出时统一补齐（`APP_TABS`），因此**每一屏都有**——表单页、风控弹窗、结果页也不例外。
`tests/navigation.test.ts` 断言：`SCREEN_IDS` 与屏幕库一一对应、列表/宫格/按钮类控件都有去处、
标注了归属标签的屏幕确实带底部导航。新增一个点不动的入口会让测试失败。

### 4.2.1 「下一步」条：把定位成本从人身上挪到 Agent 身上

`ScreenView` 除了给目标控件套高亮环，还会在 `.app-body` 之下渲一条 `.next-bar`：

```
GuideAction.targetControlId
        │
        ├─ findLabel(screen, id) ──→ 「点「更多服务」」   （控件）
        └─ isFormField(screen, id) ─→ 「填「申请人姓名」」 （表单格）
```

它解决的不是「点不准」，是「找不到」。高亮的前提是老人能在屏幕上看完并锁定那个环，
而目标可能在滚动区下半截、可能是十二宫格里的第九个。所以把同一个目标复制成
**位置恒定的一个大按钮**：老人只需要记住「按最下面那个」，不需要记住「社保服务在第二行第三列」。

约束两条，都写进了实现：① 目标不存在时整条不渲染（纯阅读节点、弹窗页不挂空壳）；
② 它触发的是与点击目标控件**完全相同**的入口（表单格则打开填写器），
因此不存在「按钮和真实操作走两条路」的偏差。

### 4.2.2 起手页与降级路径

`web/zero.ts` 是纯函数，把 `LifeScan` 变成起手页的三张卡（`quickTasksFrom`）：
只取有 `relatedTaskId` 的条目（点了能真办起来），按紧迫度排序，最多三件。
抽成纯函数的目的是能测：`tests/zero.test.ts` 断言卡片内容来自扫描结果、
每句话都能被 `ruleIntent` 识别成不同事项、没有可办事项时返回空而不是硬凑。

降级路径（`ask-layer`）挂在 `PhoneFrame` 的 `overlay` 上，而不是浮在手机外面——
挂在屏幕内部才能被 `overflow: hidden` 的圆角裁对，也不会算出半截高度。


### 4.3 管家能力（与办事主线并列的四个领域模块）

四种能力都在 `src/core/domain/` 里，都是纯函数，都不依赖网络——这是刻意的：
它们回答的是「我这份材料够不够」「这是不是诈骗」这类**必须离线也能给出结论**的问题，
模型不可用时仍然可用（与引导链路的三级兜底保持一致）。

| 模块 | 输入 | 输出 | 关键约束 |
| --- | --- | --- | --- |
| `preflight.ts` | 事项 + 材料库 + 档案槽位 + 当前时间 | blocker / warning / pass、就绪度、一次办成率、补救路径 | 只对已录入受理要求的事项做；结论标注「以受理窗口为准」 |
| `lifecycle.ts` | 时间点清单 + 当前时间 | 按紧迫度排序的条目、最急的一件、一句话摘要 | 每条必须写「过期会怎样」；时间由调用方注入，测试可固定 |
| `scam.ts` | 一段原话 | 等级、命中特征、建议、热线、给家人的话 | 场景词（社保、医保）不计分；「已转账」切换为止损路径 |
| `collab.ts` | 会话、屏幕标题 | 6 位码、状态、家人提示 | `CollabHint` 只有 `text`，**类型上不存在「代按」** |

`tools.ts` 是这四个模块的路由：一次输入按「反诈 → 体检 → 协办 → 日历」顺序匹配，
命中就返回 `mode: 'tool'` 与对应的 `ToolPayload`，前端渲染成同一张抽屉的不同内容；
不命中就返回 `null`，请求安静地流回原有的问答与意图链路。路由用规则而非模型，
理由与护栏一致：快（老人说完就要有反应）、稳（可回归测试）、可解释（面板上写得出来为什么）。

**为什么四种能力共用一个抽屉，而不是四个页面。** 老人心里的问题是「我有个说不清的事」，
不是「这属于哪个分类」。做成四个页面，就是又一个需要先学会分类的政务 App。

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
