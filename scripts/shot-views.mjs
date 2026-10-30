/**
 * 出图：把「服务」「我的」及其子页逐屏截下来，用于人工核对与文档素材。
 * 运行：node scripts/shot-views.mjs [baseUrl]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9488;
const OUT = path.resolve('.data/views');
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
      `--user-data-dir=${path.resolve('.data/edge-views')}`,
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
  await sleep(1800);

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return res.result?.result?.value;
  };
  const shot = async (name) => {
    const res = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(res.result.data, 'base64'));
  };
  const clickAtPoint = async (sel, text) => {
    const p = await evaluate(`(() => {
      const nodes = [...document.querySelectorAll(${JSON.stringify(sel)})];
      const b = nodes.find((n) => (n.textContent || '').replace(/\\s+/g, '').includes(${JSON.stringify(text.replace(/\s+/g, ''))}));
      if (!b) return null;
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!p) {
      console.log('  ! 找不到', text);
      return false;
    }
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    return true;
  };

  const views = [
    { name: '01-service', steps: [['.app-tabs .tab', '服务']] },
    { name: '02-topic-shebao', steps: [['.app-tabs .tab', '服务'], ['.app-body button', '社保服务']] },
    { name: '03-topic-birth', steps: [['.app-tabs .tab', '服务'], ['.app-body button', '出生一件事']] },
    { name: '04-all', steps: [['.app-tabs .tab', '服务'], ['.app-body button', '全部服务']] },
    { name: '05-mine', steps: [['.app-tabs .tab', '我的']] },
    { name: '06-mine-elder', steps: [['.app-tabs .tab', '我的'], ['.app-body button', '高龄老人津贴申请']] },
    { name: '07-mine-doc', steps: [['.app-tabs .tab', '我的'], ['.app-body button', '低保证明']] },
    { name: '08-mine-family', steps: [['.app-tabs .tab', '我的'], ['.app-body button', '女儿 王丽']] },
    { name: '09-mine-large', steps: [['.app-tabs .tab', '我的'], ['.app-body button', '字体调大']] },
  ];

  for (const view of views) {
    await send('Page.navigate', { url: BASE });
    await sleep(1500);
    for (const [sel, text] of view.steps) {
      await clickAtPoint(sel, text);
      await sleep(700);
    }
    await evaluate(`(() => {
      document.querySelector('.stage')?.scrollTo(0, 0);
      document.querySelector('.app-body')?.scrollTo(0, 0);
      window.scrollTo(0, 0);
    })()`);
    await sleep(200);
    await shot(view.name);
    console.log(' ✓', view.name, await evaluate(`document.querySelector('.app-title')?.textContent`));
  }

  ws.close();
  child.kill();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
