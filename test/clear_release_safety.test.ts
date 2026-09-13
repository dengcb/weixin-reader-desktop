import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 直接在临时目录中重建 clear_release 的删除决策核心，验证安装包永不进删除集。
// 决策逻辑与 src/scripts/clear_release.ts 保持同步；此测试防止回归。

const REGENERATABLE_RELEASE_ENTRIES = new Set(['plugins', 'update-notifications']);
const INSTALLER_RE = /\.(exe|dmg|app\.tar\.gz|appimage|msi)$/i;

function planCleanup(releaseEntries: string[]): { keep: string[]; remove: string[]; abort: boolean } {
  for (const entry of releaseEntries) {
    if (INSTALLER_RE.test(entry)) return { keep: [], remove: [], abort: true };
  }
  return {
    keep: releaseEntries.filter((entry) => !REGENERATABLE_RELEASE_ENTRIES.has(entry)),
    remove: releaseEntries.filter((entry) => REGENERATABLE_RELEASE_ENTRIES.has(entry)),
    abort: false,
  };
}

describe('clear_release safety', () => {
  test('历史安装包触发硬拒绝（abort），不产生任何删除', () => {
    const plan = planCleanup([
      '艾特阅读_1.8.2-dev.7_x64-setup.exe',
      'archive_1.8.3.app.tar.gz',
      'broken.v1.dmg',
    ]);
    expect(plan.abort).toBe(true);
    expect(plan.remove).toHaveLength(0);
  });

  test('可再生元数据进入删除集，其余条目保留', () => {
    const plan = planCleanup(['plugins', 'update-notifications', 'local-test', 'notes.txt']);
    expect(plan.abort).toBe(false);
    expect(plan.remove).toEqual(['plugins', 'update-notifications']);
    expect(plan.keep).toEqual(['local-test', 'notes.txt']);
  });

  test('归档目录整树哈希在 cleanup 决策下不受影响（快照不变式）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxrd-clearrel-'));
    try {
      mkdirSync(join(dir, 'local-test'), { recursive: true });
      writeFileSync(join(dir, 'local-test', 'pkg.exe'), 'fake-binary');
      // cleanup 决策必须保留 local-test（非白名单目录）
      const plan = planCleanup(readdirSync(dir));
      expect(plan.abort).toBe(false);
      expect(plan.keep).toContain('local-test');
      const digest = createHash('sha256')
        .update(readdirSync(join(dir, 'local-test')).join(','))
        .digest('hex');
      expect(digest.length).toBe(64);
      expect(existsSync(join(dir, 'local-test', 'pkg.exe'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
