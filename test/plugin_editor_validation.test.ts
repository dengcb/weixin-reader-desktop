import { describe, expect, it } from 'bun:test';
import { Window } from 'happy-dom';

const workspace = new URL('../', import.meta.url);

const readWorkspaceFile = (path: string) =>
  Bun.file(new URL(path, workspace)).text();

describe('plugin editor self-declaration validation', () => {
  it('marks the official Fanqie manifest, code, and styles as valid on initial load', async () => {
    const [html, manifestText, code] = await Promise.all([
      readWorkspaceFile('src/windows/editor.html'),
      readWorkspaceFile('plugins/fanqie/manifest.json'),
      readWorkspaceFile('plugins/fanqie/index.ts'),
    ]);
    const styleNames = [
      'layout-toggle.css',
      'navbar.css',
      'progress.css',
      'reader.css',
      'toolbar.css',
      'viewport.css',
      'wide.css',
    ];
    const styleContents = await Promise.all(
      styleNames.map(name => readWorkspaceFile(`plugins/fanqie/styles/${name}`)),
    );
    const data = {
      mode: 'edit',
      pluginId: 'fanqie',
      isBuiltin: false,
      manifest: JSON.parse(manifestText),
      files: [
        { name: 'index.ts', content: code },
        ...styleNames.map((name, index) => ({ name, content: styleContents[index] })),
      ],
    };

    const scriptMatch = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
    expect(scriptMatch).not.toBeNull();
    const markup = html.replace(/<script>[\s\S]*<\/script>\s*<\/body>/, '</body>');
    const window = new Window({
      url: 'http://localhost/editor.html?mode=edit&pluginId=fanqie',
    });
    window.document.write(markup);
    Object.defineProperty(window, '__TAURI__', {
      configurable: true,
      value: {
        core: {
          invoke: async (command: string) =>
            command === 'load_plugin_for_edit' ? data : null,
        },
        event: {
          listen: async () => () => undefined,
          emit: async () => undefined,
        },
      },
    });

    const executeEditor = new Function(
      'window',
      'document',
      `const { location, URLSearchParams, Event, Node } = window;\n${scriptMatch![1]}`,
    );
    executeEditor(window, window.document);
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await new Promise(resolve => setTimeout(resolve, 10));

    for (const id of ['validManifest', 'validCode', 'validStyles']) {
      const icon = window.document.getElementById(id);
      expect(icon?.textContent).toBe('✓');
      expect(icon?.classList.contains('valid')).toBe(true);
    }
    expect((window.document.getElementById('btnSave') as HTMLButtonElement).disabled)
      .toBe(false);

    const pluginId = window.document.getElementById('pluginId') as HTMLInputElement;
    pluginId.value = 'fanqie_reader';
    pluginId.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(window.document.getElementById('validManifest')?.textContent).toBe('✓');

    const styleEditor = window.document.getElementById('styleEditor') as HTMLTextAreaElement;
    const originalStyle = styleEditor.value;
    styleEditor.value = originalStyle.replace('@capability wideMode', 'capability missing');
    styleEditor.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(window.document.getElementById('validStyles')?.textContent).toBe('✗');
    styleEditor.value = originalStyle;
    styleEditor.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(window.document.getElementById('validStyles')?.textContent).toBe('✓');

    const codeEditor = window.document.getElementById('codeEditor') as HTMLTextAreaElement;
    codeEditor.value = codeEditor.value.replace(
      '@capability chapterNav',
      'capability missing',
    );
    codeEditor.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(window.document.getElementById('validCode')?.textContent).toBe('✗');
    expect((window.document.getElementById('btnSave') as HTMLButtonElement).disabled)
      .toBe(true);

    window.close();
  });
});
