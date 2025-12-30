import { execSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, copyFileSync, readFileSync } from 'fs';
import { join } from 'path';

const rootDir = process.cwd();
const srcTauriDir = join(rootDir, 'src-tauri');

// 将绝对路径转换为相对路径（用于日志显示）
function relPath(absPath: string): string {
    return absPath.replace(rootDir + '/', '').replace(rootDir, '.');
}

const args = process.argv.slice(2);
const command = args[0]; // 'arm' | 'intel' | undefined (default: arm)

let target = 'aarch64-apple-darwin';
if (command === 'intel') {
    target = 'x86_64-apple-darwin';
}

console.log(`🚀 Quick Debug Build for ${target}...`);
console.log(`⚠️  This will skip notarization and install to /Applications\n`);

const totalStart = performance.now();

try {
    // 1. Sync Version
    console.log('\n⏳ [Sync Version] Starting...');
    execSync('bun src/scripts/sync_version.ts', { stdio: 'inherit' });
    console.log('✅ [Sync Version] Finished');

    // 2. Build App
    console.log(`\n⏳ [Build for ${target}] Starting...`);
    const buildStart = performance.now();

    // Build without updater artifacts to save time
    execSync(`tauri build --target ${target}`, { stdio: 'inherit', env: { ...process.env } });

    const buildEnd = performance.now();
    console.log(`✅ [Build for ${target}] Finished in ${((buildEnd - buildStart) / 1000).toFixed(2)}s`);

    // 3. Find and Copy .app to /Applications
    const targetBundleDir = join(srcTauriDir, 'target', target, 'release', 'bundle', 'macos');
    const appFiles = readdirSync(targetBundleDir).filter(f => f.endsWith('.app'));

    if (appFiles.length === 0) {
        throw new Error(`No .app found in ${relPath(targetBundleDir)}`);
    }

    const appName = appFiles[0];
    const appSrcPath = join(targetBundleDir, appName);
    const appDestPath = '/Applications/' + appName;

    console.log(`\n⏳ [Install to /Applications] Starting...`);
    console.log(`   Source: ${appName}`);
    console.log(`   Target: ${appDestPath}`);

    // Remove existing app if present
    if (existsSync(appDestPath)) {
        console.log(`   Removing existing app...`);
        execSync(`rm -rf "${appDestPath}"`, { stdio: 'inherit' });
    }

    // Copy app
    console.log(`   Copying app...`);
    execSync(`cp -R "${appSrcPath}" "${appDestPath}"`, { stdio: 'inherit' });

    console.log('✅ [Install to /Applications] Finished');

    const totalEnd = performance.now();
    const totalSeconds = ((totalEnd - totalStart) / 1000).toFixed(2);

    console.log(`\n✨ All done! Total time: ${totalSeconds}s`);
    console.log(`\n📦 App installed at: ${appDestPath}`);
    console.log(`\n💡 Quick test: open "${appDestPath}"`);

} catch (error) {
    console.error('\n💥 Debug build failed!');
    process.exit(1);
}
