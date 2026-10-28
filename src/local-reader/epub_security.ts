export const EPUB_DOCUMENT_TYPES = new Set([
  'application/xhtml+xml',
  'text/html',
  'image/svg+xml',
]);

export const STRICT_EPUB_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline' blob:; img-src blob: data:; font-src blob: data:; media-src blob: data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

const removeExecutableContent = (doc: Document): void => {
  doc.querySelectorAll(
    'script, iframe, object, embed, foreignObject, meta[http-equiv="refresh" i]',
  ).forEach(node => node.remove());
  doc.querySelectorAll('*').forEach(node => {
    for (const attribute of Array.from(node.attributes)) {
      const name = attribute.name.toLowerCase();
      const localName = attribute.localName.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc') node.removeAttribute(attribute.name);
      if (['href', 'src', 'action', 'formaction', 'poster', 'data'].includes(localName)
        && value.startsWith('javascript:')) {
        node.removeAttribute(attribute.name);
      }
      if (name === 'style' && /(?:javascript:|expression\s*\()/i.test(attribute.value)) {
        node.removeAttribute(attribute.name);
      }
    }
  });
};

const ensureHead = (doc: Document): Element => {
  const existing = doc.querySelector('head');
  if (existing) return existing;
  const namespace = doc.documentElement?.namespaceURI ?? XHTML_NAMESPACE;
  const head = doc.createElementNS(namespace, 'head');
  const root = doc.documentElement;
  if (root) root.prepend(head);
  else doc.append(head);
  return head;
};

const prependCsp = (doc: Document): void => {
  const head = ensureHead(doc);
  const meta = doc.createElementNS(head.namespaceURI ?? XHTML_NAMESPACE, 'meta');
  meta.setAttribute('http-equiv', 'Content-Security-Policy');
  meta.setAttribute('content', STRICT_EPUB_CSP);
  head.prepend(meta);
};

const escapeAttributeValue = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * 为同一文档内的多个章节锚点生成“每章起新栏”样式；分页器是原生 CSS 多栏，
 * 单列模式下新栏即新页。选择器用属性匹配规避任意 XML ID 的标识符转义问题。
 */
export const chapterBreakCss = (hashes: string[]): string => {
  const selectors = [...new Set(hashes)]
    .map(hash => `[id="${escapeAttributeValue(hash)}"], [name="${escapeAttributeValue(hash)}"]`)
    .join(', ');
  return selectors ? `${selectors} { break-before: column; }` : '';
};

export interface SanitizeOptions {
  /** KindleGen 转制书归一（仅 MOBI 管线启用）：①剥掉 p/blockquote 开头的
   * 前导全角空格（手工缩进且段落间参差）；②把 `<br/>＋全角空格` 编码的
   * 逻辑段落还原成真实段落边界（br 只有行距没有段距，是「行间贴死」的
   * 根因；实测全书 br 均为 p/blockquote 直接子级，字符串手术安全）。 */
  stripLeadingWhitespace?: boolean;
}

export const sanitizeEpubMarkup = (markup: string, mediaType: string, extraCss = '', options: SanitizeOptions = {}): string => {
  if (!EPUB_DOCUMENT_TYPES.has(mediaType)) return markup;
  const parserType = mediaType === 'text/html' ? 'text/html' : 'application/xml';
  let doc = new DOMParser().parseFromString(markup, parserType);
  if (parserType === 'application/xml' && mediaType !== 'image/svg+xml') {
    // 三类非严格 XHTML 在 XML 解析下会损坏：含 &nbsp; 等 HTML 实体、未闭合
    // 标签（如 <br>）、或缺少 xmlns 声明。前两者报 parsererror，后者虽解析
    // 成功但元素不在 XHTML 命名空间，渲染时 <p>/<br> 失去块级与换行语义，
    // 全文塌成一行。回退按 HTML 解析：宽容上述问题并自动赋 XHTML 命名空间；
    // SVG 文档根元素本就不属 XHTML 命名空间，不适用此检查。
    const root = doc.documentElement;
    // 大写标签（如 Calibre 输出的 <P>）：XML 大小写敏感，XHTML 命名空间只有
    // 小写 p，大写 P 是未知元素、无块级样式，全文塌成一行；回退 HTML 解析
    // 会自动小写化所有标签。
    const hasUppercaseTag = root !== null && Array.from(root.getElementsByTagName('*'))
      .some(node => node.localName !== node.localName.toLowerCase());
    const broken = doc.querySelector('parsererror') !== null
      || hasUppercaseTag
      || (root !== null && root.localName.toLowerCase() === 'html'
        && root.namespaceURI !== XHTML_NAMESPACE);
    if (broken) {
      doc = new DOMParser().parseFromString(markup, 'text/html');
      // HTML 解析会把源码里字面的 xmlns 当普通属性保留，序列化时与命名空间
      // 声明重复产出非法 XML；命名空间已由解析器正确赋值，字面属性是冗余的。
      for (const node of [doc.documentElement, ...doc.querySelectorAll('*')]) {
        if (node?.hasAttribute('xmlns')) node.removeAttribute('xmlns');
      }
    }
  }
  removeExecutableContent(doc);
  if (options.stripLeadingWhitespace) {
    // KindleGen 转制残留：p 上的 height/width/align 属性（如 height="1em"、
    // height="0pt"）是排版噪声，统一剥除
    for (const node of doc.querySelectorAll('p, blockquote')) {
      node.removeAttribute('height');
      node.removeAttribute('width');
      node.removeAttribute('align');
    }
    // 前导空白（KindleGen 转制手工缩进）的实际藏身处：段落容器的前几个
    // 子节点常是空 filepos 锚点或「编号链接」（<a id=filepos…></a><font>　　正文），
    // 因此不能只看首个文本节点——需横向跳过空行内元素与纯空白文本，
    // 在第一个有内容的行内分支里递归剥离；遇块级元素视为段落起点已过。
    const inlineSkip = new Set(['A', 'B', 'STRONG', 'FONT', 'SPAN', 'I', 'EM', 'U', 'SMALL', 'BIG']);
    const stripLeadingFrom = (parent: Node): void => {
      for (const child of Array.from(parent.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) {
          const text = child.textContent ?? '';
          if (text.trim()) {
            child.textContent = text.replace(/^[\s\u3000]+/, '');
          }
          continue;
        }
        if (child.nodeType === Node.ELEMENT_NODE && inlineSkip.has((child as Element).tagName)) {
          if ((child.textContent ?? '').trim()) {
            stripLeadingFrom(child);
            return;
          }
          continue;
        }
        return;
      }
    };
    for (const node of doc.querySelectorAll('p, blockquote')) stripLeadingFrom(node);
  }
  if (mediaType !== 'image/svg+xml') {
    prependCsp(doc);
    if (extraCss.trim()) {
      const head = ensureHead(doc);
      const style = doc.createElementNS(head.namespaceURI ?? XHTML_NAMESPACE, 'style');
      style.textContent = extraCss;
      head.append(style);
    }
  }
  let serialized = new XMLSerializer().serializeToString(doc);
  if (options.stripLeadingWhitespace) {
    // 两种实测形态：<br/>　　正文（空格直接跟随）与
    // </font><br/><font color="#000000">　　正文（空格在开标签内部，
    // 占比绝大多数）。序列化器输出 <br/>（WebKit）或 <br />（测试环境）
    // 两种形态都要兼容；后瞻拒绝 <（</p> 收尾等）避免误拆。
    serialized = serialized
      .replace(/<br\s*\/>\s*((?:<[a-zA-Z][^>]*>)+)[\u3000\s]*(?=[^\s<])/g, '</p><p>$1')
      .replace(/<br\s*\/>[ \t\r\n\u3000]*(?=[^\s<])/g, '</p><p>');
  }
  return serialized;
};

const finiteDimension = (value: string | null): number | null => {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const svgViewport = (svg: Element | null): [number, number] => {
  const viewBox = svg?.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite)
    && viewBox[2] > 0 && viewBox[3] > 0) {
    return [viewBox[2], viewBox[3]];
  }
  return [
    finiteDimension(svg?.getAttribute('width') ?? null) ?? 1000,
    finiteDimension(svg?.getAttribute('height') ?? null) ?? 1500,
  ];
};

/**
 * WebKit currently requires `allow-scripts` for parent listeners to receive
 * events from a same-origin sandboxed frame (WebKit bug 218086). Every SVG
 * spine document is therefore converted to XHTML with a CSP in its first head
 * element before Foliate creates the iframe Blob.
 */
export const wrapSvgSpineDocument = (markup: string): string => {
  const sanitized = sanitizeEpubMarkup(markup, 'image/svg+xml');
  const svgDocument = new DOMParser().parseFromString(sanitized, 'application/xml');
  const svg = svgDocument.documentElement?.localName === 'svg'
    ? svgDocument.documentElement
    : svgDocument.querySelector('svg');
  const [width, height] = svgViewport(svg);
  const serializedSvg = svg ? new XMLSerializer().serializeToString(svg) : '';
  return `<!DOCTYPE html><html xmlns="${XHTML_NAMESPACE}"><head><meta http-equiv="Content-Security-Policy" content="${STRICT_EPUB_CSP}"/><meta name="viewport" content="width=${width},height=${height}"/><style>html,body,svg{margin:0;width:100%;height:100%;overflow:hidden}</style></head><body>${serializedSvg}</body></html>`;
};
