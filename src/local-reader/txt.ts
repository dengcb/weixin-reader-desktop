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
// PDF 提取文本的第二形态：KindleGen/排版工具常把章节标成「中文数字序号 +
// 空格分隔标题」（「一   宇 宙 一 律」「二 、 宇 宙 元 规 律」），无「章」字。
// 序号限中文数字；标题段禁句读标点防正文列举行误判；仅 PDF 路径传入，
// 且全书 ≥2 处命中才启用（见 splitTxtChapters）。
export const PDF_CHAPTER_HEADING = new RegExp(
  `^[\\t ]*[〇零一二三四五六七八九十百千]{1,3}[\\t \\u3000]*[、．.]?[\\t \\u3000]*[\\u4e00-\\u9fffA-Za-z0-9][^\\n。，；！？：""''「」]{0,24}[\\t \\u3000]*$`,
  'gim',
);

export const splitTxtChapters = (input: string, bookTitle: string, extraHeadings: RegExp[] = []): TxtChapter[] => {
  const text = input.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  const patterns = [TXT_CHAPTER_HEADING, ...extraHeadings];
  const matches = patterns
    .map(pattern => {
      pattern.lastIndex = 0;
      const found = [...text.matchAll(pattern)].map(match => ({
        index: match.index ?? 0,
        text: match[0],
        pattern,
      }));
      pattern.lastIndex = 0;
      return found;
    })
    .flat()
    // 同一位置只保留一个命中（多正则可能重叠），按出现顺序排列
    .sort((a, b) => a.index - b.index || b.text.length - a.text.length)
    .filter((match, index, all) => index === 0 || match.index !== all[index - 1].index);
  // 第二形态门槛：附加正则命中不足 2 处视为正文巧合，不启用（防单行误切）
  const effective = matches.filter(match => {
    if (match.pattern === TXT_CHAPTER_HEADING) return true;
    const extraCount = matches.filter(m => m.pattern !== TXT_CHAPTER_HEADING).length;
    return extraCount >= 2;
  });
  if (effective.length === 0) {
    return [{ id: 'txt-0', title: bookTitle, text, start: 0 }];
  }
  // 首个标题前的正文（序/楔子/前言）不属于任何匹配章节：标题在正文开头
  // 时不存在前导内容，单独成章时按书名命名，避免“楔子被并进第一章”。
  const firstHeadingStart = effective[0].index;
  const prefix = text.slice(0, firstHeadingStart).trim();
  const preamble = prefix
    ? [{ id: 'txt-pre', title: prefix.length <= 80 ? prefix.split('\n')[0] : bookTitle, text: prefix, start: 0 }]
    : [];
  return [...preamble, ...effective.map((match, index) => {
    const start = match.index;
    const end = effective[index + 1]?.index ?? text.length;
    return {
      id: `txt-${index}`,
      title: match.text.trim(),
      text: text.slice(start, end).trim(),
      start,
    };
  })];
};

const escapeHTML = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const isChapterTitleLine = (text: string): boolean => {
  for (const pattern of [TXT_CHAPTER_HEADING, PDF_CHAPTER_HEADING]) {
    pattern.lastIndex = 0;
    const hit = pattern.test(text);
    pattern.lastIndex = 0;
    if (hit) return true;
  }
  return false;
};

export const txtChapterToXHTML = (chapter: TxtChapter): string => {
  const lines = chapter.text.split('\n');
  const body = lines.map((line, index) => {
    const text = line.trim();
    if (!text) return '';
    if (index === 0 && isChapterTitleLine(text)) {
      return `<h1>${escapeHTML(text)}</h1>`;
    }
    TXT_CHAPTER_HEADING.lastIndex = 0;
    return `<p>${escapeHTML(text)}</p>`;
  }).join('\n');
  TXT_CHAPTER_HEADING.lastIndex = 0;
  // application/xhtml+xml 按 XML 解析：小写 <!doctype html> 会报 invalid element name，用 XML 声明替代
  return `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN"><head><meta charset="utf-8"/><title>${escapeHTML(chapter.title)}</title></head><body>${body}</body></html>`;
};
