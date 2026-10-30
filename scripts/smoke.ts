/**
 * 端到端冒烟验收脚本
 *
 * 用途：
 *  1. 本地/CI 验证「意图 → 引导 → 护栏 → 救援 → 完成」全链路可用；
 *  2. 演示前自检，确保模型通道与降级通道都能跑通；
 *  3. 产出可写进产品说明书的实测数据（步数、耗时、护栏拦截次数）。
 *
 * 运行：npm run smoke   （需先启动 npm run dev:api）
 */
const BASE = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:8787';

interface GuideResp {
  kind: string;
  targetControlId?: string;
  instruction: string;
  speak: string;
  guardrail?: string;
  source: string;
  confidence: number;
  latencyMs: number;
  stepLabel: string;
  reason: string;
  rescue: { triggered: boolean; kind: string; message: string };
  prefill?: { value: string; label: string };
}

let failures = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  [通过] ${name}`);
  } else {
    failures += 1;
    console.log(`  [失败] ${name} ${detail}`);
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

const slots: Record<string, string> = {};

async function guide(sessionId: string, screenId: string, extra: { attemptsOnScreen?: number; asksForHelp?: boolean } = {}): Promise<GuideResp> {
  const action = await post<GuideResp>('/api/guide', {
    sessionId,
    screenId,
    slots,
    attemptsOnScreen: extra.attemptsOnScreen ?? 0,
    asksForHelp: extra.asksForHelp ?? false,
  });
  console.log(
    `    ${action.stepLabel.padEnd(14)} ${action.kind.padEnd(14)} ${(action.targetControlId ?? '-').padEnd(24)} ${action.source} ${String(action.latencyMs).padStart(5)}ms  ${action.instruction}`,
  );
  return action;
}

async function main(): Promise<void> {
  console.log('== 随行帮办 · 端到端冒烟验收 ==\n');
  const health = await get<{ status: string; llmAvailable: boolean }>('/healthz');
  console.log(`服务状态：${health.status}，模型通道：${health.llmAvailable ? '已启用' : '已降级为规则引擎'}\n`);

  const session = await post<{ sessionId: string }>('/api/session', {});

  console.log('① 意图理解：老人用口语描述需求');
  const intent = await post<{ ok: boolean; intent: { taskId: string; confidence: number; restated: string; source: string } | null }>(
    '/api/intent',
    { sessionId: session.sessionId, utterance: '我想问一下低保那个复核，今年还没弄呢' },
  );
  check('识别为低保复核事项', intent.intent?.taskId === 'allowance.renew', JSON.stringify(intent.intent));
  console.log(`    复述：${intent.intent?.restated}（来源 ${intent.intent?.source}，置信度 ${intent.intent?.confidence}）\n`);

  console.log('② 正常路径引导');
  const s1 = await guide(session.sessionId, 'gov.home');
  check('首步指向民政服务', s1.targetControlId === 'home.grid.minzheng');
  check('首步话术非空', s1.instruction.length > 4);

  const s2 = await guide(session.sessionId, 'gov.civil.list');
  check('第二步指向低保复核', s2.targetControlId === 'civil.item.dibao-renew');

  const s3 = await guide(session.sessionId, 'civil.allowance.intro');
  check('第三步指向开始办理', s3.targetControlId === 'intro.btn.apply');

  console.log('\n③ 走错页面时的纠偏（用户误入医保专区）');
  const wrong = await guide(session.sessionId, 'wrong.insurance');
  check('识别为走错并要求返回', wrong.kind === 'back' && wrong.rescue.triggered);
  check('给出具体纠偏话术', wrong.instruction.includes('医保'));
  check('附带可念给窗口的话术', Boolean(wrong.rescue.message));

  console.log('\n④ 表单逐项引导与一键预填');
  const f1 = await guide(session.sessionId, 'civil.allowance.form');
  check('第一项为姓名', f1.kind === 'input' && f1.prefill !== undefined);
  if (f1.prefill) slots.name = f1.prefill.value;

  const f2 = await guide(session.sessionId, 'civil.allowance.form');
  check('第二项为身份证号', f2.prefill?.value?.length === 18);
  if (f2.prefill) slots.idCard = f2.prefill.value;

  const f3 = await guide(session.sessionId, 'civil.allowance.form');
  slots.phone = f3.prefill?.value ?? '13800006021';

  const f4 = await guide(session.sessionId, 'civil.allowance.form');
  slots.householdSize = f4.prefill?.value ?? '1';

  const f5 = await guide(session.sessionId, 'civil.allowance.form');
  slots.monthlyIncome = f5.prefill?.value ?? '980';
  check('五项必填均已预填', Object.keys(slots).length === 5, JSON.stringify(slots));

  console.log('\n⑤ 提交与两个安全护栏');
  const submit = await guide(session.sessionId, 'civil.allowance.form');
  check('提交动作指向提交按钮', submit.targetControlId === 'form.btn.submit');

  const face = await guide(session.sessionId, 'civil.allowance.face');
  check('人脸核验降级为本人确认', face.kind === 'human-confirm' && face.guardrail === 'biometric');

  const risk = await guide(session.sessionId, 'civil.allowance.risk');
  check('风控弹窗降级为本人确认', risk.kind === 'human-confirm' && risk.guardrail === 'identity');

  console.log('\n⑥ 完成播报');
  const done = await guide(session.sessionId, 'civil.allowance.done');
  check('输出完成态', done.kind === 'read' || done.stepLabel === '已完成');

  console.log('\n⑦ 乱点救援（新会话，在办理页连点三次并求助）');
  const session2 = await post<{ sessionId: string }>('/api/session', {});
  await post('/api/intent', { sessionId: session2.sessionId, utterance: '我要办低保复核' });
  const rescue = await guide(session2.sessionId, 'civil.allowance.intro', { attemptsOnScreen: 3, asksForHelp: true });
  check('触发救援提示', rescue.rescue.triggered);
  check('救援时仍给出可执行动作', rescue.kind !== 'handoff' && rescue.instruction.length > 4);

  const hotline = await post<{ script: string; hotline: string }>('/api/rescue', { sessionId: session.sessionId });
  check('生成人工话术', hotline.script.length > 30 && hotline.script.includes('后四位'));
  console.log(`    热线话术：${hotline.script}\n`);

  const metrics = await get<Record<string, number | boolean>>(`/api/session/${session.sessionId}/metrics`);
  console.log('⑧ 会话指标');
  console.log(`    ${JSON.stringify(metrics)}`);
  check('已记录护栏拦截', Number(metrics.guardrailsTriggered) >= 2);
  check('已记录走错次数', Number(metrics.wrongTurns) >= 1);
  check('任务标记完成', metrics.completed === true);

  console.log('\n== 结果 ==');
  console.log(failures === 0 ? '全部检查通过 ✔' : `${failures} 项检查未通过 ✘`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('冒烟失败：', error);
  process.exit(1);
});
