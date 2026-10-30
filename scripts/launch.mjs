/**
 * 桌面一键启动器：双击桌面快捷方式后完成「自检 → 按需构建 → 启动服务 → 打开浏览器」。
 *
 * 设计要点：
 *   1. 逻辑放在 .mjs 而非 .bat，避开 cmd 代码页导致的中文乱码；
 *   2. 启动前判断 dist 是否落后于 src，落后就自动重建，避免「改了代码却跑旧产物」；
 *   3. 端口已有本产品实例时不再重复启动，直接打开浏览器；
 *   4. 服务以子进程前台运行，Ctrl+C 或关闭窗口即一并结束，不留残留进程。
 *
 * 用法：
 *   node scripts/launch.mjs               正常启动并打开浏览器
 *   node scripts/launch.mjs --no-open     启动但不打开浏览器
 *   node scripts/launch.mjs --check       只做环境自检，不启动
 *   node scripts/launch.mjs --port=8899   指定端口（覆盖 .env）
 *   node scripts/launch.mjs --skip-build  跳过构建检查
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const OPTIONS = {
  open: !has('--no-open'),
  checkOnly: has('--check'),
  skipBuild: has('--skip-build'),
  port: Number(valueOf('port', process.env.PORT ?? 8787)),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (text = '') => console.log(text);

function section(title) {
  line();
  line(`── ${title} ──`);
}

function ok(text) {
  console.log(`  [通过] ${text}`);
}

function warn(text) {
  console.log(`  [注意] ${text}`);
}

function fail(text) {
  console.log(`  [失败] ${text}`);
}

/** 递归取目录下所有文件的最新修改时间 */
function newestMtime(dir, acc = 0) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      acc = newestMtime(full, acc);
    } else {
      const t = statSync(full).mtimeMs;
      if (t > acc) acc = t;
    }
  }
  return acc;
}

