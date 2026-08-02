import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { normalizeUpdaterSignature, verifyUpdaterSignature } from './release_signature';

const rootDir = process.cwd();
const releaseDir = join(rootDir, 'release');
const metadataPath = join(releaseDir, 'release-metadata.json');
const srcTauriDir = join(rootDir, 'src-tauri');
const owner = 'dengcb';
const repo = 'weixin-reader-desktop';
const workflowFile = 'release.yml';
const repoUrl = `https://github.com/${owner}/${repo}`;

const macTargets = {
  'aarch64-apple-darwin': { platform: 'darwin-aarch64', arch: 'aarch64' },
  'x86_64-apple-darwin': { platform: 'darwin-x86_64', arch: 'x86_64' },
} as const;

type MacTarget = keyof typeof macTargets;
type MacPlatform = (typeof macTargets)[MacTarget]['platform'];

interface ArtifactRecord {
  name: string;
  size: number;
  sha256: string;
}

interface MacReleaseRecord {
  target: MacTarget;
  installer: ArtifactRecord;
  updater: ArtifactRecord;
  signature: ArtifactRecord;
}

interface ReleaseMetadata {
  version: string;
  tag: string;
  commit: string;
  createdAt: string;
  tools: {
    bun: string;
    rust: string;
    tauriCli: string;
  };
  platforms: Record<MacPlatform, MacReleaseRecord>;
}

interface GitHubAsset {
  id: number;
  name: string;
  size: number;
  url: string;
  browser_download_url: string;
  digest?: string | null;
}

interface GitHubRelease {
  id: number;
  tag_name: string;
  target_commitish: string;
  draft: boolean;
  url: string;
  html_url: string;
  upload_url: string;
  body: string | null;
  assets: GitHubAsset[];
}

interface WorkflowRun {
  id: number;
  event: string;
  head_branch: string | null;
  head_sha: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  html_url: string;
}

interface WindowsReleaseInfo {
  version: string;
  tag: string;
  commit: string;
  platform: 'windows-x86_64';
  authenticodeStatus: string;
  installerAsset: string;
  updaterAsset: string;
  signatureAsset: string;
  checksumAsset: string;
  installerSize: number;
  updaterSize: number;
  installerSha256: string;
}

class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function packageVersion(): string {
  const parsed = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')) as { version: string };
  return parsed.version;
}

