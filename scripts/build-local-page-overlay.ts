import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rootDir = process.cwd();
const generatedPath = join(rootDir, 'src', 'scripts', 'local_page_overlay.js');
const tempDir = mkdtempSync(join(tmpdir(), 'weixin-reader-overlay-'));
const tempPath = join(tempDir, 'local_page_overlay.js');

// [atreader] WebKit 兼容守卫：详见 docs/WEBKIT_COMPATIBILITY.md（与 build-inject 同款）。
const assertWebkitCompatible = (label: string, code: string): void => {
  if (/\(\?<(?![A-Za-z])/.test(code)) {
    throw new Error(
      `${label} 含旧 WebKit（Safari < 16.4）无法解析的正则语法（lookbehind 或非 ASCII 命名组），已中止。详见 docs/WEBKIT_COMPATIBILITY.md`,
    );
  }
  for (const api of [
    'Object.groupBy',
    'Map.groupBy',
    'withResolvers',
    'AbortSignal.any',
    'Promise.try',
    'RegExp.escape',
    'Array.fromAsync',
    '.toSorted(',
    '.toReversed(',
    '.toSpliced(',
  ]) {
    if (code.includes(api)) {
      throw new Error(
        `${label} 含旧 WebKit 缺失的 API：${api}（Safari 17.4+ / 16+），已中止。详见 docs/WEBKIT_COMPATIBILITY.md 禁用清单`,
      );
    }
  }
};

try {
  const build = spawnSync(
    process.execPath,
    [
      'build',
      'src/scripts/local_page_overlay.ts',
      `--outfile=${tempPath}`,
      '--target=browser',
      // 以经典 <script> 加载：IIFE 防顶层声明泄漏成页面全局
      '--format=iife',
      '--minify-whitespace',
    ],
    { cwd: rootDir, stdio: 'inherit' },
  );
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }

  assertWebkitCompatible('local_page_overlay.js', readFileSync(tempPath, 'utf8'));

  const status = spawnSync(
    'git',
    ['status', '--porcelain', '--', 'src/scripts/local_page_overlay.js'],
    { cwd: rootDir, encoding: 'utf8' },
  );
  if (status.status !== 0) {
    throw new Error(status.stderr || '无法读取 local_page_overlay.js 的 Git 状态');
  }

  const trackedDirty = status.stdout.trim().length > 0;
  if (trackedDirty) {
    if (!existsSync(generatedPath)) {
      copyFileSync(tempPath, generatedPath);
      console.log('local_page_overlay.js 已从 local_page_overlay.ts 重新生成（原文件缺失）。');
    } else {
      const current = readFileSync(generatedPath);
      const generated = readFileSync(tempPath);
      if (!current.equals(generated)) {
        throw new Error(
          'src/scripts/local_page_overlay.js 已有未提交修改，且与 local_page_overlay.ts 的生成结果不一致；未覆盖该文件。',
        );
      }
      console.log('local_page_overlay.js 已修改但与生成结果一致，保留现有文件。');
    }
  } else {
    copyFileSync(tempPath, generatedPath);
    console.log('local_page_overlay.js 已从 local_page_overlay.ts 生成。');
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
