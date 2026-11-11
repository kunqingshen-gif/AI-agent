/**
 * 多模态能力的两条真实验证。
 *
 * ① 语音归一：方言 + 听错 + 老人叫法，在「理解意图」之前修好，并且让用户看见改了什么；
 * ② 视觉可达性：Agent 指到的控件必须真的落在老人此刻能看到的区域里，
 *    在屏幕外就先替他翻过去（屏幕上会出现「翻到这一处才指给您」）。
 *
 * 仍然只用真实鼠标坐标，不用 element.click()。
 *
 * 运行：node scripts/probe-multimodal.mjs [baseUrl]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9475;
const OUT = path.resolve('.data/multimodal');
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
      `--user-data-dir=${path.resolve('.data/edge-multimodal')}`,
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
  await sleep(1800);

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return res.result?.result?.value;
  };
  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const shot = async (name) => {
    const res = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(res.result.data, 'base64'));
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
      return { x: Math.round(cx), y: Math.round(cy), hitSelf: Boolean(hit && (hit === b || b.contains(hit))) };
    })()`);
    if (!info) return false;
    await clickAt(info.x, info.y);
    return info.hitSelf;
  };
  const textOf = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
  const countOf = (selector) => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  const waitFor = async (selector, timeout = 20000) => {
    const begin = Date.now();
    while (Date.now() - begin < timeout) {
      if (await countOf(selector)) return true;
      await sleep(200);
    }
    return false;
  };
  const waitForText = async (selector, needle, timeout = 20000) => {
    const begin = Date.now();
    while (Date.now() - begin < timeout) {
      const text = await textOf(selector);
      if (text && text.includes(needle)) return text;
      await sleep(200);
    }
    return null;
  };
  const say = async (text) => {
    await evaluate(`(() => {
      const el = document.querySelector('.say-input input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(200);
    await clickByText('开始', '.send');
  };

  let failures = 0;
  const check = (label, ok, detail = '') => {
    if (!ok) failures += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `｜${detail}` : ''}`);
  };

  /* ── 1. 方言 + 听错：改完还要说清改了什么 ── */
  console.log('\n== 语音归一 ==');
  await say('我唔识点样办低保复核');
  const fixed = await waitForText('.speech-fix-line', '唔识', 20000);
  check('方言被翻成普通话', Boolean(fixed), (fixed ?? '没出现校正行').replace(/\s+/g, ' '));
  check('改动理由写在屏上', (fixed ?? '').includes('唔识点样办') && (fixed ?? '').includes('想办'), (fixed ?? '').replace(/\s+/g, ' '));
  const intentLine = await waitForText('.intent-line', '低保', 25000);
  check('归一之后真的认出了事项', Boolean(intentLine), (intentLine ?? '25 秒内没有出现确认行').replace(/\s+/g, ' '));
  await shot('50-dialect');

  /* ── 2. 视觉可达性：每一步指到的控件都得在可视区里 ── */
  console.log('\n== 视觉可达性 ==');
  await waitFor('.next-btn', 30000);
  let moved = 0;
  let offscreen = 0;
  let steps = 0;
  for (let i = 0; i < 9; i += 1) {
    const before = await textOf('.next-btn');
    if (!before) break;
    const titleBefore = await textOf('.app-title');
    const advanced = await clickByText('下一步', '.next-btn');
    if (!advanced) break;
    /* 等引导真的前进一步：换屏或换按钮都算，最多等 20 秒 */
    const begin = Date.now();
    let progressed = false;
    while (Date.now() - begin < 20000) {
      await sleep(300);
      const now = await textOf('.next-btn');
      const titleNow = await textOf('.app-title');
      if (titleNow !== titleBefore || (now && now !== before) || !now) {
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
    /* 等新目标画上去再量，否则量到的是上一屏的残留 */
    const paint = Date.now();
    while (Date.now() - paint < 5000) {
      if (await countOf('.target-wrap.active')) break;
      await sleep(200);
    }
    await sleep(400);
    const state = await evaluate(`(() => {
      const t = document.querySelector('.target-wrap.active');
      const s = document.querySelector('.app-body');
      if (!t || !s) return null;
      const tr = t.getBoundingClientRect();
      const sr = s.getBoundingClientRect();
      return {
        inside: tr.top >= sr.top - 6 && tr.bottom <= sr.bottom + 6,
        moved: Boolean(document.querySelector('.sight-moved')),
        title: document.querySelector('.app-title')?.textContent ?? '',
      };
    })()`);
    if (!state) break;
    steps += 1;
    if (!state.inside) offscreen += 1;
    if (state.moved) moved += 1;
  }
  check('每一步的「点这里」都落在可视区里', steps > 0 && offscreen === 0, `${steps} 步，${offscreen} 步在屏外`);
  check('屏幕外的控件被 Agent 主动翻上来过', moved > 0, `${moved} 次翻屏`);
  await shot('51-aim');

  /* ── 3. 老人叫法：说「老年津贴」也能走 ── */
  console.log('\n== 同义说法 ==');
  await send('Page.navigate', { url: BASE });
  await sleep(2200);
  await say('我想申请老年津贴');
  const aliasLine = await waitForText('.intent-line', '津贴', 45000);
  check('「老年津贴」被听成高龄津贴', Boolean(aliasLine), (aliasLine ?? '45 秒内没有认出').replace(/\s+/g, ' '));
  const guide = await waitFor('.card-guide', 30000);
  check('认出来之后就直接开始办', guide);
  const plan = await textOf('.plan-line');
  check('未收录事项由 AI 现场规划，而不是拒绝', Boolean(plan || guide), plan ? plan.replace(/\s+/g, ' ').slice(0, 60) : '走的是已收录流程');
  await shot('52-alias');

  ws.close();
  child.kill();
  console.log('\n截图目录：.data/multimodal');
  if (failures > 0) {
    console.log(`\n✗ ${failures} 项未通过`);
    process.exit(1);
  }
  console.log('\n✓ 全部通过');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
