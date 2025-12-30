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
        console.log(`Syncing version in Tauri from ${tauriConfig.version} to ${version}...`);
        tauriConfig.version = version;
        writeFileSync(tauriConfigPath, JSON.stringify(tauriConfig, null, 2));
        console.log('Tauri synced successfully.');
    } else {
        console.log('Tauri version is already in sync.');
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
             console.log(`Syncing version in README from ${match[2]} to ${version}...`);
             readmeContent = readmeContent.replace(readmeVersionRegex, `$1${version}$3`);
             writeFileSync(readmePath, readmeContent);
             console.log('README synced successfully.');
        } else {
             console.log('README version is already in sync.');
         }
     }

    // Sync src-tauri/Cargo.toml
    const cargoTomlPath = join(rootDir, 'src-tauri', 'Cargo.toml');
    let cargoTomlContent = readFileSync(cargoTomlPath, 'utf-8');
    // Match version = "0.1.0" or similar
    const cargoVersionRegex = /^version\s*=\s*"([\d\.]+)"/m;

    if (cargoVersionRegex.test(cargoTomlContent)) {
        const match = cargoTomlContent.match(cargoVersionRegex);
        if (match && match[1] !== version) {
             console.log(`Syncing version in Cargo from ${match[1]} to ${version}...`);
             cargoTomlContent = cargoTomlContent.replace(cargoVersionRegex, `version = "${version}"`);
             writeFileSync(cargoTomlPath, cargoTomlContent);
             console.log('Cargo synced successfully.');
        } else {
             console.log('Cargo version is already in sync.');
        }
    }

 } catch (error) {
    console.error('Error syncing version:', error);
    process.exit(1);
}
