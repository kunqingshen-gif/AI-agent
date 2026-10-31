import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    /*
     * deploy/ 与 delivery/ 是打包出去的分发副本，不是本仓库的源码。
     * 一次发布做过 deploy/ 之后，lint 把副本里的代码也扫了一遍，
     * 于是「代码风格」这一步突然红了两百多条——报的不是本仓库的问题，
     * 却会让一键验证整体失败。分发目录在这里一次性排除。
     */
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '.data/**',
      'docs/**/*.html',
      'deploy/**',
      'delivery/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      // 全局符号（console/process/window 等）由 TypeScript 与 lib 定义负责，ESLint 不重复检查
      'no-undef': 'off',
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
    },
  },
  {
    // 运维脚本直接跑在 Node 上，允许 console，并显式声明运行时全局
    files: ['scripts/**/*.mjs', 'scripts/**/*.ts'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      'no-undef': 'off',
    },
  },
  {
    files: ['src/web/**/*.{ts,tsx}'],
    rules: {
      'no-console': 'off',
    },
  },
);
