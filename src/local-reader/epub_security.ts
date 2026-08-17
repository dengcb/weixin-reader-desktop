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

export const sanitizeEpubMarkup = (markup: string, mediaType: string, extraCss = ''): string => {
  if (!EPUB_DOCUMENT_TYPES.has(mediaType)) return markup;
  const parserType = mediaType === 'text/html' ? 'text/html' : 'application/xml';
  const doc = new DOMParser().parseFromString(markup, parserType);
  removeExecutableContent(doc);
  if (mediaType !== 'image/svg+xml') {
    prependCsp(doc);
    if (extraCss.trim()) {
      const head = ensureHead(doc);
      const style = doc.createElementNS(head.namespaceURI ?? XHTML_NAMESPACE, 'style');
      style.textContent = extraCss;
      head.append(style);
    }
  }
  return new XMLSerializer().serializeToString(doc);
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
