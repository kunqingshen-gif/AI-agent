/**
 * 管家四项能力的真实点击验证。
 *
 * 与 probe-all 同样的原则：只用真实鼠标坐标，不用 element.click()。
 * 抽屉是浮层，最容易被遮挡或点穿，必须用坐标点、用 elementFromPoint 判断。
 *
 * 运行：node scripts/probe-guardian.mjs [baseUrl]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9477;
const OUT = path.resolve('.data/guardian');
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
      `--user-data-dir=${path.resolve('.data/edge-guardian')}`,
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
    if (!info) {
      console.log(`  ✗ 找不到按钮「${text}」`);
      return false;
    }
    await clickAt(info.x, info.y);
    if (!info.hitSelf) console.log(`  ⚠ 「${text}」被遮挡`);
    return info.hitSelf;
  };

  const textOf = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
  const sheetText = () => textOf('.sheet');
  const check = (label, ok, detail = '') => console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `｜${detail}` : ''}`);

  /* ── 1. 办前体检 ── */
  console.log('\n== 办前体检 ==');
  await clickByText('材料够不够');
  await sleep(900);
  await shot('30-preflight');
  const pf = await sheetText();
  check('抽屉打开', Boolean(pf));
  check('指出会被退回的那一份', (pf ?? '').includes('家庭收入证明'));
  check('指出「办到一半会失效」', (pf ?? '').includes('办到一半'));
  check('给出补救路径', (pf ?? '').includes('提前把最低生活保障证明续期'));
  check('写明是预判不冒充审批', (pf ?? '').includes('以受理窗口为准'));
  check('一次办成率有给出', (pf ?? '').includes('一次办成率'));

  /* ── 2. 要操心的事 ── */
  console.log('\n== 要操心的事 ==');
  await clickByText('✕', '.sheet-close');
  await sleep(400);
  await clickByText('有什么要到期');
  await sleep(900);
  await shot('31-lifecycle');
  const life = await sheetText();
  check('抽屉打开', Boolean(life));
  check('最急的是本月水费', (life ?? '').includes('本月水费'));
  check('写清过期后果', (life ?? '').includes('停水'));
  check('能直接去办', (life ?? '').includes('这周内办'));

  /* ── 3. 这句话不对劲 ── */
  console.log('\n== 可疑话术 ==');
  await clickByText('✕', '.sheet-close');
  await sleep(400);
  await clickByText('这句话不对劲');
  await sleep(700);
  await shot('32-scam-entry');
  check('先给输入态，不预设答案', Boolean(await textOf('.scam-entry')));
  await clickByText('有人让我把钱转到安全账户', '.chip');
  await sleep(300);
  await clickByText('帮我看看', '.sheet button');
  await sleep(1500);
  await shot('33-scam-result');
  const scam = await sheetText();
  check('判为诈骗', (scam ?? '').includes('这是诈骗'));
  check('列出听出的特征', (scam ?? '').includes('安全账户'));
  check('给出 96110', (scam ?? '').includes('96110'));
  check('可以转给家人', (scam ?? '').includes('把这段话发给家人'));

  /* ── 4. 自然语言直达（不用点按钮） ── */
  console.log('\n== 一句话直达 ==');
  await clickByText('✕', '.sheet-close');
  await sleep(400);
  await evaluate(`(() => {
    const el = document.querySelector('.say-input input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '我这低保复核的材料还差什么');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(200);
  await clickByText('开始', '.send');
  await sleep(1800);
  await shot('34-nl-preflight');
  const nl = await sheetText();
  check('说一句话就打开体检', (nl ?? '').includes('家庭收入证明'));

  /* ── 5. 协办码 ── */
  console.log('\n== 协办码 ==');
  await clickByText('✕', '.sheet-close');
  await sleep(500);
  await clickByText('叫人陪我办');
  await sleep(1600);
  await shot('35-collab-code');
  const code = await evaluate(`[...document.querySelectorAll('.code-digit')].map((n) => n.textContent).join('')`);
  check('生成六位协办码', typeof code === 'string' && code.length === 6, code);
  check('不含念不清的字符', !/[01OI]/.test(code ?? ''), code);
  check('讲清「看得到但按不了」', ((await sheetText()) ?? '').includes('按不了'));

  await clickByText('模拟女儿接入', '.sheet button');
  await sleep(900);
  const joined = await evaluate(`document.querySelector('.collab-status')?.textContent ?? ''`);
  check('家人接入后状态变化', joined.includes('女儿'));

  await clickByText('点右上角的返回', '.chip');
  await sleep(1200);
  await shot('36-collab-hint');
  const bubble = await evaluate(`document.querySelector('.collab-bubble')?.textContent ?? null`);
  check('提示出现在老人手机屏上', Boolean(bubble), bubble ?? '');
  check('手机上标明是谁说的', (bubble ?? '').includes('女儿'));

  /* 家人发来的是一句话，不是一次代按：屏幕上没有任何控件被点下 */
  const screenIntact = await evaluate(`document.querySelector('.app-title')?.textContent ?? null`);
  check('手机仍停在原来那一页，没有被代按', Boolean(screenIntact), screenIntact ?? '');

  console.log('\n截图目录：.data/guardian');
  ws.close();
  child.kill();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
