import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const rootDir = process.cwd();
const packageJsonPath = join(rootDir, 'package.json');
const tauriConfigPath = join(rootDir, 'src-tauri', 'tauri.conf.json');

try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const version = packageJson.version;

    const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, 'utf-8'));
    
    if (tauriConfig.version !== version) {
        console.log(`Syncing version from package.json (${version}) to tauri.conf.json (${tauriConfig.version})...`);
        tauriConfig.version = version;
        writeFileSync(tauriConfigPath, JSON.stringify(tauriConfig, null, 2));
        console.log('Version synced successfully.');
    } else {
        console.log('Version is already in sync.');
    }

    // Sync README.md
    const readmePath = join(rootDir, 'README.md');
    let readmeContent = readFileSync(readmePath, 'utf-8');
    
    // Regex to match the release badge url part: release-v<version>-<color>
    // Matches: https://img.shields.io/badge/release-v0.2.0-orange
    const readmeVersionRegex = /(img\.shields\.io\/badge\/release-v)([\d\.]+)(-)/;
    
    if (readmeVersionRegex.test(readmeContent)) {
        const match = readmeContent.match(readmeVersionRegex);
        if (match && match[2] !== version) {
             console.log(`Syncing version in README.md from ${match[2]} to ${version}...`);
             readmeContent = readmeContent.replace(readmeVersionRegex, `$1${version}$3`);
             writeFileSync(readmePath, readmeContent);
             console.log('README.md synced successfully.');
        } else {
             console.log('README.md version is already in sync.');
        }
    }
} catch (error) {
    console.error('Error syncing version:', error);
    process.exit(1);
}
