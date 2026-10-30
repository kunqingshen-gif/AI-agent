/**
 * 用 Chrome DevTools Protocol 驱动无头 Edge，走完整办理流程并逐屏截图。
 *
 * 用途：
 *   1. 验收：确认「说一句话 → 逐屏引导 → 护栏拦截 → 完成」在真实浏览器里跑得通；
 *   2. 出图：为产品说明书、演示视频分镜提供一致的界面素材。
 *
 * 运行：node scripts/capture.mjs [baseUrl]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:5173/';
const OUT = path.resolve('.data/shots');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9333;

mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!existsSync(EDGE)) throw new Error(`未找到 Edge：${EDGE}`);
  const child = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${path.resolve('.data/edge-cdp')}`,
      '--window-size=1440,1000',
      BASE,
    ],
    { stdio: 'ignore' },
  );

  let target = null;
  for (let i = 0; i < 40 && !target; i += 1) {
    await sleep(300);
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      target = list.find((t) => t.type === 'page' && t.url.startsWith('http'));
    } catch {
      /* 浏览器尚未就绪 */
    }
  }
  if (!target) throw new Error('无法连接到浏览器调试端口');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 2, mobile: false });
  await sleep(1500);

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return res.result?.result?.value;
  };

  const waitFor = async (expression, timeoutMs = 20000, label = 'condition') => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await evaluate(expression)) return true;
      await sleep(250);
    }
    console.log(`    ! 等待超时：${label}`);
    return false;
  };

  const waitStable = () =>
    waitFor(
      `Boolean(document.querySelector('.step-chip')) && !document.querySelector('.card-guide.is-loading')`,
      25000,
      '引导响应',
    );

  const shot = async (name) => {
    const res = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(res.result.data, 'base64'));
  };

  const clickText = async (text) => {
    const expr = `(() => {
      const nodes = [...document.querySelectorAll('button')];
      const hit = nodes.find((n) => n.textContent && n.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(text)}));
      if (!hit) return false;
      hit.click();
      return true;
    })()`;
    for (let i = 0; i < 12; i += 1) {
      if (await evaluate(expr)) return true;
      await sleep(300);
    }
    return false;
  };

  const probe = () =>
    evaluate(
      `(() => {
        const t = document.querySelector('.app-title')?.textContent ?? '-';
        const s = document.querySelector('.step-chip')?.textContent ?? '-';
        const i = document.querySelector('.instruction')?.textContent ?? '-';
        const g = document.querySelector('.guardrail-head')?.textContent ?? '';
        return [t, s, i.slice(0, 32), g].filter(Boolean).join(' | ');
      })()`,
    );

  const steps = [
    { name: '01-idle', note: '起始页：说一句话入口' },
    { name: '02-guide-home', click: '我想问一下低保那个复核', note: '意图确认 + 首页定位「民政服务」' },
    { name: '03-civil-list', click: '民政服务', note: '24 项长列表中找到「低保复核」' },
    { name: '04-intro', click: '最低生活保障对象定期复核', note: '办理须知页' },
    { name: '05-form', click: '开始办理', note: '表单第一格 + 一键预填建议' },
    { name: '06-form-prefill', click: '自动填', note: '按档案预填姓名，老人只需核对' },
    { silent: true, click: '自动填', times: 4, note: '连续预填身份证、电话、人口、收入' },
    { name: '07-face', click: '提交复核申请', note: '人脸核验：护栏拦截，AI 不代按' },
    { name: '08-risk', click: '开始核验', note: '风控弹窗：再次要求本人确认' },
    { name: '09-done', click: '确认是本人操作', note: '受理成功 + 结果播报' },
  ];

  console.log('== 正常路径 ==');
  for (const step of steps) {
    if (step.click) {
      const times = step.times ?? 1;
      for (let i = 0; i < times; i += 1) {
        const ok = await clickText(step.click);
        if (!ok) console.log(`  未找到：${step.click}`);
        await waitStable();
        await sleep(times > 1 ? 400 : 700);
      }
    }
    if (step.silent) {
      console.log(`  ${step.note}`);
      continue;
    }
    await shot(step.name);
    console.log(`  ${step.note}\n    → ${await probe()}`);
  }

  console.log('\n== 走错路径 ==');
  await send('Page.navigate', { url: BASE });
  await sleep(2200);
  await clickText('我想问一下低保那个复核');
  await waitStable();
  await sleep(600);
  await clickText('医保服务');
  await waitStable();
  await sleep(700);
  await shot('10-wrong-turn');
  console.log(`  误入医保专区，Agent 纠偏\n    → ${await probe()}`);

  ws.close();
  child.kill();
  console.log('\n截图完成，输出目录：.data/shots');
}

main().catch((error) => {
  console.error('截图失败：', error);
  process.exit(1);
});
