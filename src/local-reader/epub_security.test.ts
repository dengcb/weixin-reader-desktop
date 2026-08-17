import { describe, expect, it } from 'bun:test';
import { chapterBreakCss, sanitizeEpubMarkup, wrapSvgSpineDocument } from './epub_security';

describe('本地 EPUB 内容安全', () => {
  it('在创建 iframe Blob 前移除脚本、事件处理器和可执行嵌入内容', () => {
    const sanitized = sanitizeEpubMarkup(`<!doctype html><html><head>
      <meta http-equiv="refresh" content="0;url=https://example.com">
      <script>alert('bad')</script></head><body onload="alert(1)">
      <a href="javascript:alert(2)">bad</a>
      <iframe srcdoc="<script>alert(3)</script>"></iframe>
      <p style="background: expression(alert(4))">正文</p>
    </body></html>`, 'text/html');

    expect(sanitized).not.toContain('<script');
    expect(sanitized).not.toContain('<iframe');
    expect(sanitized).not.toContain('onload=');
    expect(sanitized).not.toContain('javascript:');
    expect(sanitized).not.toContain('http-equiv="refresh"');
    expect(sanitized).toContain("script-src 'none'");
    expect(sanitized).toContain('正文');
  });

  it('为缺少 head 的 XHTML 补上严格 CSP', () => {
    const sanitized = sanitizeEpubMarkup(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body>正文</body></html>',
      'application/xhtml+xml',
    );
    expect(sanitized).toContain('<head><meta http-equiv="Content-Security-Policy"');
    expect(sanitized).toContain("script-src 'none'");
  });

  it('生成每章起新栏样式并转义特殊字符', () => {
    expect(chapterBreakCss([])).toBe('');
    expect(chapterBreakCss(['ch1'])).toBe('[id="ch1"], [name="ch1"] { break-before: column; }');
    expect(chapterBreakCss(['a', 'a'])).toBe(chapterBreakCss(['a']));
    expect(chapterBreakCss(['x"y'])).toBe('[id="x\\"y"], [name="x\\"y"] { break-before: column; }');
  });

  it('非严格 XHTML 回退 HTML 解析：缺 xmlns、HTML 实体、未闭合标签', () => {
    const noXmlns = sanitizeEpubMarkup(
      '<html><head><title>t</title></head><body><p>一</p><p>二<br/>三</p></body></html>',
      'application/xhtml+xml',
    );
    expect(noXmlns).toContain('xmlns="http://www.w3.org/1999/xhtml"');
    expect(noXmlns).toContain('<p>一</p>');
    expect(noXmlns).toContain('二<br />三');

    const entity = sanitizeEpubMarkup(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>甲&nbsp;乙</p></body></html>',
      'application/xhtml+xml',
    );
    expect(entity).not.toContain('parsererror');
    expect(entity).toContain('甲');
    expect(entity).toContain('乙');
    expect(entity.match(/xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/g)).toHaveLength(1);

    const unclosed = sanitizeEpubMarkup(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>甲<br>乙</p></body></html>',
      'application/xhtml+xml',
    );
    expect(unclosed).not.toContain('parsererror');
    expect(unclosed).toContain('乙');
    expect(unclosed).toContain("script-src 'none'");
  });

  it('大写标签（Calibre 风格 <P>）回退 HTML 解析小写化，恢复块级段落', () => {
    const out = sanitizeEpubMarkup(
      `<?xml version='1.0' encoding='utf-8'?>\r\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body><strong>第1章</strong>\r\n<P>第一段</P>\r\n<P>第二段</P></body></html>`,
      'application/xhtml+xml',
    );
    expect(out).not.toMatch(/<P[ >]/);
    expect((out.match(/<p[ >]/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(out).toContain('第一段');
    expect(out).toContain('第二段');
  });

  it('在消毒后注入额外章节分栏样式', () => {
    const sanitized = sanitizeEpubMarkup(
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body><h1 id="c1">章</h1></body></html>',
      'application/xhtml+xml',
      chapterBreakCss(['c1']),
    );
    expect(sanitized).toContain('break-before: column');
    expect(sanitized).toContain("script-src 'none'");
    expect(sanitized).toContain('<h1 id="c1">');
  });

  it('清理 SVG 并将 spine SVG 包装为带 CSP 和 viewport 的 XHTML', () => {
    const wrapped = wrapSvgSpineDocument(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800" onload="alert(1)">
        <script>alert(2)</script>
        <foreignObject><iframe src="https://example.com"/></foreignObject>
        <text x="10" y="20">正文</text>
      </svg>
    `);
    expect(wrapped).toContain('<html xmlns="http://www.w3.org/1999/xhtml">');
    expect(wrapped).toContain('content="width=600,height=800"');
    expect(wrapped).toContain("script-src 'none'");
    expect(wrapped).toContain('正文');
    expect(wrapped).not.toContain('<script');
    expect(wrapped).not.toContain('<iframe');
    expect(wrapped).not.toContain('foreignObject');
    expect(wrapped).not.toContain('onload=');
  });
});
