import { describe, expect, it } from 'bun:test';
import { splitTxtChapters, txtChapterToXHTML } from './txt';

describe('本地 TXT 章节识别', () => {
  it('只按明确章节标题切分（前导序言单独成章）', () => {
    const chapters = splitTxtChapters('序言\n第1章 开始\n正文\n第二章：继续\n内容', '测试');
    expect(chapters.map(chapter => chapter.title)).toEqual(['序言', '第1章 开始', '第二章：继续']);
    expect(chapters[0].text).toContain('序言');
  });

  it('首章标题前的楔子/前言单独成章，不再错挂在第一章名下', () => {
    const chapters = splitTxtChapters('楔子\n这是楔子内容\n第一章 起航\n正文开始', '书名');
    expect(chapters.map(chapter => chapter.title)).toEqual(['楔子', '第一章 起航']);
    expect(chapters[0].start).toBe(0);
    expect(chapters[1].text.startsWith('第一章 起航')).toBe(true);
    expect(chapters[1].text).not.toContain('楔子');
  });

  it('前导内容过长时章名回落书名，不截断成长标题', () => {
    const longPrefix = '很长的前言'.repeat(20);
    const chapters = splitTxtChapters(`${longPrefix}\n第一章 起航\nx`, '书名');
    expect(chapters[0].title).toBe('书名');
    expect(chapters[1].title).toBe('第一章 起航');
  });

  it('标题恰好位于正文开头时不产生空前导章', () => {
    const chapters = splitTxtChapters('第一章 开始\n正文', '书名');
    expect(chapters.map(chapter => chapter.title)).toEqual(['第一章 开始']);
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
