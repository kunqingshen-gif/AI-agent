/**
 * 全量真实点击验证：把「服务」「我的」两页里每一个可点元素都点一遍。
 *
 * 只用真实鼠标坐标（Input.dispatchMouseEvent），因为 element.click() 会绕过遮挡，
 * 测不出「看得见却点不着」这种最伤人的问题。
 *
 * 运行：node scripts/probe-all.mjs [baseUrl]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9466;
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
      `--user-data-dir=${path.resolve('.data/edge-all')}`,
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
  const toastOf = () => evaluate(`document.querySelector('.toast')?.textContent ?? null`);
  const shot = async (name) => {
    const res = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(res.result.data, 'base64'));
  };

  const clickTab = async (label) => {
    const info = await evaluate(`(() => {
      const b = [...document.querySelectorAll('.app-tabs .tab')].find((n) => n.textContent.trim() === ${JSON.stringify(label)});
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (info) await clickAt(info.x, info.y);
    return Boolean(info);
  };

  /** 点第 n 个正文按钮，返回它是否真被点到（有没有被遮挡） */
  const clickBodyButton = async (n) => {
    const info = await evaluate(`(() => {
      const list = document.querySelectorAll('.app-body button');
      const b = list[${n}];
      if (!b) return null;
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return {
        text: b.textContent.trim().replace(/\\s+/g, ' ').slice(0, 24),
        x: Math.round(cx), y: Math.round(cy),
        hitSelf: Boolean(hit && (hit === b || b.contains(hit))),
        inView: cy > 90 && cy < 830,
      };
    })()`);
    if (!info) return null;
    await clickAt(info.x, info.y);
    return info;
  };

  const report = [];
  const reset = async () => {
    await send('Page.navigate', { url: BASE });
    await sleep(1600);
  };

  const walk = async (tabLabel, screenName) => {
    await reset();
    await clickTab(tabLabel);
    await sleep(700);
    const before = await titleOf();
    const labels = await evaluate(`[...document.querySelectorAll('.app-body button')].map((b) => b.textContent.trim().replace(/\\s+/g, ' '))`);
    console.log(`\n== ${screenName}（${before}）共 ${labels.length} 个可点元素 ==`);
    for (let i = 0; i < labels.length; i += 1) {
      /* 每个入口都从干净状态开始，避免上一跳改变了下标 */
      await reset();
      await clickTab(tabLabel);
      await sleep(500);
      const info = await clickBodyButton(i);
      await sleep(650);
      const title = await titleOf();
      const toast = await toastOf();
      const moved = title !== before;
      const line = `${moved ? '✓' : '✗'} ${info?.text ?? '(无)'} → ${title}${toast ? `｜提示：${toast}` : ''}${info?.hitSelf ? '' : '｜⚠被遮挡'}`;
      console.log(`  ${line}`);
      report.push({ tab: screenName, text: info?.text, moved, title, toast, occlusion: !info?.hitSelf });
    }
  };

  await walk('服务', '服务大厅');
  await walk('我的', '我的');

  // 「我的」里的两个真实动作：字体调大、联系客服
  await reset();
  await clickTab('我的');
  await sleep(500);
  const fontSizeBefore = await evaluate(`getComputedStyle(document.querySelector('.list-label')).fontSize`);
  const fontBtn = await evaluate(`(() => {
    const b = [...document.querySelectorAll('.app-body button')].find((n) => n.textContent.includes('字体调大'));
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (fontBtn) await clickAt(fontBtn.x, fontBtn.y);
  await sleep(500);
  const fontSizeAfter = await evaluate(`getComputedStyle(document.querySelector('.list-label')).fontSize`);
  await shot('20-font-large');
  console.log(`\n字号：${fontSizeBefore} → ${fontSizeAfter}`);

  await reset();
  await clickTab('我的');
  await sleep(400);
  const helpBtn = await evaluate(`(() => {
    const b = [...document.querySelectorAll('.app-body button')].find((n) => n.textContent.includes('联系客服'));
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (helpBtn) await clickAt(helpBtn.x, helpBtn.y);
  await sleep(600);
  const modal = await evaluate(`document.querySelector('.modal h3')?.textContent ?? null`);
  await shot('21-help-modal');
  console.log(`客服弹窗：${modal ?? '未弹出'}`);

  // 服务页宫格是否首屏可见（不用滚动就能看到宫格）
  await evaluate(`document.querySelector('.modal-mask')?.click()`);
  await sleep(300);
  await reset();
  await clickTab('服务');
  await sleep(600);
  const gridView = await evaluate(`(() => {
    const g = document.querySelector('.app-body .grid');
    if (!g) return null;
    const r = g.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), visible: r.top < 812 };
  })()`);
  await shot('22-service-first-screen');
  console.log(`服务页宫格：${JSON.stringify(gridView)}`);

  const failed = report.filter((r) => !r.moved);
  const occluded = report.filter((r) => r.occlusion);
  console.log(`\n合计 ${report.length} 个入口，未跳转 ${failed.length} 个，被遮挡 ${occluded.length} 个`);
  if (failed.length) console.log('未跳转：', JSON.stringify(failed.map((f) => `${f.tab}/${f.text}`), null, 0));
  if (occluded.length) console.log('被遮挡：', JSON.stringify(occluded.map((f) => `${f.tab}/${f.text}`), null, 0));

  ws.close();
  child.kill();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
