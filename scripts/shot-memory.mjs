/**
 * 截图「我记得您的事」面板，并验证它真的会变。
 *
 * 要做三件事，缺一不可：
 *   1. 第一次进来显示「这次刚记下」；
 *   2. 点「我自己会」后提示语变了、按钮高亮跟着走；
 *   3. 刷新页面回来显示「上次记下的」——这一步才叫记忆，
 *      只做前两步的话，任何前端 useState 都能骗过去。
 *
 * 运行：node scripts/shot-memory.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9491;
const OUT = path.resolve('.data/memory');
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
      `--user-data-dir=${path.resolve('.data/edge-memory')}`,
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
  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const clickByText = async (text, scope) => {
    const info = await evaluate(`(() => {
      const b = [...document.querySelectorAll(${JSON.stringify(scope)})]
        .find((n) => n.textContent.trim().replace(/\\s+/g, ' ').includes(${JSON.stringify(text)}));
      if (!b) return null;
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!info) return false;
    await clickAt(info.x, info.y);
    return true;
  };
  const textOf = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
  const countOf = (selector) => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  /* 引导请求在飞的时候按钮是禁用的：不等它落地就点，点了等于没点 */
  const waitForEnabled = async (selector, timeout = 30000) => {
    const begin = Date.now();
    while (Date.now() - begin < timeout) {
      const n = await evaluate(`document.querySelectorAll(${JSON.stringify(`${selector}:not([disabled])`)}).length`);
      if (n > 0) return true;
      await sleep(200);
    }
    return false;
  };
  const waitFor = async (selector, timeout = 30000) => {
    const begin = Date.now();
    while (Date.now() - begin < timeout) {
      if (await countOf(selector)) return true;
      await sleep(200);
    }
    return false;
  };
  const shot = async (name, clip) => {
    const params = { format: 'png', ...(clip ? { clip: { ...clip, scale: 2 } } : {}) };
    const res = await send('Page.captureScreenshot', params);
    writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(res.result.data, 'base64'));
  };
  /* 只截面板本身：整屏截图里它太小，看不清就等于没做 */
  const panelRect = async () => {
    const rect = await evaluate(`(() => {
      const el = document.querySelector('.memory-panel');
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`);
    await sleep(300);
    return rect;
  };

  await sleep(2500);

  console.log('\n== 第一次进来 ==');
  await waitFor('.welcome-task');
  await clickByText('本月水费', '.welcome-task');
  await waitFor('.memory-panel');
  await waitFor('.memory-tag.stored, .memory-tag', 8000);
  const tag1 = await textOf('.memory-tag');
  check('面板出现且说明来源', (tag1 ?? '').includes('刚记下'), (tag1 ?? '').trim());
  const rect1 = await panelRect();
  if (rect1) await shot('50-memory-first', rect1);
  check('记着称呼与年龄', ((await textOf('.memory-line')) ?? '').includes('68'), ((await textOf('.memory-line')) ?? '').trim());

  console.log('\n== 改成「我自己会」 ==');
  await waitForEnabled('.memory-level-btn');
  await sleep(300);
  const clicked = await clickByText('我自己会', '.memory-level-btn');
  check('档位按钮点得到', clicked);
  await sleep(1200);
  const onText = await textOf('.memory-level-btn.on');
  check('高亮跟着走', (onText ?? '').includes('我自己会'), (onText ?? '').trim());
  const hint = await textOf('.memory-hint');
  check('说明文字同步变了', (hint ?? '').includes('直接说点哪儿'), (hint ?? '').trim());
  const rect2 = await panelRect();
  if (rect2) await shot('51-memory-changed', rect2);

  console.log('\n== 刷新再回来（这一步才叫记忆） ==');
  /*
   * 刷新前清掉「办到哪一步」那把钥匙：
   * 这里要验的是「档案还记得」，不是「断点续办」，清掉才回得到起手页。
   * deviceId 不动，所以档案仍然读得回来。
   */
  await evaluate(`localStorage.removeItem('assist.session')`);
  await send('Page.reload', { ignoreCache: true });
  await sleep(2500);
  await waitFor('.welcome-task');
  await clickByText('本月水费', '.welcome-task');
  await waitFor('.memory-tag', 30000);
  const tag2 = await textOf('.memory-tag');
  check('这次是「上次记下的」', (tag2 ?? '').includes('上次记下'), (tag2 ?? '').trim());
  const level2 = await textOf('.memory-level-btn.on');
  check('档位也被记住了', (level2 ?? '').includes('我自己会'), (level2 ?? '').trim());
  const rect3 = await panelRect();
  if (rect3) await shot('52-memory-remembered', rect3);

  console.log('\n== 忘掉我的信息 ==');
  await clickByText('忘掉我的信息', '.memory-panel .link-btn');
  await sleep(400);
  await clickByText('确定忘掉', '.memory-confirm .link-btn');
  await sleep(1500);
  const tag3 = await textOf('.memory-tag');
  check('忘掉后回到「这次刚记下」', (tag3 ?? '').includes('刚记下'), (tag3 ?? '').trim());
  const level3 = await textOf('.memory-level-btn.on');
  check('档位回到默认', (level3 ?? '').includes('慢点讲'), (level3 ?? '').trim());
  const rect4 = await panelRect();
  if (rect4) await shot('53-memory-forgotten', rect4);

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
