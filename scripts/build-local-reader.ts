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
