import { describe, expect, it } from 'bun:test';

const root = new URL('../', import.meta.url);
const readText = (path: string) => Bun.file(new URL(path, root)).text();
const readJson = <T>(path: string) => Bun.file(new URL(path, root)).json() as Promise<T>;

type Capability = {
  identifier: string;
  windows: string[];
  remote?: { urls?: string[] };
  permissions: string[];
};

describe('Tauri application contracts', () => {
  it('keeps updater artifacts, signed GitHub endpoints and the runtime updater plugin wired', async () => {
    const [config, source] = await Promise.all([
      readJson<{
        plugins: { updater: { endpoints: string[]; pubkey: string } };
        bundle: { createUpdaterArtifacts: boolean };
      }>('src-tauri/tauri.conf.json'),
      readText('src-tauri/src/lib.rs'),
    ]);

    expect(config.bundle.createUpdaterArtifacts).toBe(true);
    expect(config.plugins.updater.pubkey.length).toBeGreaterThan(40);
    expect(config.plugins.updater.endpoints[0]).toBe(
      'https://github.com/dengcb/weixin-reader-desktop/releases/latest/download/latest.json',
    );
    expect(config.plugins.updater.endpoints).toHaveLength(3);
    expect(source).toContain('.plugin(tauri_plugin_updater::Builder::default().build())');
    expect(source).toContain('update::init(&app.handle())');
  });

  it('registers global window-state persistence and the bounded log rotation policy', async () => {
    const source = await readText('src-tauri/src/lib.rs');

    expect(source).toContain('.plugin(tauri_plugin_window_state::Builder::default().build())');
    expect(source).toContain('.max_file_size(2 * 1024 * 1024)');
    expect(source).toContain('RotationStrategy::KeepSome(2)');
  });

  it('defines no eager windows and never recreates obsolete about or update labels', async () => {
    const [config, lib, menu] = await Promise.all([
      readJson<{ app: { windows: unknown[] } }>('src-tauri/tauri.conf.json'),
      readText('src-tauri/src/lib.rs'),
      readText('src-tauri/src/menu.rs'),
    ]);

    expect(config.app.windows).toEqual([]);
    const builders = `${lib}\n${menu}`.matchAll(/WebviewWindowBuilder::new\([^,]+,\s*"([^"]+)"/g);
    expect([...builders].map(match => match[1])).toEqual(['main', 'settings', 'settings', 'settings']);
  });

  it('scopes each capability to its intended window and remote pages only to main', async () => {
    const paths = [
      'src-tauri/capabilities/main-runtime.json',
      'src-tauri/capabilities/settings.json',
      'src-tauri/capabilities/plugin-editor.json',
      'src-tauri/capabilities/legal-documents.json',
    ];
    const capabilities = await Promise.all(paths.map(path => readJson<Capability>(path)));
    const scopes = Object.fromEntries(capabilities.map(item => [item.identifier, item.windows]));

    expect(scopes).toEqual({
      'main-runtime': ['main'],
      settings: ['settings'],
      'plugin-editor': ['plugin-editor'],
      'legal-documents': ['privacy', 'terms'],
    });
    expect(capabilities[0].remote?.urls).toEqual(['https://*', 'http://*']);
    expect(capabilities.slice(1).every(item => item.remote === undefined)).toBe(true);
  });

  it('keeps dangerous native capabilities out of the remote reading window', async () => {
    const capability = await readJson<Capability>('src-tauri/capabilities/main-runtime.json');
    const commandPermissions = capability.permissions.filter(item => item.startsWith('allow-'));

    expect(commandPermissions).toEqual([
      'allow-log-to-file',
      'allow-update-menu-state',
      'allow-set-menu-item-enabled',
      'allow-set-active-bookstore',
      'allow-set-title',
      'allow-apply-site-zoom',
      'allow-get-app-name',
      'allow-get-settings',
      'allow-patch-settings',
      'allow-get-reading-position',
      'allow-save-reading-position',
      'allow-get-runtime-plugin',
    ]);
    expect(capability.permissions.some(item =>
      /(?:fs|shell|updater|dialog|opener|create|install|uninstall|export)/i.test(item)
    )).toBe(false);
  });
});
