import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rootDir = process.cwd();
const generatedPath = join(rootDir, 'src', 'scripts', 'inject.js');
const tempDir = mkdtempSync(join(tmpdir(), 'weixin-reader-inject-'));
const tempPath = join(tempDir, 'inject.js');

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
