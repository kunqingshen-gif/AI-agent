/**
 * 验证「办成了吗」真的出现在结果页，并且点了会变。
 *
 * 走到结果页需要连按「下一步」若干次，中途可能遇到人工确认节点，
 * 这里一并处理：能点的确认就点，只为把流程走到底，不测护栏本身
 * （护栏由 probe-guardian 专门测）。
 *
 * 运行：node scripts/shot-feedback.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9487;
const OUT = path.resolve('.data/feedback');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!existsSync(EDGE)) throw new Error('未找到 Edge');
  const child = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${path.resolve('.data/edge-feedback')}`,
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
      /* wait */
    }
  }
  if (!target) throw new Error('调试端口未就绪');

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
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
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
  await sleep(2200);

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return res.result?.result?.value;
  };
  const shot = async (name) => {
    const res = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(res.result.data, 'base64'));
    console.log(`  · ${name}.png`);
  };
  const clickText = async (text, scope) => {
    const info = await evaluate(`(() => {
      const b = [...document.querySelectorAll(${JSON.stringify(scope)})]
        .find((n) => n.textContent.trim().replace(/\\s+/g, ' ').includes(${JSON.stringify(text)}));
      if (!b) return null;
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return { x: Math.round(cx), y: Math.round(cy), ok: Boolean(hit && (hit === b || b.contains(hit))) };
    })()`);
    if (!info) return false;
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {
        type,
        x: info.x,
        y: info.y,
        button: 'left',
        clickCount: type === 'mouseMoved' ? 0 : 1,
      });
    }
    return info.ok;
  };

  /* ① 起手页点一件事；模型通道比规则慢，等到引导真的起来为止 */
  await clickText('本月水费', '.welcome-task');
  const begun = await (async () => {
    for (let i = 0; i < 40; i += 1) {
      await sleep(500);
      const ready = await evaluate(`Boolean(document.querySelector('.next-btn'))`);
      if (ready) return true;
    }
    return false;
  })();
  console.log(`  进入引导：${begun ? '是' : '否'}`);
  if (!begun) {
    await shot('50-stuck');
    ws.close();
    child.kill();
    console.log('\n✗ 点击后没有进入引导，无法验证结果页');
    process.exit(1);
  }

  /* ② 连按「下一步」直到结果页出现反馈条，最多 14 次 */
  let reached = false;
  for (let i = 0; i < 14; i += 1) {
    const hasFb = await evaluate(`Boolean(document.querySelector('.fb'))`);
    if (hasFb) {
      reached = true;
      break;
    }
    /* 遇到人工确认弹窗：点掉它，只为把流程走到底 */
    const dialogBtn = await evaluate(`(() => {
      const d = document.querySelector('.dialog');
      if (!d) return null;
      const b = [...d.querySelectorAll('button')].find((n) => !/取消|返回/.test(n.textContent));
      return b ? b.textContent.trim() : null;
    })()`);
    if (dialogBtn) {
      await clickText(dialogBtn, '.dialog button');
      await sleep(1200);
      continue;
    }
    /*
     * 换屏后指引要等模型通道返回才重绘，这期间「下一步」按钮是不存在的。
     * 早前这里点空就退出，把「还没回来」误判成「没有」——
     * 必须先等按钮出现，不能拿固定 sleep 赌时序。
     */
    let appeared = false;
    for (let w = 0; w < 20; w += 1) {
      appeared = await evaluate(`Boolean(document.querySelector('.next-btn'))`);
      if (appeared) break;
      await sleep(400);
    }
    if (!appeared) break;
    const ok = await clickText('下一步', '.next-btn');
    if (!ok) break;
    await sleep(900);
  }
  console.log(`  到结果页：${reached ? '是' : '否'}`);
  await shot('50-result-with-feedback');

  /* ③ 点「办成了」，界面应就地变成一句话 */
  const before = await evaluate(`document.querySelector('.fb-q')?.textContent ?? null`);
  await clickText('办成了', '.fb button');
  await sleep(700);
  const after = await evaluate(`document.querySelector('.fb-done')?.textContent ?? null`);
  console.log(`  问句：${before ?? '(无)'}`);
  console.log(`  点完：${after ?? '(未变化)'}`);
  await shot('51-after-feedback');

  const ok = reached && Boolean(after);
  ws.close();
  child.kill();
  console.log(ok ? '\n✓ 反馈条出现在结果页且点击生效' : '\n✗ 未验证通过');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
