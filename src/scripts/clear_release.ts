
import { rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const rootDir = process.cwd();

// 归档目录规则（2026-09-11 用户裁定）：release/ 的历史安装包是用户逐版本
// 真机测试与回退的依据，只增不删。此脚本只允许清理「构建 bundle」与
// release/ 内可再生成的元数据（plugins/、update-notifications 等），
// 绝不允许触碰 release/ 根下的任何安装包（*.exe/*.dmg/*.app.tar.gz）。
const BUNDLE_DIRS = [
    join(rootDir, 'src-tauri', 'target', 'bundle'),
    join(rootDir, 'src-tauri', 'target', 'aarch64-apple-darwin', 'release', 'bundle'),
    join(rootDir, 'src-tauri', 'target', 'x86_64-apple-darwin', 'release', 'bundle'),
    join(rootDir, 'src-tauri', 'target', 'x86_64-pc-windows-msvc', 'release', 'bundle'),
    join(rootDir, 'src-tauri', 'target', 'release', 'bundle'),
];

// release/ 下可删除的再生元数据；安装包后缀在 isInstaller 中被硬性拒绝。
const REGENERATABLE_RELEASE_ENTRIES = new Set(['plugins', 'update-notifications']);
const INSTALLER_RE = /\.(exe|dmg|app\.tar\.gz|appimage|msi)$/i;

const isInstaller = (name: string): boolean => INSTALLER_RE.test(name);

console.log('🧹 Starting cleanup (installers are never touched)...');

// 1. 构建产物目录：整目录删除
for (const dir of BUNDLE_DIRS) {
    if (existsSync(dir)) {
        console.log(`   Removing bundle: ${dir}`);
        rmSync(dir, { recursive: true, force: true });
    }
}

// 2. release/：仅删除白名单子项，且遇到安装包文件名立即中止
const releaseDir = join(rootDir, 'release');
if (existsSync(releaseDir)) {
    for (const entry of readdirSync(releaseDir)) {
        if (isInstaller(entry)) {
            console.error(`   🛑 拒绝删除安装包：${entry}（历史包永不删除，见 release 归档规则）`);
            process.exit(1);
        }
        if (REGENERATABLE_RELEASE_ENTRIES.has(entry)) {
            console.log(`   Removing release entry: ${entry}`);
            rmSync(join(releaseDir, entry), { recursive: true, force: true });
        } else {
            console.log(`   Keeping release entry: ${entry}`);
        }
    }
} else {
    console.log('   ℹ️  release/ not found (nothing to clean)');
}

console.log('✅ Cleanup finished.');

// 3. Run sync-version
console.log('\n🔄 Running sync-version...');
try {
    execSync('bun src/scripts/sync_version.ts', { stdio: 'inherit' });
} catch (e) {
    console.error('❌ sync-version failed:', e);
    process.exit(1);
}
