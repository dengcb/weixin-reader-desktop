import { describe, expect, it } from 'bun:test';
import { splitTxtChapters, txtChapterToXHTML } from './txt';

describe('本地 TXT 章节识别', () => {
  it('只按明确章节标题切分', () => {
    const chapters = splitTxtChapters('序言\n第1章 开始\n正文\n第二章：继续\n内容', '测试');
    expect(chapters.map(chapter => chapter.title)).toEqual(['第1章 开始', '第二章：继续']);
    expect(chapters[0].text).toContain('序言');
  });

  it('没有章节标题时整本作为一章', () => {
    const chapters = splitTxtChapters('只有正文\n没有标题', '整本书');
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe('整本书');
  });

  it('渲染时转义本地文本', () => {
    const [chapter] = splitTxtChapters('<script>alert(1)</script>', '安全');
    const html = txtChapterToXHTML(chapter);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});
