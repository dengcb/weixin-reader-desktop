import { describe, expect, it } from 'bun:test';

const root = new URL('../', import.meta.url);
const readText = (path: string) => Bun.file(new URL(path, root)).text();
const readJson = <T>(path: string) => Bun.file(new URL(path, root)).json() as Promise<T>;

describe('CI and release contracts', () => {
  it('pins Bun, Tauri CLI, Rust toolchain and release targets', async () => {
    const [pkg, toolchain] = await Promise.all([
      readJson<{
        packageManager: string;
        devDependencies: Record<string, string>;
        scripts: Record<string, string>;
      }>('package.json'),
      readText('rust-toolchain.toml'),
    ]);

    expect(pkg.packageManager).toBe('bun@1.3.14');
    expect(pkg.devDependencies['@tauri-apps/cli']).toBe('2.11.4');
    expect(pkg.scripts['check:version']).toContain('--check');
    expect(pkg.scripts['release:status']).toBeDefined();
    expect(toolchain).toContain('channel = "1.97.1"');
    expect(toolchain).toContain('aarch64-apple-darwin');
    expect(toolchain).toContain('x86_64-apple-darwin');
    expect(toolchain).toContain('x86_64-pc-windows-msvc');
  });

  it('keeps push CI E2E-free, package-free, and limited to quality checks', async () => {
    const ci = await readText('.github/workflows/ci.yml');

    expect(ci).toContain('pull_request:');
    expect(ci).toContain('push:');
    expect(ci).toContain('Frontend quality');
    expect(ci).toContain('Rust quality');
    expect(ci).toContain('actions/checkout@v6');
    expect(ci).not.toContain('actions/checkout@v4');
    expect(ci).toContain('bun install --frozen-lockfile');
    expect(ci).toContain('git diff --exit-code -- src/scripts/inject.js');
    expect(ci).toContain('--locked');
    expect(ci).not.toContain('tauri build');
    expect(ci).not.toContain('Platform build /');
    expect(ci).not.toContain('windows-2025');
    expect(ci).not.toContain('macos-15-intel');
    expect(ci).not.toContain('test:e2e');
    expect(ci).not.toContain('simulated-e2e');
    expect(ci).not.toContain('playwright');

    const rustJob = ci.slice(
      ci.indexOf('  rust-quality:'),
      ci.indexOf('  platform-macos-arm:'),
    );
    expect(rustJob).toContain('bun install --frozen-lockfile');
    expect(rustJob).toContain('bun run build');

  });

  it('builds one signed-updater NSIS into an existing draft without publishing', async () => {
    const [workflow, staging] = await Promise.all([
      readText('.github/workflows/release.yml'),
      readText('scripts/stage-windows-release.ts'),
    ]);

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toContain('push:');
    expect(workflow).toContain('--bundles nsis');
    expect(workflow).toContain('actions/checkout@v6');
    expect(workflow).not.toContain('actions/checkout@v4');
    expect(workflow).not.toContain('--no-bundle');
    expect(workflow.match(/tauri build/g)).toHaveLength(1);
    expect(workflow).toContain('TAURI_SIGNING_PRIVATE_KEY');
    expect(workflow).toContain('environment: windows-release');
    expect(workflow).toMatch(/validate-release:[\s\S]*?permissions:\s*contents: write/);
    expect(workflow).toContain('releases?per_page=100');
    expect(workflow).not.toContain('releases/tags/${RELEASE_TAG}');
    expect(workflow).toContain('gh release upload');
    expect(workflow).not.toContain('latest.json');
    expect(workflow).not.toContain('draft: false');
    expect(workflow).not.toContain('--bundles msi');
    expect(staging).toContain('30 * 1024 * 1024');
    expect(staging).toContain('windows-x86_64-setup.exe');
    expect(staging).toContain('sourceInstallerSignature');
  });

  it('uses the WebView2 download bootstrapper and defers latest.json to manual publish', async () => {
    const [config, releaseScript] = await Promise.all([
      readJson<{
        bundle: { windows: { webviewInstallMode: { type: string } } };
      }>('src-tauri/tauri.conf.json'),
      readText('src/scripts/release.ts'),
    ]);

    expect(config.bundle.windows.webviewInstallMode.type).toBe('downloadBootstrapper');
    expect(releaseScript).toContain("case 'status':");
    expect(releaseScript).toContain("case 'publish':");
    expect(releaseScript).toContain("[process.execPath, ['run', 'build']]");
    expect(releaseScript).toContain("await deleteAssetIfPresent(release, 'latest.json')");
    expect(releaseScript).toContain("'windows-x86_64': await updaterPlatform(");
    expect(releaseScript).toContain('verifyUpdaterSignature(updater, rawSignature,');
    expect(releaseScript).toContain('/releases/download/${encodeURIComponent(release.tag_name)}');
    expect(releaseScript).not.toContain('url: updaterAsset.browser_download_url');
    expect(releaseScript).toContain('const publishedRelease = await githubRequest<GitHubRelease>');
    expect(releaseScript).toContain("prompt.question(`输入完整 tag");
    expect(releaseScript).toContain("draft: false");
  });
});
