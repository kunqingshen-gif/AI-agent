/**
 * 截「Agent 视线」两张图：
 *   01-idle 未开始态：屏幕底部待命条（已读完这一屏 · N 个入口）
 *   02-aim  已开始态：右边缘蓝色三角指向当前目标
 *
 * 只用真实点击（CDP 鼠标坐标），不调 element.click()——那样会绕过遮挡，
 * 截出来的图看着对、实际点不到，是最容易骗自己的地方。
 *
 * 运行：node scripts/shot-sight.mjs [baseUrl]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9483;
const OUT = path.resolve('.data/sight');
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
      `--user-data-dir=${path.resolve('.data/edge-sight')}`,
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
  const clickByText = async (text, scope = 'button') => {
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
    if (!info) {
      console.log(`  ✗ 找不到「${text}」`);
      return false;
    }
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

  /* ① 未开始态 */
  const idle = await evaluate(`({
    track: document.querySelector('.sight-track-text')?.textContent ?? null,
    marker: document.querySelectorAll('.sight-marker').length,
    title: document.querySelector('.app-title')?.textContent ?? null,
  })`);
  console.log('未开始态：', JSON.stringify(idle));
  await shot('01-idle');

  /* ② 点一件常办的事，看视线是否落到具体控件 */
  const started = await clickByText('本月水费', '.welcome-task');
  console.log('  点卡片：', started ? '成功' : '失败');
  /* 模型通道比规则慢，固定 sleep 会把「还没回来」误判成「没有」——这里等到高亮出现为止 */
  let appeared = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    appeared = await evaluate(`Boolean(document.querySelector('.target-wrap.active'))`);
    if (appeared) break;
  }
  console.log('  高亮出现：', appeared);
  await sleep(700);
  const aimed = await evaluate(`(() => {
    const m = document.querySelector('.sight-marker');
    const t = document.querySelector('.sight-tag');
    const hl = document.querySelector('.target-wrap.active');
    const cid = hl?.getAttribute('data-cid') ?? null;
    const r = hl?.getBoundingClientRect();
    const mm = m?.getBoundingClientRect();
    return {
      marker: Boolean(m),
      tag: t?.textContent ?? null,
      cid,
      /* 三角的高度和被高亮控件的垂直中心是否对得上（误差 3px 内算对） */
      align: r && mm ? Math.round(Math.abs(mm.y + mm.height / 2 - (r.y + r.height / 2))) : null,
      title: document.querySelector('.app-title')?.textContent ?? null,
      next: document.querySelector('.next-btn')?.textContent ?? null,
    };
  })()`);
  console.log('已开始态：', JSON.stringify(aimed));
  await shot('02-aim');

  ws.close();
  child.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
