import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rootDir = process.cwd();
const generatedPath = join(rootDir, 'src', 'scripts', 'inject.js');
const tempDir = mkdtempSync(join(tmpdir(), 'weixin-reader-inject-'));
const tempPath = join(tempDir, 'inject.js');

// [atreader] WebKit 兼容守卫：详见 docs/WEBKIT_COMPATIBILITY.md。
// (?< 后非 ASCII 字母涵盖 lookbehind（(?<= / (?<!)）与非 ASCII 命名组，
// 两者均会让 Safari < 16.4 的 WebKit 在脚本解析阶段抛 SyntaxError，整页白屏。
// 若因字符串字面量误报，改写为 '\\(\\?<' 拼接形式规避，不要移除守卫。
const assertWebkitCompatible = (label: string, code: string): void => {
  if (/\(\?<(?![A-Za-z])/.test(code)) {
    throw new Error(
      `${label} 含旧 WebKit（Safari < 16.4）无法解析的正则语法（lookbehind 或非 ASCII 命名组），已中止。详见 docs/WEBKIT_COMPATIBILITY.md`,
    );
  }
  // Safari < 17.4 及其他缺失 API 黑名单（完整清单见 docs/WEBKIT_COMPATIBILITY.md）。
  // 字符串字面量误报时改写拼接规避，不要移除守卫。
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
      'src/scripts/inject.ts',
      `--outfile=${tempPath}`,
      '--target=browser',
      '--minify-whitespace',
    ],
    { cwd: rootDir, stdio: 'inherit' },
  );
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }

  assertWebkitCompatible('inject.js', readFileSync(tempPath, 'utf8'));

  const status = spawnSync('git', ['status', '--porcelain', '--', 'src/scripts/inject.js'], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  if (status.status !== 0) {
    throw new Error(status.stderr || '无法读取 inject.js 的 Git 状态');
  }

  const trackedDirty = status.stdout.trim().length > 0;
  if (trackedDirty) {
    const current = readFileSync(generatedPath);
    const generated = readFileSync(tempPath);
    if (!current.equals(generated)) {
      throw new Error(
        'src/scripts/inject.js 已有未提交修改，且与 inject.ts 的生成结果不一致；未覆盖该文件。',
      );
    }
    console.log('inject.js 已修改但与生成结果一致，保留现有文件。');
  } else {
    copyFileSync(tempPath, generatedPath);
    console.log('inject.js 已从 inject.ts 生成。');
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
