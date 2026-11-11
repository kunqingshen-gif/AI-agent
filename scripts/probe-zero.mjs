/**
 * 「零学习成本」三件套的真实点击验证。
 *
 * 要证明的不是「有这三个控件」，而是：
 *   ① 起手页只有一条路，且那条路不用学；
 *   ② 从起手页点一件常办事，真的能开始办；
 *   ③ 「下一步」大按钮真的能连着按，且不压住底部导航。
 *
 * 仍然只用真实鼠标坐标 + elementFromPoint 判遮挡。
 *
 * 运行：node scripts/probe-zero.mjs [baseUrl]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9479;
const OUT = path.resolve('.data/zero');
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
      `--user-data-dir=${path.resolve('.data/edge-zero')}`,
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
  await sleep(2000);

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
      console.log(`  ✗ 找不到「${text}」`);
      return false;
    }
    await clickAt(info.x, info.y);
    if (!info.hitSelf) console.log(`  ⚠ 「${text}」被遮挡，点不到`);
    return info.hitSelf;
  };
  const textOf = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
  const countOf = (selector) => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  /*
   * 模型通道比规则慢，固定 sleep 会把「还没回来」误判成「没有」。
   *
   * 上限给到 30 秒而不是 12 秒：点完卡片要走「意图 → 引导」两次模型调用，
   * 实测单次 1.5–7 秒，两次叠加完全可能超过 12 秒。
   * 早前的 12 秒会让探针间歇性红 6 项，而产品其实是好的——
   * 探针误报和探针漏报一样有害：都让人不再相信它。
   */
  const waitFor = async (selector, timeout = 30000) => {
    const begin = Date.now();
    while (Date.now() - begin < timeout) {
      if (await countOf(selector)) return true;
      await sleep(200);
    }
    return false;
  };
  /** 等到某段文字出现为止，返回文本；超时返回 null */
  const waitForText = async (selector, needle, timeout = 15000) => {
    const begin = Date.now();
    while (Date.now() - begin < timeout) {
      const text = await textOf(selector);
      if (text && text.includes(needle)) return text;
      await sleep(200);
    }
    return null;
  };
  /*
   * 失败项要能改变退出码。
   *
   * 早前这里只打印不判定：哪怕 20 项全红，脚本也返回 0，
   * 上层「一键复现」照样报通过——验证看着绿、其实没验。
   * 自检工具一旦会说谎，比没有工具更危险。
   */
  let failures = 0;
  const check = (label, ok, detail = '') => {
    if (!ok) failures += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `｜${detail}` : ''}`);
  };

  /* ── 1. 起手页：一条路 ── */
  console.log('\n== 起手页（第一次打开） ==');
  await shot('40-welcome');
  check('有一个最大的按钮', (await countOf('.welcome-mic')) === 1);
  check('按钮上写的是「按这里说话」', (await textOf('.welcome-mic'))?.includes('按这里说话') ?? false);
  check('没有搜索框、没有九宫格抢注意力', (await countOf('.card-welcome .search')) === 0);
  const taskCount = await countOf('.welcome-task');
  check('给三件「您自己的事」，不是示例句', taskCount === 3, `${taskCount} 件`);
  const firstTask = await textOf('.welcome-task');
  check('第一件就是最急的那件（本月水费）', (firstTask ?? '').includes('本月水费'), (firstTask ?? '').replace(/\s+/g, ' '));
  check('卡片带到期天数，不是空标题', (firstTask ?? '').includes('还有'), (firstTask ?? '').replace(/\s+/g, ' '));

  /* ── 2. 点一件 → 真的开始办 ── */
  console.log('\n== 点一件常办的事 ==');
  const tapped = await clickByText('本月水费', '.welcome-task');
  check('卡片点得到（未被遮挡）', tapped);
  const pickAt = Date.now();
  const guided = await waitFor('.card-guide');
  /* 这个耗时直接写进报告：老人点一下卡片，究竟等了几秒才看到「下一步」 */
  const pickMs = Date.now() - pickAt;
  const started = guided ? await waitForText('.intent-line', '生活缴费', 8000) : await textOf('.intent-line');
  check(
    '识别成立，不是弹个提示',
    (started ?? '').includes('生活缴费'),
    (started ?? '点了卡片 30 秒内没有出现确认行').replace(/\s+/g, ' '),
  );
  check('进入办事流程', guided, guided ? `点完到出引导 ${(pickMs / 1000).toFixed(1)} 秒` : '');
  await shot('41-after-pick');

  /* ── 3. 下一步大按钮：连按 ── */
  console.log('\n== 「下一步」大按钮 ==');
  check('下一步条出现', (await countOf('.next-btn')) === 1);
  const firstNext = await textOf('.next-btn');
  check('按钮上写的是具体控件名', (firstNext ?? '').includes('点「'), (firstNext ?? '').replace(/\s+/g, ' '));
  await shot('42-next-btn');

  let hops = 0;
  let clickable = true;
  let chainBroken = false;
  for (let i = 0; i < 3; i += 1) {
    const labelBefore = await textOf('.next-btn');
    if (!labelBefore) {
      /* 上一步之后按钮没回来＝链路断了，老人这一步就得自己找 */
      chainBroken = true;
      break;
    }
    const ok = await clickByText('下一步', '.next-btn');
    if (!ok) {
      clickable = false;
      break;
    }
    /* 按钮换成下一个名字，才算真的往前走了一步 */
    const begin = Date.now();
    let changed = false;
    while (Date.now() - begin < 15000) {
      await sleep(250);
      const label = await textOf('.next-btn');
      if (label && label !== labelBefore) {
        changed = true;
        break;
      }
    }
    if (changed) hops += 1;
    else chainBroken = true;
    await sleep(400);
    if (i === 2) await shot('43-next-btn-deep');
  }
  check('按钮一路接得上（不用中途自己找）', !chainBroken, chainBroken ? '中途断链' : '');
  check('连按能把人往前带（屏幕真的换了）', hops >= 2, `${hops}/3 次换屏`);
  check('每一步按钮都点得到（不遮挡）', clickable);

  const tabOk = await evaluate(`(() => {
    const t = document.querySelector('.app-tabs .tab:last-child');
    if (!t) return 'no-tab';
    const r = t.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return Boolean(hit && (hit === t || t.contains(hit)));
  })()`);
  check('底部导航没被下一步条压住', tabOk === true, String(tabOk));

  /* ── 4. 说不清 → 改问「是不是这一件」 ── */
  console.log('\n== 说不清时的降级 ==');
  /*
   * 这一段要模拟「重新开始的一位老人」：断点续办会让普通刷新接着上次办，
   * 所以这里显式清掉本机存档，再导航回首页。
   */
  await evaluate(`(() => { localStorage.removeItem('assist.session'); sessionStorage.removeItem('assist.booted'); })()`);
  await send('Page.navigate', { url: BASE });
  await sleep(2200);
  await clickByText('按这里说话', '.welcome-mic');
  await sleep(1200);
  await clickByText('按这里说话', '.welcome-mic');
  await sleep(1200);
  await shot('44-ask');
  const askOpen = await countOf('.ask-layer');
  if (process.env.DEBUG_BOX) {
    console.log(
      '  · 盒模型',
      await evaluate(`(() => {
        const l = document.querySelector('.ask-layer');
        const s = document.querySelector('.phone-screen');
        if (!l || !s) return 'missing';
        const r = (e) => { const b = e.getBoundingClientRect(); return [Math.round(b.top), Math.round(b.height)]; };
        return JSON.stringify({ layer: r(l), screen: r(s), lPos: getComputedStyle(l).position, sPos: getComputedStyle(s).position });
      })()`),
    );
  }  check('听不清两次后自己换路子（不是一直让他再说一遍）', askOpen === 1);
  const askText = await textOf('.ask-layer');
  check('问的是「要办哪一件」而不是「您想说什么」', (askText ?? '').includes('哪一件'));
  check('降级后仍是可点的三件', (await countOf('.ask-layer .ask-task')) === 3);

  const picked = await clickByText('低保资格复核', '.ask-layer .ask-task');
  check('降级路径点得动', picked);
  await waitFor('.card-guide');
  const pickedText = await waitForText('.intent-line', '低保', 15000);
  check('点了就真的开始办', Boolean(pickedText), pickedText ? pickedText.replace(/\s+/g, ' ') : '15 秒内没出现确认行');

  child.kill();
  ws.close();
  console.log('\n截图目录：.data/zero');
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