function relPath(path: string): string {
  return path.startsWith(rootDir) ? `.${path.slice(rootDir.length)}` : path;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function artifact(path: string): ArtifactRecord {
  return {
    name: basename(path),
    size: statSync(path).size,
    sha256: sha256(path),
  };
}

function commandOutput(command: string, args: string[]): string {
  return execFileSync(command, args, { cwd: rootDir, encoding: 'utf8' }).trim();
}

async function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const child = spawn(command, args, {
    cwd: rootDir,
    env,
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: false,
  });
  const escapedRoot = rootDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rootRegex = new RegExp(escapedRoot, 'g');
  child.stdout?.on('data', (data) => process.stdout.write(data.toString().replace(rootRegex, '.')));
  child.stderr?.on('data', (data) => process.stderr.write(data.toString().replace(rootRegex, '.')));
  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} 退出码 ${code}`));
    });
  });
}

async function runStep(name: string, task: () => Promise<void>): Promise<void> {
  const startedAt = performance.now();
  console.log(`\n[${name}]`);
  await task();
  console.log(`[${name}] 完成，用时 ${((performance.now() - startedAt) / 1000).toFixed(2)}s`);
}

function requireReleaseCredentials(formalRelease: boolean): void {
  const applePassword = process.env.APPLE_APP_SPECIFIC_PASSWORD || process.env.APPLE_PASSWORD;
  const missingApple = [
    !process.env.APPLE_ID && 'APPLE_ID',
    !applePassword && 'APPLE_APP_SPECIFIC_PASSWORD 或 APPLE_PASSWORD',
    !process.env.APPLE_TEAM_ID && 'APPLE_TEAM_ID',
  ].filter(Boolean);
  const missingUpdater = !process.env.TAURI_SIGNING_PRIVATE_KEY;

  if (formalRelease && (missingApple.length > 0 || missingUpdater)) {
    const missing = [
      ...missingApple,
      ...(missingUpdater ? ['TAURI_SIGNING_PRIVATE_KEY'] : []),
    ].join('、');
    throw new Error(`正式发布缺少签名或公证凭据：${missing}`);
  }
  if (!formalRelease && (missingApple.length > 0 || missingUpdater)) {
    console.warn('单架构诊断构建缺少部分正式发布凭据，Tauri 可能拒绝 bundle。');
  }
  if (applePassword) process.env.APPLE_PASSWORD = applePassword;
  if (process.env.TAURI_SIGNING_PRIVATE_KEY && process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) {
    process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '';
  }
}

async function runPreflight(): Promise<void> {
  const commands: Array<[string, string[]]> = [
    [process.execPath, ['install', '--frozen-lockfile']],
    [process.execPath, ['run', 'check:version']],
    [process.execPath, ['run', 'check:frozen']],
    [process.execPath, ['run', 'typecheck']],
    [process.execPath, ['test']],
    [process.execPath, ['run', 'check:ipc']],
    ['cargo', ['fmt', '--manifest-path', 'src-tauri/Cargo.toml', '--check']],
    [
      'cargo',
      [
        'clippy',
        '--manifest-path',
        'src-tauri/Cargo.toml',
        '--all-targets',
        '--all-features',
        '--locked',
        '--',
        '-D',
        'warnings',
      ],
    ],
    ['cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked']],
    ['cargo', ['check', '--manifest-path', 'src-tauri/Cargo.toml', '--locked']],
  ];
  for (const [command, args] of commands) {
    await runCommand(command, args);
  }
}

function findSingleFile(directory: string, predicate: (name: string) => boolean, label: string): string {
  if (!existsSync(directory)) throw new Error(`未找到 ${label} 目录：${relPath(directory)}`);
  const matches = readdirSync(directory).filter(predicate).sort();
  if (matches.length !== 1) {
    throw new Error(`${relPath(directory)} 中应恰好有一个 ${label}，实际 ${matches.length} 个`);
  }
  return join(directory, matches[0]);
}

function collectMacArtifacts(target: MacTarget, buildStartedAt: number): MacReleaseRecord {
  const { arch } = macTargets[target];
  const bundleDir = join(srcTauriDir, 'target', target, 'release', 'bundle');
  const dmgSource = findSingleFile(join(bundleDir, 'dmg'), (name) => name.endsWith('.dmg'), 'DMG');
  const macosDir = join(bundleDir, 'macos');
  const updaterSource = findSingleFile(
    macosDir,
    (name) =>
      (name.endsWith('.tar.gz') || name.endsWith('.zip') || name.endsWith('.tar.zst')) &&
      existsSync(join(macosDir, `${name}.sig`)),
    'updater archive',
  );
  const updaterSignatureSource = `${updaterSource}.sig`;
  for (const path of [dmgSource, updaterSource, updaterSignatureSource]) {
    if (statSync(path).mtimeMs < buildStartedAt - 2_000) {
      throw new Error(`拒绝使用本次构建前的旧产物：${relPath(path)}`);
    }
  }

  mkdirSync(releaseDir, { recursive: true });
  const version = packageVersion();
  const updaterName = basename(updaterSource);
  const suffix = updaterName.endsWith('.tar.gz')
    ? '.app.tar.gz'
    : updaterName.endsWith('.tar.zst')
      ? '.app.tar.zst'
      : '.app.zip';
  const installerPath = join(releaseDir, `weixin-reader-${version}-${arch}.dmg`);
  const updaterPath = join(releaseDir, `weixin-reader-${version}-${arch}${suffix}`);
  const signaturePath = `${updaterPath}.sig`;
  copyFileSync(dmgSource, installerPath);
  copyFileSync(updaterSource, updaterPath);
  copyFileSync(updaterSignatureSource, signaturePath);

  return {
    target,
    installer: artifact(installerPath),
    updater: artifact(updaterPath),
    signature: artifact(signaturePath),
  };
}

async function notarizeAndStaple(record: MacReleaseRecord): Promise<void> {
  const dmgPath = join(releaseDir, record.installer.name);
  const applePassword = process.env.APPLE_APP_SPECIFIC_PASSWORD || process.env.APPLE_PASSWORD;
  if (!process.env.APPLE_ID || !applePassword || !process.env.APPLE_TEAM_ID) {
    console.warn(`跳过 ${record.installer.name} 的 DMG 公证；这是诊断产物，不能正式上传。`);
    return;
  }
  await runCommand('xcrun', [
    'notarytool',
    'submit',
    dmgPath,
    '--apple-id',
    process.env.APPLE_ID,
    '--password',
    applePassword,
    '--team-id',
    process.env.APPLE_TEAM_ID,
    '--wait',
  ]);
  await runCommand('xcrun', ['stapler', 'staple', dmgPath]);
  record.installer = artifact(dmgPath);
}

async function runBuild(targets: MacTarget[]): Promise<void> {
  const formalRelease = targets.length === 2;
  requireReleaseCredentials(formalRelease);
  if (formalRelease) {
    await runStep('正式发布 preflight', runPreflight);
  } else {
    await runStep('版本检查', () => runCommand(process.execPath, ['run', 'check:version']));
  }

  const records = {} as Record<MacPlatform, MacReleaseRecord>;
  for (const target of targets) {
    const buildStartedAt = Date.now();
    await runStep(`构建 ${target}`, () =>
      runCommand(process.execPath, ['run', 'tauri', 'build', '--target', target, '--', '--locked']),
    );
    const record = collectMacArtifacts(target, buildStartedAt);
    await runStep(`公证并 stapling ${record.installer.name}`, () => notarizeAndStaple(record));
    records[macTargets[target].platform] = record;
  }

  if (!formalRelease) {
    console.log('\n单架构诊断构建完成；这些产物不会生成正式发布元数据，不能用于 release:upload。');
    return;
  }

  const version = packageVersion();
  const metadata: ReleaseMetadata = {
    version,
    tag: `v${version}`,
    commit: commandOutput('git', ['rev-parse', 'HEAD']),
    createdAt: new Date().toISOString(),
    tools: {
      bun: commandOutput(process.execPath, ['--version']),
      rust: commandOutput('rustc', ['--version']),
      tauriCli: commandOutput(process.execPath, ['run', 'tauri', '--version']).split('\n').slice(-1)[0] ?? '',
    },
    platforms: records,
  };
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(`\n正式 macOS 产物与元数据已写入 ${relPath(releaseDir)}。`);
  console.log('下一步：bun run release:upload');
}

function loadMetadata(): ReleaseMetadata {
  if (!existsSync(metadataPath)) {
    throw new Error('缺少 release/release-metadata.json，请先运行 bun run release:all');
  }
  return JSON.parse(readFileSync(metadataPath, 'utf8')) as ReleaseMetadata;
}

function validateLocalMetadata(metadata: ReleaseMetadata): void {
  const version = packageVersion();
  const commit = commandOutput('git', ['rev-parse', 'HEAD']);
  if (metadata.version !== version || metadata.tag !== `v${version}`) {
    throw new Error('release:all 元数据与当前 package.json.version 不一致');
  }
  if (metadata.commit !== commit) {
    throw new Error(`release:all 元数据 commit=${metadata.commit}，当前 commit=${commit}`);
  }
  const platforms = Object.keys(metadata.platforms).sort();
  const expected = ['darwin-aarch64', 'darwin-x86_64'];
  if (JSON.stringify(platforms) !== JSON.stringify(expected)) {
    throw new Error(`macOS 平台元数据不完整：${platforms.join(', ')}`);
  }
  for (const platform of expected as MacPlatform[]) {
    const record = metadata.platforms[platform];
    for (const value of [record.installer, record.updater, record.signature]) {
      const path = join(releaseDir, value.name);
      if (!existsSync(path)) throw new Error(`缺少本地发布产物：${value.name}`);
      if (statSync(path).size !== value.size || sha256(path) !== value.sha256) {
        throw new Error(`本地产物与 release:all 元数据不一致：${value.name}`);
      }
    }
  }
}

function assertTrackedClean(): void {
  const status = commandOutput('git', ['status', '--porcelain', '--untracked-files=no']);
  if (status) {
    throw new Error(`存在 tracked 未提交修改，拒绝创建 tag/release：\n${status}`);
  }
}

function token(): string {
  const value = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!value) throw new Error('缺少 GITHUB_TOKEN 或 GH_TOKEN');
  return value;
}

function githubHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${token()}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'weixin-reader-release-script',
    ...extra,
  };
}

async function githubRequest<T>(pathOrUrl: string, init: RequestInit = {}): Promise<T> {
  const url = pathOrUrl.startsWith('https://')
    ? pathOrUrl
    : `https://api.github.com/repos/${owner}/${repo}${pathOrUrl}`;
  const response = await fetch(url, {
    ...init,
    headers: { ...githubHeaders(), ...(init.headers ?? {}) },
  });
  if (!response.ok) {
    throw new GitHubApiError(
      response.status,
      `GitHub API ${response.status} ${response.statusText}: ${await response.text()}`,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function findRelease(tag: string): Promise<GitHubRelease | undefined> {
  const releases = await githubRequest<GitHubRelease[]>('/releases?per_page=100');
  return releases.find((release) => release.tag_name === tag);
}

async function tagCommit(tag: string): Promise<string | undefined> {
  try {
    const commit = await githubRequest<{ sha: string }>(`/commits/${encodeURIComponent(tag)}`);
    return commit.sha;
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return undefined;
    throw error;
  }
}

async function ensureTag(metadata: ReleaseMetadata): Promise<void> {
  const existing = await tagCommit(metadata.tag);
  if (existing && existing !== metadata.commit) {
    throw new Error(`远程 tag ${metadata.tag} 已指向 ${existing}，不是 ${metadata.commit}`);
  }
  if (!existing) {
    await githubRequest('/git/refs', {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/tags/${metadata.tag}`, sha: metadata.commit }),
    });
    console.log(`已创建 tag ${metadata.tag} -> ${metadata.commit}`);
  }
}

function releaseBody(version: string, authenticodeStatus = 'NotSigned'): string {
  const lines = [
    `艾特阅读 v${version}`,
    '',
    `[Code signing policy](${repoUrl}/blob/v${version}/docs/CODE_SIGNING_POLICY.md)`,
  ];
  if (authenticodeStatus !== 'Valid') {
    lines.push(
      '',
      '> Windows 安装包暂未进行 Authenticode 发布者签名，可能触发 SmartScreen“未知发布者”提示。',
      '> Windows 资产附带 SHA-256；Tauri updater 签名只用于更新完整性验证，不是 Windows 发布者签名。',
    );
  }
  return lines.join('\n');
}

async function ensureDraft(metadata: ReleaseMetadata): Promise<GitHubRelease> {
  const existing = await findRelease(metadata.tag);
  if (existing) {
    if (!existing.draft) throw new Error(`${metadata.tag} 已正式发布，拒绝覆盖`);
    const remoteCommit = await tagCommit(metadata.tag);
    if (remoteCommit !== metadata.commit) throw new Error('draft release 的 tag commit 不匹配');
    return existing;
  }
  return githubRequest<GitHubRelease>('/releases', {
    method: 'POST',
    body: JSON.stringify({
      tag_name: metadata.tag,
      target_commitish: metadata.commit,
      name: metadata.tag,
      body: releaseBody(metadata.version),
      draft: true,
      prerelease: false,
    }),
  });
}

async function deleteAssetIfPresent(release: GitHubRelease, name: string): Promise<void> {
  const existing = release.assets.find((asset) => asset.name === name);
  if (existing) await githubRequest(existing.url, { method: 'DELETE' });
}

async function uploadAsset(release: GitHubRelease, path: string): Promise<void> {
  const name = basename(path);
  await deleteAssetIfPresent(release, name);
  const uploadUrl = release.upload_url.split('{')[0];
  const bytes = readFileSync(path);
  const response = await fetch(`${uploadUrl}?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: githubHeaders({
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.length),
    }),
    body: new Uint8Array(bytes),
  });
  if (!response.ok) {
    throw new GitHubApiError(response.status, `上传 ${name} 失败：${await response.text()}`);
  }
  console.log(`已上传 ${name}`);
}

function macAssetNames(metadata: ReleaseMetadata): string[] {
  return (Object.values(metadata.platforms) as MacReleaseRecord[]).flatMap((record) => [
    record.installer.name,
    record.updater.name,
    record.signature.name,
  ]);
}

async function workflowRuns(): Promise<WorkflowRun[]> {
  const response = await githubRequest<{ workflow_runs: WorkflowRun[] }>(
    `/actions/workflows/${workflowFile}/runs?event=workflow_dispatch&per_page=50`,
  );
  return response.workflow_runs;
}

async function latestWindowsRun(metadata: ReleaseMetadata): Promise<WorkflowRun | undefined> {
  return (await workflowRuns())
    .filter(
      (run) =>
        run.event === 'workflow_dispatch' &&
        run.head_sha === metadata.commit &&
        (!run.head_branch || run.head_branch === metadata.tag) &&
        Date.parse(run.created_at) >= Date.parse(metadata.createdAt),
    )
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
}

async function runUpload(): Promise<void> {
  await runCommand(process.execPath, ['run', 'check:version']);
  assertTrackedClean();
  const metadata = loadMetadata();
  validateLocalMetadata(metadata);
  token();
  await ensureTag(metadata);
  const release = await ensureDraft(metadata);

  await deleteAssetIfPresent(release, 'latest.json');
  const uploadNames = ['release-metadata.json', ...macAssetNames(metadata)];
  for (const name of uploadNames) await uploadAsset(release, join(releaseDir, name));

  const dispatchedAt = Date.now();
  await githubRequest(`/actions/workflows/${workflowFile}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref: metadata.tag, inputs: { tag: metadata.tag } }),
  });
  console.log(`已触发 Windows workflow：${metadata.tag}`);

  for (let attempt = 0; attempt < 12; attempt += 1) {
    await Bun.sleep(1_500);
    const run = await latestWindowsRun(metadata);
    if (run && Date.parse(run.created_at) >= dispatchedAt - 5_000) {
      console.log(`Workflow run: ${run.html_url}`);
      console.log('等待其成功后运行 bun run release:status；确认资产后再运行 release:publish。');
      return;
    }
  }
  console.log(`Workflow 页面：${repoUrl}/actions/workflows/${workflowFile}`);
  console.log('dispatch 已接受，但 run 尚未出现在 API；稍后运行 bun run release:status。');
}

function requireAsset(release: GitHubRelease, name: string): GitHubAsset {
  const asset = release.assets.find((candidate) => candidate.name === name);
  if (!asset) throw new Error(`draft release 缺少资产：${name}`);
  return asset;
}

async function downloadAsset(asset: GitHubAsset): Promise<Uint8Array> {
  const response = await fetch(asset.url, {
    headers: githubHeaders({ Accept: 'application/octet-stream' }),
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`下载 ${asset.name} 失败：${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function readJsonAsset<T>(release: GitHubRelease, name: string): Promise<T> {
  const bytes = await downloadAsset(requireAsset(release, name));
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function metadataHashes(metadata: ReleaseMetadata): Map<string, string> {
  const result = new Map<string, string>();
  for (const record of Object.values(metadata.platforms) as MacReleaseRecord[]) {
    for (const value of [record.installer, record.updater, record.signature]) {
      result.set(value.name, value.sha256);
    }
  }
  return result;
}

async function runStatus(): Promise<void> {
  const metadata = loadMetadata();
  token();
  const release = await findRelease(metadata.tag);
  if (!release) throw new Error(`未找到 ${metadata.tag} release`);
  const run = await latestWindowsRun(metadata);
  console.log(
    run
      ? `Windows workflow: ${run.status}${run.conclusion ? ` / ${run.conclusion}` : ''}\n${run.html_url}`
      : 'Windows workflow: 未找到',
  );

  let windowsInfo: WindowsReleaseInfo | undefined;
  if (release.assets.some((asset) => asset.name === 'windows-release-info.json')) {
    windowsInfo = await readJsonAsset<WindowsReleaseInfo>(release, 'windows-release-info.json');
  }
  const hashes = metadataHashes(metadata);
  if (windowsInfo) hashes.set(windowsInfo.installerAsset, windowsInfo.installerSha256);
  console.table(
    release.assets.map((asset) => ({
      asset: asset.name,
      sizeMiB: (asset.size / 1024 / 1024).toFixed(2),
      sha256: asset.digest?.replace(/^sha256:/, '') ?? hashes.get(asset.name) ?? '—',
    })),
  );
  console.log(`Windows Authenticode: ${windowsInfo?.authenticodeStatus ?? '尚无 Windows 资产'}`);
  console.log(`Release 状态: ${release.draft ? 'draft' : 'published'}`);
}

async function verifyRemoteArtifact(
  asset: GitHubAsset,
  expectedSha256: string,
): Promise<Uint8Array> {
  const bytes = await downloadAsset(asset);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expectedSha256) {
    throw new Error(`${asset.name} 远程 SHA-256=${actual}，期望 ${expectedSha256}`);
  }
  return bytes;
}

async function updaterPlatform(
  release: GitHubRelease,
  updaterName: string,
  signatureName: string,
  expectedSha256: string,
): Promise<{ url: string; signature: string }> {
  const updaterAsset = requireAsset(release, updaterName);
  const signatureAsset = requireAsset(release, signatureName);
  const updater = await verifyRemoteArtifact(updaterAsset, expectedSha256);
  const rawSignature = new TextDecoder().decode(await downloadAsset(signatureAsset));
  const config = JSON.parse(
    readFileSync(join(srcTauriDir, 'tauri.conf.json'), 'utf8'),
  ) as { plugins: { updater: { pubkey: string } } };
  verifyUpdaterSignature(updater, rawSignature, config.plugins.updater.pubkey);
  const signature = normalizeUpdaterSignature(rawSignature);
  return { url: updaterAsset.browser_download_url, signature };
}

async function runPublish(): Promise<void> {
  await runCommand(process.execPath, ['run', 'check:version']);
  const metadata = loadMetadata();
  validateLocalMetadata(metadata);
  token();
  const run = await latestWindowsRun(metadata);
  if (!run || run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error(`Windows workflow 尚未成功：${run ? `${run.status}/${run.conclusion}` : '未找到'}`);
  }
  let release = await findRelease(metadata.tag);
  if (!release) throw new Error(`未找到 ${metadata.tag} release`);
  if (!release.draft) throw new Error(`${metadata.tag} 已经发布`);

  for (const name of macAssetNames(metadata)) requireAsset(release, name);
  const windows = await readJsonAsset<WindowsReleaseInfo>(release, 'windows-release-info.json');
  if (
    windows.version !== metadata.version ||
    windows.tag !== metadata.tag ||
    windows.commit !== metadata.commit ||
    windows.platform !== 'windows-x86_64'
  ) {
    throw new Error('Windows 发布元数据与 macOS release:all 元数据不一致');
  }
  for (const name of [
    windows.installerAsset,
    windows.updaterAsset,
    windows.signatureAsset,
    windows.checksumAsset,
  ]) {
    requireAsset(release, name);
  }

  const arm = metadata.platforms['darwin-aarch64'];
  const intel = metadata.platforms['darwin-x86_64'];
  const platforms = {
    'darwin-aarch64': await updaterPlatform(
      release,
      arm.updater.name,
      arm.signature.name,
      arm.updater.sha256,
    ),
    'darwin-x86_64': await updaterPlatform(
      release,
      intel.updater.name,
      intel.signature.name,
      intel.updater.sha256,
    ),
    'windows-x86_64': await updaterPlatform(
      release,
      windows.updaterAsset,
      windows.signatureAsset,
      windows.installerSha256,
    ),
  };
  if (Object.keys(platforms).sort().join(',') !== 'darwin-aarch64,darwin-x86_64,windows-x86_64') {
    throw new Error('latest.json 平台集合不正确');
  }
  const latest = {
    version: metadata.version,
    notes: `Update to ${metadata.tag}`,
    pub_date: new Date().toISOString(),
    platforms,
  };
  const latestPath = join(releaseDir, 'latest.json');
  writeFileSync(latestPath, `${JSON.stringify(latest, null, 2)}\n`);
  console.table(
    Object.entries(platforms).map(([platform, value]) => ({
      platform,
      url: value.url,
      signature: `${value.signature.slice(0, 20)}…`,
      version: metadata.version,
    })),
  );
  console.log(`Windows Authenticode: ${windows.authenticodeStatus}`);

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`发布需要交互确认；请在终端运行并输入完整 tag：${metadata.tag}`);
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(`输入完整 tag “${metadata.tag}” 确认上传 latest.json 并发布：`);
  prompt.close();
  if (answer.trim() !== metadata.tag) throw new Error('确认 tag 不匹配，已取消发布');

  await uploadAsset(release, latestPath);
  release = (await findRelease(metadata.tag)) ?? release;
  for (const name of [
    ...macAssetNames(metadata),
    windows.installerAsset,
    windows.signatureAsset,
    windows.checksumAsset,
    'windows-release-info.json',
    'latest.json',
  ]) {
    requireAsset(release, name);
  }
  await githubRequest(release.url, {
    method: 'PATCH',
    body: JSON.stringify({
      draft: false,
      make_latest: 'true',
      body: releaseBody(metadata.version, windows.authenticodeStatus),
    }),
  });
  console.log(`${metadata.tag} 已正式发布：${release.html_url}`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  switch (command) {
    case undefined:
      await runBuild(['aarch64-apple-darwin', 'x86_64-apple-darwin']);
      break;
    case 'arm':
      await runBuild(['aarch64-apple-darwin']);
      break;
    case 'intel':
      await runBuild(['x86_64-apple-darwin']);
      break;
    case 'upload':
      await runUpload();
      break;
    case 'status':
      await runStatus();
      break;
    case 'publish':
      await runPublish();
      break;
    default:
      throw new Error(`未知 release 命令：${command}`);
  }
}

main().catch((error) => {
  console.error('\n发布流程失败：', error);
  process.exit(1);
});