function human(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

async function probe(port) {
  /* 返回 'ours' | 'other' | 'free' */
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/meta`, {
      signal: AbortSignal.timeout(1200),
    });
    if (!res.ok) return 'other';
    const meta = await res.json();
    return meta && typeof meta.product === 'string' ? 'ours' : 'other';
  } catch {
    /* 连不上：进一步判断是「无人监听」还是「有监听但不响应 HTTP」 */
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(1200),
      });
      return res.ok ? 'ours' : 'other';
    } catch {
      return 'free';
    }
  }
}

/**
 * 打开浏览器。
 *
 * Windows 上不用 `cmd /c start "" <url>`：Node 的 Windows 参数转义会把空标题
 * 改写成 `"\"\""`，部分环境下 start 会把它当成要打开的路径而静默失败。
 * explorer.exe 接收 URL 走 shell 关联，不经过 cmd 分词，也不会闪黑窗，实测最稳。
 */
async function openBrowser(url) {
  if (!isWin) {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    return new Promise((resolve) => {
      const child = spawn(cmd, [url], { stdio: 'ignore' });
      child.on('error', () => {
        warn(`无法自动打开浏览器，请手动访问 ${url}`);
        resolve(false);
      });
      child.on('spawn', () => resolve(true));
    });
  }

  /* 按可靠性依次尝试；explorer 打开成功也返回 1，因此用 spawn 事件而非退出码判断 */
  const tryOpen = (cmd, cmdArgs) =>
    new Promise((resolve) => {
      let settled = false;
      const child = spawn(cmd, cmdArgs, {
        stdio: 'ignore',
        windowsHide: true,
        detached: true,
      });
      child.on('error', () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      });
      child.on('spawn', () => {
        if (!settled) {
          settled = true;
          child.unref();
          resolve(true);
        }
      });
    });

  if (await tryOpen('explorer.exe', [url])) return true;
  if (await tryOpen('rundll32.exe', ['url.dll,FileProtocolHandler', url])) return true;
  warn(`无法自动打开浏览器，请手动访问 ${url}`);
  return false;
}

async function runBuild() {
  return new Promise((resolve) => {
    const npm = isWin ? 'npm.cmd' : 'npm';
    const child = spawn(npm, ['run', 'build'], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: isWin,
    });
    child.on('close', (code) => resolve(code === 0));
  });
}

async function main() {
  line('随行帮办 AssistGuide · 桌面启动器');
  line(`项目目录：${ROOT}`);

  /* ---------- 1. 环境自检 ---------- */
  section('1/4 环境自检');

  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    fail(`Node 版本过低（${process.version}），需要 18 及以上`);
    return 1;
  }
  ok(`Node ${process.version}`);

  if (!existsSync(path.join(ROOT, 'node_modules'))) {
    fail('未安装依赖。请在该目录执行 npm install 后重试');
    return 1;
  }
  ok('依赖已安装（node_modules）');

  const envFile = path.join(ROOT, '.env');
  if (!existsSync(envFile)) {
    warn('未找到 .env，将以默认配置运行（无模型密钥 → 规则通道）');
  } else {
    const env = readFileSync(envFile, 'utf8');
    const key = /^LLM_API_KEY=(.*)$/m.exec(env)?.[1]?.trim() ?? '';
    if (key.length > 10) {
      ok('模型密钥已配置（.env）');
    } else {
      warn('模型密钥为空 → 将以规则引擎模式运行，功能完整但话术为模板');
    }
  }

  /* ---------- 2. 构建产物检查 ---------- */
  section('2/4 构建产物检查');

  const serverJs = path.join(ROOT, 'dist', 'server.js');
  const indexHtml = path.join(ROOT, 'dist', 'web', 'index.html');
  const built = existsSync(serverJs) && existsSync(indexHtml);
  let needBuild = !built;

  if (built) {
    const distTime = Math.min(statSync(serverJs).mtimeMs, statSync(indexHtml).mtimeMs);
    const srcTime = newestMtime(path.join(ROOT, 'src'));
    if (srcTime > distTime) {
      warn('源码比构建产物新，产物已过期');
      needBuild = true;
    } else {
      ok(`产物就绪（server.js ${human(statSync(serverJs).size)}，web ${human(statSync(indexHtml).size)}）`);
    }
  } else {
    warn('未找到构建产物');
  }

  if (needBuild && !OPTIONS.skipBuild) {
    line('  → 正在构建，请稍候…');
    const builtOk = await runBuild();
    if (!builtOk) {
      fail('构建失败，请检查上方 npm 输出');
      return 1;
    }
    ok('构建完成');
  } else if (needBuild && OPTIONS.skipBuild) {
    fail('产物缺失或过期，且指定了 --skip-build');
    return 1;
  }

  /* ---------- 3. 端口探测 ---------- */
  section('3/4 端口探测');

  const portState = await probe(OPTIONS.port);
  const url = `http://127.0.0.1:${OPTIONS.port}/`;

  if (portState === 'other') {
    fail(`端口 ${OPTIONS.port} 已被其他程序占用，请用 --port=其他端口 指定`);
    return 2;
  }
  if (portState === 'ours') {
    ok(`端口 ${OPTIONS.port} 已有本产品实例在运行`);
    line();
    line(`  演示地址：${url}`);
    line(`  说明书：${url}docs/manual.pdf`);
    if (OPTIONS.open) {
      const opened = await openBrowser(url);
      if (opened) line('  已在浏览器打开。');
      else line('  未能自动打开，请把上面的地址复制到浏览器。');
    }
    line();
    line('  （本窗口不会自动关闭，按任意键退出）');
    return 0;
  }
  ok(`端口 ${OPTIONS.port} 空闲`);

  if (OPTIONS.checkOnly) {
    section('自检完成');
    line('  环境正常，可直接启动。');
    return 0;
  }

  /* ---------- 4. 启动服务 ---------- */
  section('4/4 启动服务');

  const child = spawn(process.execPath, [serverJs], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, PORT: String(OPTIONS.port) },
  });

  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    line();
    line(`收到 ${signal}，正在停止服务…`);
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, 3000).unref();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  child.on('exit', (code, signal) => {
    if (!stopping) {
      line();
      if (code === 0 || signal) ok('服务已停止');
      else fail(`服务异常退出（code=${code}）`);
    }
    process.exit(code ?? 0);
  });

  /* 等待健康检查就绪 */
  let ready = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(400);
    try {
      const res = await fetch(`http://127.0.0.1:${OPTIONS.port}/healthz`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) {
        const body = await res.json();
        ok(`服务就绪（${body.version}，模型通道${body.llmAvailable ? '已启用' : '未启用'}）`);
        ready = true;
        break;
      }
    } catch {
      /* 尚未就绪，继续等待 */
    }
  }

  if (!ready) {
    fail('服务未在 16 秒内就绪，请查看上方日志');
    child.kill('SIGTERM');
    return 1;
  }

  line();
  line('  ┌──────────────────────────────────────────────');
  line('  │ 演示地址：');
  line(`  │   ${url}`);
  line('  │ 产品说明书（可当场交给评委）：');
  line(`  │   ${url}docs/manual.pdf`);
  line('  │ 本窗口请保持开启；按 Ctrl+C 或直接关闭窗口即可停止。');
  line('  └──────────────────────────────────────────────');
  line();

  if (OPTIONS.open) {
    const opened = await openBrowser(url);
    if (!opened) line('  请手动把上面的地址复制到浏览器打开。');
  }
  return null; // 交给子进程生命周期决定退出
}

const code = await main();
if (typeof code === 'number') process.exit(code);
