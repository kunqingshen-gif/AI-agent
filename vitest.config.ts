import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@core': path.resolve(__dirname, 'src/core'),
      '@infra': path.resolve(__dirname, 'src/infra'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: ['default'],
    /*
     * 串行执行测试文件，原因：
     *   多个 worker 并发时，Vitest 会同时向系统临时目录写入 SSR 转换缓存，
     *   在受限的文件系统沙箱（如企业管控终端、部分 CI 容器）下会触发 EPERM，
     *   表现为「部分测试文件静默不执行」，全量用例数凭空少一截。
     * 代价：5 个文件从 0.7s 变为 1.9s，可忽略；收益：本机与 CI 行为一致。
     */
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/core/**/*.ts'],
    },
  },
});
