import { describe, expect, it } from 'bun:test';

const root = new URL('../', import.meta.url);
const readText = (path: string) => Bun.file(new URL(path, root)).text();
const readJson = <T>(path: string) => Bun.file(new URL(path, root)).json() as Promise<T>;

type PermissionEntry = string | {
  identifier: string;
  allow?: Array<Record<string, unknown>>;
};

type Capability = {
  identifier: string;
  windows: string[];
  remote?: { urls?: string[] };
  permissions: PermissionEntry[];
};

const permissionIdentifier = (permission: PermissionEntry): string =>
  typeof permission === 'string' ? permission : permission.identifier;

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

    expect(source).toContain('tauri_plugin_window_state::Builder::default()');
    // 设置窗口尺寸由 menu.rs 的 inner_size 唯一决定，排除在持久化之外
    expect(source).toContain('.with_denylist(&["settings", "startup"])');
    expect(source).not.toContain('tauri_plugin_window_state::StateFlags::VISIBLE');
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
      expect.objectContaining({
        ext: ['epub'],
        rank: 'Alternate',
        mimeType: 'application/epub+zip',
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
    expect(settings).toContain("prepare_plugin_install");
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
    expect([...builders].map(match => match[1])).toEqual(['startup', 'main', 'settings']);
    expect(lib).toContain('.visible(false)');
    expect(lib).toContain('reveal_main_window_once');
  });

  it('keeps a branded static startup page in front while the hidden main window settles', async () => {
    const [startup, localReaderPage, packageJson, logo] = await Promise.all([
      readText('index.html'),
      readText('src/windows/local-reader.html'),
      readJson<{ scripts: { build: string } }>('package.json'),
      readText('atrd-logo.svg'),
    ]);

    expect(startup).toContain("url('/atrd-logo.svg')");
    expect(startup).toContain('正在准备阅读空间');
    expect(startup).not.toContain('TARGET_URL');
    expect(startup).not.toContain('window.location.href');
    expect(localReaderPage).toContain('class="loading-logo"');
    expect(packageJson.scripts.build).toContain('atrd-logo.svg dist/');
    expect(logo.match(/<path /g)?.length).toBeGreaterThan(1);
  });

  it('keeps a static local default page for when every online plugin is disabled', async () => {
    const [library, lib, inject, buildScript] = await Promise.all([
      readText('src/windows/library.html'),
      readText('src-tauri/src/lib.rs'),
      readText('src/scripts/inject.ts'),
      readText('src-tauri/build.rs'),
    ]);

    expect(library).toContain('<h1>艾特阅读</h1>');
    expect(library).toContain("url('/atrd-logo.svg')");
    expect(library).toContain('当前没有已启用的在线插件');
    expect(library).not.toContain('即将');
    expect(library).toContain('color-scheme: dark');
    expect(library).not.toContain('prefers-color-scheme');
    expect(library).toContain("invoke('simulate_menu_click', { action })");
    expect(library).toContain("invoke('switch_bookstore_by_index', { index: Number(event.key) })");
    expect(lib).toContain('WebviewUrl::CustomProtocol(library_page_url())');
    expect(lib).toContain('register_uri_scheme_protocol(LIBRARY_SCHEME');
    expect(lib).toContain('LIBRARY_PAGE_HTML.to_vec()');
    expect(lib).toContain('navigate_to_library_when_no_online_site');
    expect(lib).toContain('navigate_to_enabled_site_when_on_library');
    expect(lib).toContain('is_library_page_url(&current)');
    expect(inject).toContain("['http:', 'https:'].includes(window.location.protocol)");
    expect(buildScript).toContain('cargo:rerun-if-changed=../dist/library.html');
    expect(buildScript).toContain('cargo:rerun-if-changed=../atrd-logo.svg');
  });

  it('marks disabled built-in plugins as removable and restores them without an external package', async () => {
    const settings = await readText('src/windows/settings.html');

    expect(settings).toContain('const builtinPlugins');
    expect(settings).toContain('enabled:isEnabled(plugin,ids)');
    expect(settings).toContain('已停用');
    expect(settings).toContain('togglePlugin');
    expect(settings).toContain("invoke('set_content_source_enabled'");
    expect(settings).not.toContain('patchSettings({global:{enabledPlugins:next}})');
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
      'legal-documents': ['privacy', 'terms', 'licenses'],
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

    expect(config.bundle.fileAssociations.flatMap(item => item.ext)).toEqual(['atrd', 'epub']);
    expect(menu).toContain('menu_id::RECENT');
    expect(menu).toContain('"打开本地图书…"');
    expect(menu).toContain('open_local_book_');
    expect(settings).toContain('本地阅读数据');
    expect(settings).toContain('清除本地阅读记录');
    expect(settings).toContain('原始 TXT/EPUB 文件不会被删除');
    expect(settings).toContain('id="clearLocalHistoryBtn"');
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

  it('keeps menu actions stable, nested and bounded across native and web runtimes', async () => {
    const [menu, model, commands, inject, localReader] = await Promise.all([
      readText('src-tauri/src/menu.rs'),
      readText('src-tauri/src/menu_model.rs'),
      readText('src-tauri/src/commands.rs'),
      readText('src/scripts/inject.ts'),
      readText('src/local-reader/index.ts'),
    ]);

    for (const id of ['menu_file', 'menu_reading', 'menu_go', 'menu_view', 'menu_window', 'menu_help']) {
      expect(model).toContain(`"${id}"`);
    }
    expect(menu).toContain('fn build_app_menu');
    expect(menu).toContain('build_recent_books_menu(handle, &settings_data)');
    expect(menu).toContain('disable_reader_items(&top_items)');
    expect(menu).toContain('is_reader_action_enabled(id)');
    expect(menu).toContain('reader_action_supported(app, &url, id)');
    expect(menu).toContain('.min_inner_size(760.0, 560.0)');
    expect(commands).toContain('for_each_menu_item');
    expect(commands).toContain('is_simulated_action');
    expect(commands).toContain('window.label() != "main" || !crate::menu_model::is_main_window_focused()');
    const simulatedActions = model.match(/SIMULATED_ACTION_IDS:[\s\S]*?= &\[([\s\S]*?)\];/)?.[1];
    expect(simulatedActions).toBeDefined();
    expect(simulatedActions).not.toContain('"install_update_now"');
    expect(menu).toContain('Some("CmdOrCtrl+Shift+O")');
    expect(menu).toContain('Some("CmdOrCtrl+O")');
    expect(menu).toContain('Some("CmdOrCtrl+P")');
    expect(inject).toContain("'o': 'hide_toolbar'");
    expect(inject).toContain("'p': 'hide_navbar'");
    expect(inject).toContain("? 'open_local_book'");
    expect(localReader).toContain("o: 'hide_toolbar'");
    expect(localReader).toContain("? 'open_local_book'");
    expect(localReader).not.toContain("p: 'hide_navbar'");
  });

  it('uses monotonic settings snapshots, atomic source intent and claimable hot deep-links', async () => {
    const [settingsPage, settingsCapability, menu, settings] = await Promise.all([
      readText('src/windows/settings.html'),
      readJson<Capability>('src-tauri/capabilities/settings.json'),
      readText('src-tauri/src/menu.rs'),
      readText('src-tauri/src/settings.rs'),
    ]);

    expect(settingsPage).toContain('next._version >= documentState._version');
    expect(settingsPage).toContain("invoke('set_content_source_enabled'");
    expect(settingsPage).toContain("invoke('claim_settings_target')");
    expect(settingsPage).toContain("listen('plugins-updated',()=>refreshPluginsFromRepository())");
    expect(settingsPage.match(/class="nav-icon"/g)).toHaveLength(5);
    expect(settingsPage).toContain('class="search-icon"');
    expect(settingsPage).toContain("mask:url('atrd-logo.svg')");
    expect(settingsPage).not.toContain("background:url('icon.png')");
    expect(settingsPage).not.toContain('OUT OF OR IN CONNECTION WITH THE SOFTWARE');
    expect(settingsPage).not.toContain('class="license-copy"');
    expect(menu).toContain('PENDING_SETTINGS_TARGET');
    expect(menu).toContain('pending.take()');
    expect(settings).toContain('set_enabled_source_path');
    expect(settingsCapability.permissions).toContain('allow-set-content-source-enabled');
    expect(settingsCapability.permissions).toContain('allow-claim-settings-target');
  });

  it('keeps dangerous native capabilities out of the remote reading window', async () => {
    const capability = await readJson<Capability>('src-tauri/capabilities/main-runtime.json');
    const commandPermissions = capability.permissions
      .map(permissionIdentifier)
      .filter(item => item.startsWith('allow-'));

    expect(commandPermissions).toEqual([
      'allow-log-to-file',
      'allow-update-menu-state',
      'allow-set-menu-item-enabled',
      'allow-set-active-bookstore',
      'allow-set-title',
      'allow-toggle-stealth',
      'allow-toggle-menu-bar',
      'allow-reveal-menu-bar-transient',
      'allow-simulate-menu-click',
      'allow-switch-bookstore-by-index',
      'allow-apply-site-zoom',
      'allow-get-app-name',
      'allow-get-settings',
      'allow-patch-settings',
      'allow-get-reading-position',
      'allow-save-reading-position',
      'allow-get-runtime-plugin',
      'allow-is-main-fullscreen',
    ]);
    expect(capability.permissions.map(permissionIdentifier).some(item =>
      /(?:fs|shell|updater|dialog|opener|create|install|uninstall|export)/i.test(item)
    )).toBe(false);
    // core: 权限白名单：不允许 allow- 前缀过滤之外的 core 能力静默进入远程窗口
    // （core:default 的 window 部分仅只读查询；新增 core 权限须显式扩展此列表）
    const corePermissions = capability.permissions
      .map(permissionIdentifier)
      .filter(item => item.startsWith('core:'));
    expect(corePermissions).toEqual([
      'core:default',
      'core:event:default',
      'core:window:allow-set-theme',
    ]);
    expect(capability.permissions.find(item =>
      permissionIdentifier(item) === 'core:window:allow-set-theme'
    )).toEqual({
      identifier: 'core:window:allow-set-theme',
      allow: [{ label: 'main' }],
    });
  });

  it('pins the fullscreen-changed event name on both the Rust and TS sides', async () => {
    // 事件名是两端裸字符串，typo 会让 hover 唤出整体静默——两端集合必须相等
    const rustSources = (await Promise.all([
      readText('src-tauri/src/lib.rs'),
      readText('src-tauri/src/menu.rs'),
    ])).join('\n');
    const rustEmits = new Set([
      ...rustSources.matchAll(/emit\("([a-z-]+)"/g),
    ].map((m) => m[1]));
    const injectSource = await readText('src/scripts/inject.ts');
    const tsListens = new Set([
      ...injectSource.matchAll(/listen\('([a-z-]+)'/g),
    ].map((m) => m[1]));
    expect(rustEmits.has('fullscreen-changed')).toBe(true);
    expect(tsListens.has('fullscreen-changed')).toBe(true);
  });
});
