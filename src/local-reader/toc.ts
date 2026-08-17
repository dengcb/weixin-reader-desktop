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
  // 转换器（如 VBook）常为无分卷书生成一个仅含包装的顶层节点（“不分卷”等）。
  // 全书仅此一个分组时不提供任何层级信息，展开其子级作为顶层目录：
  // 导航栏回退书名，章节面板不再出现孤立的包装分组。
  const roots = items.length === 1 && items[0].subitems?.length
    ? items[0].subitems
    : items;
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
  return { flat, tree: walk(roots) };
};

const subtreeEnd = (node: TocTreeNode): number => node.children.length
  ? subtreeEnd(node.children[node.children.length - 1]!)
  : node.position;

/**
 * 当前位置严格位于某个顶层分组的后代内时返回该分组标签，否则返回 null；
 * 用于导航栏“一级名 | 二级名”，平铺目录恒为 null。
 */
export const findTopLevelGroup = (tree: TocTreeNode[], position: number): string | null => {
  for (const node of tree) {
    if (node.position < position && position <= subtreeEnd(node)) return node.label;
  }
  return null;
};
