/**
 * 小屏验证：1366×768 笔记本、以及更矮的 1280×700 下，
 * 底部标签是否仍完整可见并可点（这是「点不动」最常见的真实成因）。
 * 运行：node scripts/probe-small.mjs [baseUrl]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9511;
const OUT = path.resolve('.data/shots');
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
      `--user-data-dir=${path.resolve('.data/edge-small')}`,
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
  await sleep(1500);

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return res.result?.result?.value;
  };
  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };

  for (const [w, h] of [
    [1366, 768],
    [1280, 700],
    [1920, 1080],
  ]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: BASE });
    await sleep(1500);
    const geo = await evaluate(`(() => {
      const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) }; };
      const tabs = [...document.querySelectorAll('.app-tabs .tab')];
      const info = tabs.map((b) => {
        const q = b.getBoundingClientRect();
        const cx = q.x + q.width / 2, cy = q.y + q.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        return { label: b.textContent.trim(), x: Math.round(cx), y: Math.round(cy), hitSelf: Boolean(hit && b.contains(hit)), inView: cy > 0 && cy < innerHeight };
      });
      return { vh: innerHeight, phone: r('.phone'), metrics: r('.metrics'), tabs: info };
    })()`);
    const tab = geo.tabs.find((t) => t.label === '服务');
    if (tab) await clickAt(tab.x, tab.y);
    await sleep(700);
    const title = await evaluate(`document.querySelector('.app-title')?.textContent ?? null`);
    const ok = title === '服务大厅';
    console.log(`${w}×${h}｜视口 ${geo.vh}｜手机 ${geo.phone?.top}~${geo.phone?.bottom}｜指标栏 ${geo.metrics?.top}~${geo.metrics?.bottom}｜点「服务」→ ${title} ${ok ? '✓' : '✗'}`);
    const res = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT, `small-${w}x${h}.png`), Buffer.from(res.result.data, 'base64'));
  }

  ws.close();
  child.kill();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
