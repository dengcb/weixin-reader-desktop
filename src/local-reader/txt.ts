export interface TxtChapter {
  id: string;
  title: string;
  text: string;
  start: number;
}

const NUMBER = '〇零一二三四五六七八九十百千万两0-9０-９';
export const TXT_CHAPTER_HEADING = new RegExp(
  `^[\\t ]*(?:第[${NUMBER}]+[章节卷回篇部集]|卷[${NUMBER}]+|Chapter[\\t ]+[0-9０-９]+)(?:[\\t ：:、.-]+[^\\n]{0,80})?[\\t ]*$`,
  'gim',
);

export const splitTxtChapters = (input: string, bookTitle: string): TxtChapter[] => {
  const text = input.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  TXT_CHAPTER_HEADING.lastIndex = 0;
  const matches = [...text.matchAll(TXT_CHAPTER_HEADING)];
  TXT_CHAPTER_HEADING.lastIndex = 0;
  if (matches.length === 0) {
    return [{ id: 'txt-0', title: bookTitle, text, start: 0 }];
  }
  return matches.map((match, index) => {
    const start = index === 0 ? 0 : match.index ?? 0;
    const end = matches[index + 1]?.index ?? text.length;
    return {
      id: `txt-${index}`,
      title: match[0].trim(),
      text: text.slice(start, end).trim(),
      start,
    };
  });
};

const escapeHTML = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

export const txtChapterToXHTML = (chapter: TxtChapter): string => {
  const lines = chapter.text.split('\n');
  const body = lines.map((line, index) => {
    const text = line.trim();
    if (!text) return '';
    if (index === 0 && TXT_CHAPTER_HEADING.test(text)) {
      TXT_CHAPTER_HEADING.lastIndex = 0;
      return `<h1>${escapeHTML(text)}</h1>`;
    }
    TXT_CHAPTER_HEADING.lastIndex = 0;
    return `<p>${escapeHTML(text)}</p>`;
  }).join('\n');
  TXT_CHAPTER_HEADING.lastIndex = 0;
  return `<!doctype html><html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN"><head><meta charset="utf-8"/><title>${escapeHTML(chapter.title)}</title></head><body>${body}</body></html>`;
};
