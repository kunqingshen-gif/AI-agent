/**
 * 把 docs/manual.html 打印成 PDF。
 *
 * 依赖本机 Edge / Chrome 的无头打印能力，不引入额外 npm 包。
 * 运行：npm run pdf
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const browser = CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.error('未找到 Edge/Chrome，可手动打开 docs/manual.html 后「打印为 PDF」。');
  process.exit(1);
}

const cwd = process.cwd();
const src = path.join(cwd, 'docs/manual.html');
const out = path.join(cwd, 'docs/manual.pdf');
const url = `file:///${src.replace(/\\/g, '/')}`;

console.log(`使用浏览器：${browser}`);
console.log(`源文件：${src}`);

execFileSync(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-pdf-header-footer',
    '--virtual-time-budget=8000',
    `--print-to-pdf=${out}`,
    url,
  ],
  { stdio: 'ignore' },
);

const { size } = statSync(out);
console.log(`已生成：${out}（${(size / 1048576).toFixed(2)} MB）`);
