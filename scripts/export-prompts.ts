/**
 * 把内置提示词导出成 `config/prompts.json`，供业务人员直接编辑。
 *
 * 为什么要这个脚本：
 * 提示词一旦"只能写代码的人改"，可配置就是句空话。导出成 JSON 之后，
 * 改一句话是改文件、重启，而不是改 TS、过 lint、重新构建。
 *
 * 运行：npm run config:export
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_PROMPTS } from '../src/core/application/prompts';

const out = path.resolve('config/prompts.json');
writeFileSync(out, `${JSON.stringify(DEFAULT_PROMPTS, null, 2)}\n`, 'utf8');
console.log(`已导出：${out}`);
console.log(`版本：${DEFAULT_PROMPTS.version} 字段：${Object.keys(DEFAULT_PROMPTS).join(', ')}`);
console.log('改完重启服务即可生效；改内容记得同时改 version，否则「它说错了」归不到因。');
