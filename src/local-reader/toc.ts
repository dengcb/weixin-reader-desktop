export interface FlatTocItem {
  label: string;
  href: string;
  /** URL fragment；同 section 内多章靠它区分（整部一书、章为锚点的 EPUB）。 */
  hash?: string;
  index: number;
}

export interface TocTreeNode {
  label: string;
  href: string;
  position: number;
  children: TocTreeNode[];
}

export interface RawTocItem {
  label?: string | Record<string, string>;
  href: string;
  subitems?: RawTocItem[];
}

const localized = (value: string | Record<string, string> | undefined, fallback: string): string => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    const first = Object.values(value).find(item => typeof item === 'string' && item.trim());
    if (first) return first.trim();
  }
  return fallback;
};

/**
 * 深度优先同时产出平铺数组与渲染树。平铺数组沿用为导航、高亮与顶栏标题的
 * 唯一事实来源；树节点只额外持有自己在平铺数组中的位置，渲染层不另建索引。
 */
export const buildToc = (items: RawTocItem[]): { flat: FlatTocItem[]; tree: TocTreeNode[] } => {
  const flat: FlatTocItem[] = [];
  const walk = (nodes: RawTocItem[]): TocTreeNode[] => nodes.map((node) => {
    const position = flat.length;
    flat.push({
      label: localized(node.label, '未命名章节'),
      href: node.href,
      hash: node.href.split('#')[1] || undefined,
      index: -1,
    });
    const children = node.subitems?.length ? walk(node.subitems) : [];
    return { label: flat[position]!.label, href: node.href, position, children };
  });
  return { flat, tree: walk(items) };
};
