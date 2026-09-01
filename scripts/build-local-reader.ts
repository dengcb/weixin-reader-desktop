import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rootDir = process.cwd();
const generatedPath = join(rootDir, 'src', 'scripts', 'local_reader.js');
const bootstrapSourcePath = join(rootDir, 'src', 'local-reader', 'bootstrap.ts');
const bootstrapGeneratedPath = join(rootDir, 'src', 'scripts', 'local_reader_bootstrap.js');
const tempDir = mkdtempSync(join(tmpdir(), 'atreader-local-reader-'));
const tempPath = join(tempDir, 'local_reader.js');
const bootstrapTempPath = join(tempDir, 'local_reader_bootstrap.js');

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
      'src/local-reader/index.ts',
      `--outfile=${tempPath}`,
      '--target=browser',
      '--format=iife',
      '--minify-whitespace',
    ],
    { cwd: rootDir, stdio: 'inherit' },
  );
  if (build.status !== 0) process.exit(build.status ?? 1);

  const bootstrapBuild = spawnSync(
    process.execPath,
    [
      'build',
      bootstrapSourcePath,
      `--outfile=${bootstrapTempPath}`,
      '--target=browser',
      '--format=iife',
      '--minify-whitespace',
    ],
    { cwd: rootDir, stdio: 'inherit' },
  );
  if (bootstrapBuild.status !== 0) process.exit(bootstrapBuild.status ?? 1);

  assertWebkitCompatible('local_reader.js', readFileSync(tempPath, 'utf8'));
  assertWebkitCompatible('local_reader_bootstrap.js', readFileSync(bootstrapTempPath, 'utf8'));

  const status = spawnSync('git', ['status', '--porcelain', '--', 'src/scripts/local_reader.js'], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  if (status.status !== 0) {
    throw new Error(status.stderr || '无法读取 local_reader.js 的 Git 状态');
  }

  const generatedIsUntracked = status.stdout.trimStart().startsWith('??');
  if (status.stdout.trim() && !generatedIsUntracked && existsSync(generatedPath)) {
    const current = readFileSync(generatedPath);
    const generated = readFileSync(tempPath);
    if (!current.equals(generated)) {
      throw new Error(
        'src/scripts/local_reader.js 已有未提交修改，且与 TypeScript 生成结果不一致；未覆盖该文件。',
      );
    }
    console.log('local_reader.js 已修改但与生成结果一致，保留现有文件。');
  } else {
    copyFileSync(tempPath, generatedPath);
    console.log('local_reader.js 已从 src/local-reader/index.ts 生成。');
  }
  copyFileSync(bootstrapTempPath, bootstrapGeneratedPath);
  console.log('local_reader_bootstrap.js 已从 src/local-reader/bootstrap.ts 生成。');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
