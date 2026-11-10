import { describe, expect, it } from 'bun:test';

const root = new URL('../', import.meta.url);
const readText = (path: string) => Bun.file(new URL(path, root)).text();

describe('local shelf remote-control navigation', () => {
  it('wires TV-style grid navigation and the HID button channel', async () => {
    const source = await readText('src/windows/local-shelf.html');

    // HID 事件通道：只消费菜单/返回/主页/音量（方向与 OK 走 keydown，防双触发）
    expect(source).toContain("'remote-hid-button'");
    expect(source).toContain("button === 'menu'");
    expect(source).toContain("button === 'back'");
    expect(source).toContain("button === 'home'");
    expect(source).toContain("button === 'volume_up'");
    expect(source).toContain("button === 'volume_down'");
    // 网格导航：物理方向键与遥控 ↑↓（系统映射为 PageUp/PageDown）双键名同认
    expect(source).toContain('navigateGrid(event.key)');
    expect(source).toContain("'PageUp'");
    expect(source).toContain("'PageDown'");
    // Enter 连发守卫：长按 OK 不得连环开书
    expect(source).toContain("event.key === 'Enter' && event.repeat");
    // 焦点环、重渲染找回与滚动跟随
    expect(source).toContain('.book.focused .cover');
    expect(source).toContain('focusedBookId');
    expect(source).toContain('restoreFocus()');
    // 滚动跟随绕开 scrollIntoView：按 offsetTop 链布局位置直算 scrollTop，
    // 让位 sticky 顶栏与管理底栏悬浮层（scrollIntoView 看不见悬浮层）
    expect(source).toContain('node.offsetParent');
    expect(source).toContain('y - topH');
    // 沉浸滚动向下立即藏栏（无深度阈值）；display:flex 会掀翻 hidden 属性，
    // 管理栏须显式 [hidden]{display:none}（否则普通模式常驻底部遮住末行）
    expect(source).toContain('.manage-bar[hidden] { display: none; }');
    // 沉浸藏栏/出栏只由焦点方向驱动；滚动监听只管滚动条自动隐没与回顶出栏，
    // 不做鼠标滚轮方向判定（曾与焦点驱动互相打架）
    expect(source).toContain("classList.toggle('bars-hidden', dir > 0)");
    expect(source).not.toContain('lastScrollTop');
    // Windows 菜单键（键盘触发 contextmenu）不得冒充右键弹卡片菜单
    expect(source).toContain('event.button !== 2 && !event.ctrlKey');
    // 页面级屏蔽 WebKit 原生菜单：遥控器菜单键的合成右键不得弹出系统菜单
    expect(source).toContain('页面级屏蔽 WebKit 原生菜单');
    // 菜单键幻影右键识别（坐标无关）：buttons=0 且 detail=0 的 contextmenu 是
    // 系统在鼠标指针位置合成的（真机指纹 2026-11-10），整个忽略——落入卡片
    // 分支会误开卡片菜单、吃掉 2~3ms 后到达的 HID press（曾致菜单键失灵）
    expect(source).toContain('event.buttons === 0 && event.detail === 0');
    expect(source).toContain('menuAction()');
    expect(source).not.toContain('clientX === 1 && event.clientY === 1');
  });
});
