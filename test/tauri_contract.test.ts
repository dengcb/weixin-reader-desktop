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
    expect(source).toContain('update::init(app.handle())');
  });

  it('registers global window-state persistence and the bounded log rotation policy', async () => {
    const source = await readText('src-tauri/src/lib.rs');

    expect(source).toContain('.plugin(tauri_plugin_window_state::Builder::default().build())');
    expect(source).toContain('.max_file_size(2 * 1024 * 1024)');
    expect(source).toContain('RotationStrategy::KeepSome(2)');
  });

  it('registers .atrd as an owned plugin package type', async () => {
    const [config, infoPlist, lib, installer, settings] = await Promise.all([
      readJson<{
        bundle: {
          fileAssociations: Array<{ ext: string[]; rank: string; mimeType: string }>;
          macOS: { infoPlist: string };
        };
      }>('src-tauri/tauri.conf.json'),
      readText('src-tauri/Info.plist'),
      readText('src-tauri/src/lib.rs'),
      readText('src/windows/plugin-installer.html'),
      readText('src/windows/settings.html'),
    ]);

    expect(config.bundle.fileAssociations).toEqual([
      expect.objectContaining({
        ext: ['atrd'],
        rank: 'Owner',
        mimeType: 'application/x-atreader-plugin',
      }),
    ]);
    expect(config.bundle.macOS.infoPlist).toBe('Info.plist');
    expect(infoPlist).toContain('<key>UTTypeIconFile</key>');
    expect(infoPlist).toContain('<string>icon.icns</string>');
    expect(lib).toContain('tauri_plugin_single_instance::init');
    expect(lib).toContain('tauri::RunEvent::Opened { urls }');
    expect(lib).toContain('plugin_installer::focus_pending_plugin_install(app.handle())?');
    expect(installer).toContain('确认安装插件');
    expect(installer).not.toContain('SHA-256');
    expect(installer).not.toContain('插件包未提供独立发布者签名');
    expect(installer).toContain('await closeWindow(false)');
    expect(installer).toContain('plugin-install-preview-updated');
    const installerScript = installer.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(installerScript).toBeDefined();
    expect(() => new Function(installerScript!)).not.toThrow();
    expect(settings).toContain("invoke('prepare_plugin_install', { path: file })");
    expect(settings).not.toContain("invoke('install_plugin', { path: file })");
    const installerCapability = await readJson<Capability>('src-tauri/capabilities/plugin-installer.json');
    expect(installerCapability.permissions).toContain('core:window:allow-close');
  });

  it('declares Simplified Chinese as the only macOS application localization', async () => {
    const [config, infoPlist, localizedInfoPlist] = await Promise.all([
      readJson<{ bundle: { resources: Record<string, string> } }>('src-tauri/tauri.conf.json'),
      readText('src-tauri/Info.plist'),
      readText('src-tauri/infoplist/zh-Hans.lproj/InfoPlist.strings'),
    ]);

    expect(infoPlist).toContain('<key>CFBundleDevelopmentRegion</key>');
    expect(infoPlist).toContain('<string>zh-Hans</string>');
    expect(infoPlist).toContain('<key>CFBundleLocalizations</key>');
    expect(config.bundle.resources['infoplist/zh-Hans.lproj/InfoPlist.strings'])
      .toBe('zh-Hans.lproj/InfoPlist.strings');
    expect(localizedInfoPlist).toContain('CFBundleDisplayName = "艾特阅读";');
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

  it('keeps a static local default page for when every online plugin is disabled', async () => {
    const [library, lib, inject, buildScript] = await Promise.all([
      readText('src/windows/library.html'),
      readText('src-tauri/src/lib.rs'),
      readText('src/scripts/inject.ts'),
      readText('src-tauri/build.rs'),
    ]);

    expect(library).toContain('<h1>艾特阅读</h1>');
    expect(library).toContain('当前没有已启用的在线插件');
    expect(library).not.toContain('即将');
    expect(library).toContain('color-scheme: dark');
    expect(library).not.toContain('prefers-color-scheme');
    expect(lib).toContain('WebviewUrl::CustomProtocol(library_page_url())');
    expect(lib).toContain('register_uri_scheme_protocol(LIBRARY_SCHEME');
    expect(lib).toContain('LIBRARY_PAGE_HTML.to_vec()');
    expect(lib).toContain('navigate_to_library_when_no_online_site');
    expect(lib).toContain('navigate_to_enabled_site_when_on_library');
    expect(inject).toContain("['http:', 'https:'].includes(window.location.protocol)");
    expect(buildScript).toContain('cargo:rerun-if-changed=../dist/library.html');
  });

  it('marks disabled built-in plugins as removable and restores them without an external package', async () => {
    const settings = await readText('src/windows/settings.html');

    expect(settings).toContain('const enabledPluginIds = Array.isArray(currentSettings?.global?.enabledPlugins)');
    expect(settings).toContain('...BUILTIN_PLUGINS.map(plugin => ({ ...plugin, enabled: isEnabled(plugin) }))');
    expect(settings).toContain("makeButton('install', 'restore', '恢复')");
    expect(settings).toContain("if (action === 'restore')");
    expect(settings).toContain('await renderPluginList(updatedSettings)');
  });

  it('scopes each capability to its intended window and remote pages only to main', async () => {
    const paths = [
      'src-tauri/capabilities/main-runtime.json',
      'src-tauri/capabilities/local-reader.json',
      'src-tauri/capabilities/settings.json',
      'src-tauri/capabilities/plugin-editor.json',
      'src-tauri/capabilities/plugin-installer.json',
      'src-tauri/capabilities/legal-documents.json',
    ];
    const capabilities = await Promise.all(paths.map(path => readJson<Capability>(path)));
    const scopes = Object.fromEntries(capabilities.map(item => [item.identifier, item.windows]));

    expect(scopes).toEqual({
      'main-runtime': ['main'],
      'local-reader': ['main'],
      settings: ['settings'],
      'plugin-editor': ['plugin-editor'],
      'plugin-installer': ['plugin-installer'],
      'legal-documents': ['privacy', 'terms'],
    });
    expect(capabilities[0].remote?.urls).toEqual(['https://*', 'http://*']);
    expect(capabilities.slice(1).every(item => item.remote === undefined)).toBe(true);
  });

  it('keeps local TXT and EPUB as a secondary bookstore compatibility feature', async () => {
    const [config, menu, settings, localPage, localCapability, notices, license] = await Promise.all([
      readJson<{
        bundle: {
          fileAssociations: Array<{ ext: string[] }>;
          resources: Record<string, string>;
        };
      }>('src-tauri/tauri.conf.json'),
      readText('src-tauri/src/menu.rs'),
      readText('src/windows/settings.html'),
      readText('src/windows/local-reader.html'),
      readJson<Capability>('src-tauri/capabilities/local-reader.json'),
      readText('THIRD-PARTY-NOTICES.md'),
      readText('third-party/foliate-js/LICENSE'),
    ]);

    expect(config.bundle.fileAssociations.flatMap(item => item.ext)).toEqual(['atrd']);
    expect(menu).toContain('Submenu::new(manager, "自家书屋", true)');
    expect(menu).toContain('"打开本地图书…"');
    expect(menu).toContain('open_local_book_');
    expect(settings).toContain('<div class="section-title" style="margin-top: 32px;">本地书屋</div>');
    expect(settings).toContain('<div class="setting-desc">清除本地书屋里的阅读历史记录</div>');
    expect(settings).toContain('msg.textContent = \'清除本地书屋里的阅读历史记录\'');
    expect(settings).toContain('id="clearLocalHistoryBtn">清空历史记录</button>');
    expect(localPage.match(/class="tool-button"/g)).toHaveLength(4);
    expect(localPage).toContain('id="pageProgress"');
    expect(localCapability.remote).toBeUndefined();
    expect(localCapability.permissions).toContain('allow-get-local-book');
    expect(localCapability.permissions).not.toContain('dialog:default');
    expect(config.bundle.resources['../third-party/foliate-js/LICENSE']).toBe(
      'licenses/foliate-js/LICENSE',
    );
    expect(notices).toContain('78914aef4466eb960965702401634c2cb348e9b1');
    expect(license).toContain('Copyright (c) 2022 John Factotum');

    const settingsScript = settings.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(settingsScript).toBeDefined();
    expect(() => new Function(settingsScript!)).not.toThrow();
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
      'allow-toggle-stealth',
      'allow-toggle-menu-bar',
      'allow-simulate-menu-click',
      'allow-switch-bookstore-by-index',
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
