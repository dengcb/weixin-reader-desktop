import { afterEach, describe, expect, it } from 'bun:test';
import { closeReaderToc, isCatalogTitleMatch, openReaderToc } from '../reader_toc';

const mount = (html: string): void => {
  document.body.innerHTML = html;
};

afterEach(() => {
  document.body.innerHTML = '';
  document
    .querySelectorAll('style[data-atreader-toc-reveal]')
    .forEach((style) => style.remove());
});

const expectClick = (selector: string, siteId: string): void => {
  const target = document.querySelector<HTMLElement>(selector)!;
  let clicked = 0;
  target.addEventListener('click', () => {
    clicked += 1;
  });
  expect(openReaderToc(siteId)).toBe('opened');
  expect(clicked).toBe(1);
};

describe('openReaderToc', () => {
  it('微信读书：点击链被无视，直接 CSS 强制目录面板（含遮罩）', () => {
    mount(
      '<div class="readerControls"><button class="readerControls_item catalog" title="目录"></button></div><div class="readerCatalog" style="display:none"></div>',
    );
    expect(openReaderToc('weread')).toBe('opened');
    const style = Array.from(
      document.querySelectorAll<HTMLStyleElement>('style[data-atreader-toc-reveal]'),
    ).find((candidate) => candidate.textContent?.includes('.readerCatalog'));
    expect(style).toBeTruthy();
    expect(document.querySelector('[data-atreader-toc-overlay]')).toBeTruthy();
    expect(closeReaderToc('weread')).toBe(true);
    expect(document.querySelector('[data-atreader-toc-overlay]')).toBeFalsy();
  });

  it('番茄：从章节菜单图标找到工具栏条目', () => {
    mount('<div class="reader-toolbar-item"><svg class="muyeicon-icon-chapter-menu"></svg><div>目录</div></div>');
    expectClick('.reader-toolbar-item', 'fanqie');
  });

  it('起点：点击 #r-menu 内的目录项', () => {
    mount('<div id="r-menu"><button type="button">目录</button></div>');
    expectClick('#r-menu button', 'qidian');
  });

  it('七猫：强制显示 catalog 抽屉（:hover 无法用合成事件触发）', () => {
    mount(
      '<ul class="qm-fixed-right"><li class="qm-fixed-right-item click catalog"><a class="qm-fixed-right-link"><span class="s-tit">目录</span></a><div class="qm-fixed-right-extend"><div class="qm-fixed-right-extend-con catalog"></div></div></li></ul>',
    );
    expect(openReaderToc('qimao')).toBe('opened');
    const style = Array.from(
      document.querySelectorAll<HTMLStyleElement>('style[data-atreader-toc-reveal]'),
    ).find((candidate) => candidate.textContent?.includes('.qm-fixed-right-extend'));
    expect(style).toBeTruthy();
  });

  it('iReader：点击插件工具栏目录键', () => {
    mount('<div class="atreader-ireader-toolbar"><button data-role="catalog">目录</button></div>');
    expectClick('button[data-role="catalog"]', 'ireader');
  });

  it('iReader：抽屉已展开时不重复点击', () => {
    mount(
      '<div class="directory-wrapper" style="opacity:1"></div><div class="atreader-ireader-toolbar"><button data-role="catalog">目录</button></div>',
    );
    const target = document.querySelector<HTMLElement>('button[data-role="catalog"]')!;
    let clicked = 0;
    target.addEventListener('click', () => {
      clicked += 1;
    });
    expect(openReaderToc('ireader')).toBe('already-open');
    expect(clicked).toBe(0);
  });

  it('未知站点：按文本兜底找目录按钮', () => {
    mount('<button title="目录">目录</button>');
    expectClick('button', 'dedao');
  });

  it('得到：优先点击右侧工具栏的目录按钮', () => {
    mount(
      '<div class="iget-reader-toolbar"><div class="right-button-group"><button class="reader-tool-button right-button-group-first-button"><span>目录</span></button></div></div>',
    );
    expectClick('.right-button-group-first-button', 'dedao');
  });

  it('多看：点击控制栏的 j-toc 按钮', () => {
    mount('<div class="j-md-ctrl"><ul class="btn"><li><span class="j-toc"></span></li></ul></div>');
    expectClick('.j-toc', 'duokan');
  });

  it('按文本兜底取最深节点，避免点到包裹整页的容器', () => {
    mount('<div class="page"><div class="wrap">目录</div></div>');
    const target = document.querySelector<HTMLElement>('.wrap')!;
    let clicked = 0;
    target.addEventListener('click', () => {
      clicked += 1;
    });
    expect(openReaderToc('unknown-site')).toBe('opened');
    expect(clicked).toBe(1);
  });

  it('找不到入口时返回 not-found', () => {
    mount('<div>正文</div>');
    expect(openReaderToc('duokan')).toBe('not-found');
  });

  it('zread：目录树常驻，视为已打开', () => {
    mount('<aside><a href="/a/b/c">章节</a></aside>');
    expect(openReaderToc('zread')).toBe('already-open');
  });

  it('微信读书：直接调用 React onClick 处理器（无样式注入）', () => {
    document.body.innerHTML = '<div class="readerCatalog" style="display:none"></div>';
    const button = document.createElement('button');
    button.className = 'readerControls_item catalog';
    let clicked = 0;
    (button as unknown as Record<string, unknown>).__reactProps$test = {
      onClick: () => {
        clicked += 1;
      },
    };
    document.body.append(button);
    expect(openReaderToc('weread')).toBe('opened');
    expect(clicked).toBe(1);
    expect(document.querySelector('style[data-atreader-toc-reveal]')).toBeFalsy();
    button.remove();
  });

  it('closeReaderToc：强制显示的站点清理注入样式收起目录', async () => {
    mount(
      '<div class="readerControls"><button class="readerControls_item catalog" title="目录"></button></div><div class="readerCatalog" style="display:none"></div>',
    );
    expect(openReaderToc('weread')).toBe('opened');
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(
      document.querySelector('style[data-atreader-toc-reveal]'),
    ).toBeTruthy();
    expect(closeReaderToc('weread')).toBe(true);
    expect(
      document.querySelector('style[data-atreader-toc-reveal]'),
    ).toBeFalsy();
    // 目录已关，再次关闭为 false（调用方据此回退到切工具栏语义）
    expect(closeReaderToc('weread')).toBe(false);
  });

  it('目录项标题匹配：带章号前缀/空白差异的后缀匹配', () => {
    expect(isCatalogTitleMatch('第1397章 古殿', '古殿')).toBe(true);
    expect(isCatalogTitleMatch('第1397章　古殿', '古殿')).toBe(true);
    expect(isCatalogTitleMatch('扉页', '扉页')).toBe(true);
    expect(isCatalogTitleMatch('第1397章 古殿', '古殿深处')).toBe(false);
    expect(isCatalogTitleMatch('', '古殿')).toBe(false);
  });

  it('closeReaderToc：七猫清理抽屉样式', () => {
    mount(
      '<ul class="qm-fixed-right"><li class="qm-fixed-right-item click catalog"><a class="qm-fixed-right-link"><span class="s-tit">目录</span></a><div class="qm-fixed-right-extend"><div class="qm-fixed-right-extend-con catalog"></div></div></li></ul>',
    );
    expect(openReaderToc('qimao')).toBe('opened');
    expect(closeReaderToc('qimao')).toBe(true);
    expect(
      document.querySelector('style[data-atreader-toc-reveal]'),
    ).toBeFalsy();
  });
});
