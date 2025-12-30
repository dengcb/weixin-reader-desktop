
import { rmSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const rootDir = process.cwd();

// 1. Define paths to clear
const pathsToClear = [
    // Root release directory
    join(rootDir, 'release'),
    
    // Tauri build artifacts (bundles) where app and dmg are stored
    join(rootDir, 'src-tauri', 'target', 'aarch64-apple-darwin', 'release', 'bundle'),
    join(rootDir, 'src-tauri', 'target', 'x86_64-apple-darwin', 'release', 'bundle'),
];

console.log('🧹 Starting cleanup...');

// 2. Remove directories
pathsToClear.forEach(path => {
    if (existsSync(path)) {
        try {
            console.log(`   Removing: ${path}`);
            rmSync(path, { recursive: true, force: true });
        } catch (e) {
            console.error(`   ❌ Failed to remove ${path}:`, e);
        }
    } else {
        console.log(`   ℹ️  Path not found (already clean): ${path}`);
    }
});

console.log('✅ Cleanup finished.');

// 3. Run sync-version
console.log('\n🔄 Running sync-version...');
try {
    execSync('bun src/scripts/sync_version.ts', { stdio: 'inherit' });
} catch (e) {
    console.error('❌ sync-version failed:', e);
    process.exit(1);
}
