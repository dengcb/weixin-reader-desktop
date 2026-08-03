import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';

const rootDir = process.cwd();
const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')) as {
  version: string;
};
const version = packageJson.version;
const tag = process.env.RELEASE_TAG ?? `v${version}`;
const commit = process.env.GITHUB_SHA ?? '';

// 支持 x86_64 和 aarch64 两个 target，通过 STAGE_TARGET 环境变量传入
const target = process.env.STAGE_TARGET ?? 'x86_64-pc-windows-msvc';
const archLabel = target.startsWith('aarch64') ? 'aarch64' : 'x86_64';
const platformLabel = `windows-${archLabel}`;
const infoFileName = `windows-${archLabel}-release-info.json`;

const bundleDir = join(
  rootDir,
  'src-tauri',
  'target',
  target,
  'release',
  'bundle',
  'nsis',
);
const outputDir = join(rootDir, 'release', 'windows');
const maxBytes = 30 * 1024 * 1024;

function fail(message: string): never {
  console.error(`Windows 发布产物校验失败：${message}`);
  process.exit(1);
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function assertSize(path: string): number {
  const size = statSync(path).size;
  console.log(`${basename(path)}: ${(size / 1024 / 1024).toFixed(2)} MiB`);
  if (size > maxBytes) {
    fail(`${basename(path)} 超过 30 MiB 上限`);
  }
  return size;
}

if (!existsSync(bundleDir)) {
  fail(`未找到 NSIS 目录：${bundleDir}`);
}

const files = readdirSync(bundleDir).sort();
const installers = files.filter((file) => file.endsWith('.exe'));
if (installers.length !== 1) {
  fail(`期望恰好一个 NSIS setup.exe，实际找到 ${installers.length} 个`);
}

const sourceInstaller = join(bundleDir, installers[0]);
const sourceInstallerSignature = `${sourceInstaller}.sig`;
if (!existsSync(sourceInstallerSignature)) {
  fail(`缺少 Tauri updater 签名：${basename(sourceInstallerSignature)}`);
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

const installerName = `weixin-reader-${version}-windows-${archLabel}-setup.exe`;
const signatureName = `${installerName}.sig`;
const installerPath = join(outputDir, installerName);
const signaturePath = join(outputDir, signatureName);
copyFileSync(sourceInstaller, installerPath);
copyFileSync(sourceInstallerSignature, signaturePath);

const installerSize = assertSize(installerPath);
const installerSha256 = sha256(installerPath);
const checksumName = `weixin-reader-${version}-windows-${archLabel}-SHA256SUMS.txt`;
writeFileSync(join(outputDir, checksumName), `${installerSha256}  ${installerName}\n`);

const info = {
  version,
  tag,
  commit,
  target,
  platform: platformLabel,
  authenticodeStatus: 'Unknown',
  installerAsset: installerName,
  updaterAsset: installerName,
  signatureAsset: signatureName,
  checksumAsset: checksumName,
  installerSize,
  updaterSize: installerSize,
  installerSha256,
};
writeFileSync(join(outputDir, infoFileName), `${JSON.stringify(info, null, 2)}\n`);

console.log(`SHA-256: ${installerSha256}`);
console.log(`已整理 Windows ${archLabel} 发布产物：${outputDir}`);
