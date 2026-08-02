import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const rootDir = process.cwd();
const checkOnly = process.argv.includes('--check');

const packageJsonPath = join(rootDir, 'package.json');
const tauriConfigPath = join(rootDir, 'src-tauri', 'tauri.conf.json');
const cargoTomlPath = join(rootDir, 'src-tauri', 'Cargo.toml');
const cargoLockPath = join(rootDir, 'src-tauri', 'Cargo.lock');
const readmePath = join(rootDir, 'README.md');

const cargoVersionRegex = /^(version\s*=\s*")([0-9]+\.[0-9]+\.[0-9]+)(")/m;
const lockPackageRegex = /(\[\[package\]\]\nname = "weixin-reader"\nversion = ")([^"]+)(")/;
const readmeVersionRegex = /(img\.shields\.io\/badge\/release-v)([0-9]+\.[0-9]+\.[0-9]+)(-)/;

interface VersionTarget {
  name: string;
  current: string | undefined;
  write: () => void;
}

function replaceRequired(content: string, pattern: RegExp, replacement: string, name: string): string {
  if (!pattern.test(content)) {
    throw new Error(`无法在 ${name} 中定位版本字段`);
  }
  return content.replace(pattern, replacement);
}

try {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
  const version = packageJson.version;
  if (!version || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
    throw new Error('package.json.version 必须是 x.y.z 格式');
  }

  const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, 'utf8')) as { version?: string };
  const cargoToml = readFileSync(cargoTomlPath, 'utf8');
  const cargoLock = readFileSync(cargoLockPath, 'utf8');
  const readme = readFileSync(readmePath, 'utf8');

  const targets: VersionTarget[] = [
    {
      name: 'src-tauri/tauri.conf.json',
      current: tauriConfig.version,
      write: () => {
        tauriConfig.version = version;
        writeFileSync(tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`);
      },
    },
    {
      name: 'src-tauri/Cargo.toml',
      current: cargoToml.match(cargoVersionRegex)?.[2],
      write: () => {
        const updated = replaceRequired(cargoToml, cargoVersionRegex, `$1${version}$3`, 'src-tauri/Cargo.toml');
        writeFileSync(cargoTomlPath, updated);
      },
    },
    {
      name: 'src-tauri/Cargo.lock 根包',
      current: cargoLock.match(lockPackageRegex)?.[2],
      write: () => {
        const updated = replaceRequired(cargoLock, lockPackageRegex, `$1${version}$3`, 'src-tauri/Cargo.lock');
        writeFileSync(cargoLockPath, updated);
      },
    },
    {
      name: 'README.md release badge',
      current: readme.match(readmeVersionRegex)?.[2],
      write: () => {
        const updated = replaceRequired(readme, readmeVersionRegex, `$1${version}$3`, 'README.md');
        writeFileSync(readmePath, updated);
      },
    },
  ];

  const mismatches = targets.filter((target) => target.current !== version);
  if (mismatches.length === 0) {
    console.log(`版本一致：${version}`);
    process.exit(0);
  }

  if (checkOnly) {
    for (const target of mismatches) {
      console.error(`版本不一致：${target.name}=${target.current ?? '<missing>'}，期望 ${version}`);
    }
    process.exit(1);
  }

  for (const target of mismatches) {
    console.log(`同步 ${target.name}：${target.current ?? '<missing>'} -> ${version}`);
    target.write();
  }
  console.log(`版本同步完成：${version}`);
} catch (error) {
  console.error('版本同步失败：', error);
  process.exit(1);
}
