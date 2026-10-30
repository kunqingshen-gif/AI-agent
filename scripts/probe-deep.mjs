/**
 * 深层链路验证：主题页 → 条目 → 说明页 → 返回；子页底部导航；办事中的标签切换。
 * 运行：node scripts/probe-deep.mjs [baseUrl]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9477;
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
      `--user-data-dir=${path.resolve('.data/edge-deep')}`,
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
  const titleOf = () => evaluate(`document.querySelector('.app-title')?.textContent ?? null`);
  const tabsOf = () => evaluate(`[...document.querySelectorAll('.app-tabs .tab')].map((b) => b.textContent.trim() + (b.classList.contains('tab-active') ? '*' : ''))`);
  const shot = async (name) => {
    const res = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(res.result.data, 'base64'));
  };

  const clickByText = async (text, scope = '.phone-screen button') => {
    const info = await evaluate(`(() => {
      const nodes = [...document.querySelectorAll(${JSON.stringify(scope)})];
      const b = nodes.find((n) => (n.textContent || '').replace(/\\s+/g, '').includes(${JSON.stringify(text.replace(/\s+/g, ''))}));
      if (!b) return null;
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return { x: Math.round(cx), y: Math.round(cy), self: Boolean(hit && (hit === b || b.contains(hit))) };
    })()`);
    if (!info) {
      console.log(`    ! 找不到「${text}」`);
      return false;
    }
    if (!info.self) console.log(`    ! 「${text}」被遮挡`);
    await clickAt(info.x, info.y);
    return true;
  };

  const step = async (label, text, expect, wait = 900, scope = '.phone-screen button') => {
    await clickByText(text, scope);
    await sleep(wait);
    const title = await titleOf();
    const ok = expect ? title === expect : true;
    console.log(`  ${ok ? '✓' : '✗'} ${label} → ${title}${expect && !ok ? `（期望 ${expect}）` : ''}`);
    return ok;
  };

  const stepTab = (label, expect, wait = 1200) => step(`切${label}`, label, expect, wait, '.app-tabs .tab');

  console.log('\n== 主题页 → 条目 → 真实流程 ==');
  await stepTab('服务', '服务大厅');
  await step('进社保专区', '社保服务', '社会保险');
  console.log('   标签：', JSON.stringify(await tabsOf()));
  await step('点养老资格认证', '养老待遇领取资格认证', '养老保险待遇领取资格认证');
  console.log('   标签：', JSON.stringify(await tabsOf()));
  await stepTab('服务', '服务大厅');

  console.log('\n== 未接入事项：说明页 + 返回 ==');
  await step('进社保专区', '社保服务', '社会保险');
  await step('点社保卡挂失', '社会保障卡挂失', '这一项还没接入');
  await shot('23-todo-page');
  await step('点打 12345 问', '打 12345 问', null, 600);
  const modal = await evaluate(`document.querySelector('.modal h3')?.textContent ?? null`);
  console.log(`  ${modal === '找个人帮您' ? '✓' : '✗'} 客服弹窗：${modal ?? '未弹出'}`);
  await evaluate(`document.querySelector('.modal-mask')?.click()`);
  await sleep(400);
  await step('点回到上一页', '回到上一页', '社会保险');

  console.log('\n== 我的：办件详情 → 返回箭头回我的 ==');
  await stepTab('我的', '我的');
  await step('点高龄津贴', '高龄老人津贴申请', '高龄老人津贴申请');
  await shot('24-mine-elder');
  await clickByText('‹', '.app-bar button');
  await sleep(900);
  console.log(`  ${(await titleOf()) === '我的' ? '✓' : '✗'} 返回箭头 → ${await titleOf()}`);

  console.log('\n== 我的：材料详情 ==');
  await step('点低保证明', '低保证明', '低保证明');
  await shot('25-doc-detail');
  await step('点看原件', '看原件', '这一项还没接入');
  await clickByText('‹', '.app-bar button');
  await sleep(800);
  console.log(`  返回 → ${await titleOf()}`);

  console.log('\n== 办事中：标签仍可点，Agent 会拉回来 ==');
  await send('Page.navigate', { url: BASE });
  await sleep(1800);
  await evaluate(`(() => {
    const input = document.querySelector('.say-input input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '我要办低保复核');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(200);
  await evaluate(`(() => { const b = [...document.querySelectorAll('.say-input button')].find((n) => n.textContent.includes('开始')); b?.click(); return true; })()`);
  for (let i = 0; i < 30; i += 1) {
    await sleep(1000);
    const done = await evaluate(`Boolean(document.querySelector('.step-chip')) && !document.querySelector('.card-guide.is-loading')`);
    if (done) break;
  }
  console.log(`  引导就绪：${await evaluate(`document.querySelector('.instruction')?.textContent ?? '-'`)}`);
  await stepTab('服务', '服务大厅');
  await sleep(2500);
  const after = await evaluate(`document.querySelector('.instruction')?.textContent ?? '-'`);
  console.log(`  Agent 拉回话术：${after.slice(0, 42)}`);
  await shot('26-service-during-task');
  await stepTab('我的', '我的');
  await sleep(2000);
  console.log(`  我的页引导：${(await evaluate(`document.querySelector('.instruction')?.textContent ?? '-'`)).slice(0, 42)}`);

  ws.close();
  child.kill();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
