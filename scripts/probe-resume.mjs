/**
 * 验证「中断续办」：办到一半刷新页面，回来还在原来那一步。
 *
 * 为什么必须刷新验证：不刷新的话，前端把状态放在 useState 里也能「看起来能接上」，
 * 但那只是没离开过页面。真正要证明的是——页面被重建之后，服务端还记得这个人办的是哪件事、
 * 停在哪一屏，前端能凭一把钥匙把它摆回来。
 *
 * 运行：node scripts/probe-resume.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9493;
const OUT = path.resolve('.data/resume');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `｜${detail}` : ''}`);
};

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
      `--user-data-dir=${path.resolve('.data/edge-resume')}`,
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
      /* 等端口 */
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

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return res.result?.result?.value;
  };
  const textOf = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
  const countOf = (selector) => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  const waitFor = async (selector, timeout = 30000) => {
    const begin = Date.now();
    while (Date.now() - begin < timeout) {
      if (await countOf(selector)) return true;
      await sleep(200);
    }
    return false;
  };
  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const clickByText = async (text, scope) => {
    const info = await evaluate(`(() => {
      const b = [...document.querySelectorAll(${JSON.stringify(scope)})]
        .find((n) => n.textContent.replace(/\\s+/g, ' ').includes(${JSON.stringify(text)}));
      if (!b) return null;
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!info) return false;
    await clickAt(info.x, info.y);
    return true;
  };
  const shot = async (name) => {
    const res = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(res.result.data, 'base64'));
  };
  const waitTitleChange = async (before, timeout = 20000) => {
    const begin = Date.now();
    while (Date.now() - begin < timeout) {
      const now = await textOf('.app-title');
      if (now && now !== before) return now;
      await sleep(250);
    }
    return null;
  };

  await sleep(2500);

  console.log('\n== 开始办一件事，并往下走一步 ==');
  await waitFor('.welcome-task');
  check('起手页有「您自己的事」', (await countOf('.welcome-task')) > 0);
  await clickByText('本月水费', '.welcome-task');
  await waitFor('.next-btn', 30000);
  const firstTitle = await textOf('.app-title');
  const firstNext = await textOf('.next-btn');
  check('办起来了，出现「下一步」', Boolean(firstNext), (firstNext ?? '').trim());
  await clickByText('下一步', '.next-btn');
  const movedTitle = (await waitTitleChange(firstTitle)) ?? firstTitle;
  await waitFor('.next-btn', 20000);
  check('真的走到了下一屏', movedTitle !== firstTitle, `${firstTitle} → ${movedTitle}`);

  console.log('\n== 刷新（模拟被打断） ==');
  await send('Page.reload', { ignoreCache: true });
  await waitFor('.resume-line', 20000);
  const resumeLine = await textOf('.resume-line');
  check('屏上出现「接着上次办」', (resumeLine ?? '').includes('接着上次办'), (resumeLine ?? '').trim());
  check('说的是同一件事', (resumeLine ?? '').includes('水费'), (resumeLine ?? '').trim());
  const backTitle = await textOf('.app-title');
  check('回到原来那一屏，而不是首页', backTitle === movedTitle, `${backTitle}`);
  const backNext = await textOf('.next-btn');
  check('下一步指令也接上了', Boolean(backNext) && backNext !== firstNext, (backNext ?? '').trim());
  check('没有退回起手页', (await countOf('.welcome-task')) === 0);
  await shot('60-resumed');

  console.log('\n== 服务端不认这把钥匙时静默退回 ==');
  await evaluate(`localStorage.setItem('assist.session', 'dead-session-00000000')`);
  await send('Page.reload', { ignoreCache: true });
  await sleep(2500);
  check('会话不在时不报错', (await countOf('.resume-line')) === 0);
  check('仍能看到起手页，可以重新开始', (await countOf('.welcome-task')) > 0);

  child.kill();
  ws.close();
  console.log(`\n截图目录：${OUT}`);
  console.log(failures === 0 ? '✓ 全部通过' : `✗ ${failures} 项未通过`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('失败：', error);
  process.exit(1);
});
