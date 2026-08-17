import { describe, expect, test } from 'bun:test';
import { buildToc } from './toc';

describe('目录建树', () => {
  test('平铺数组保持深度优先顺序，树节点持有平铺位置', () => {
    const { flat, tree } = buildToc([
      {
        label: '第一部',
        href: 'part1',
        subitems: [
          { label: '第1章', href: 'p1c1' },
          { label: '第2章', href: 'p1c2#ch2' },
        ],
      },
      {
        label: '第二部',
        href: 'part2',
        subitems: [
          { label: { zh: '第3章' }, href: 'p2c1' },
        ],
      },
      { label: '附录', href: 'appendix' },
    ]);

    expect(flat.map(item => item.href)).toEqual(['part1', 'p1c1', 'p1c2#ch2', 'part2', 'p2c1', 'appendix']);
    expect(flat.map(item => item.label)).toEqual(['第一部', '第1章', '第2章', '第二部', '第3章', '附录']);
    expect(flat.every(item => item.index === -1)).toBe(true);
    expect(flat.map(item => item.hash ?? '')).toEqual(['', '', 'ch2', '', '', '']);

    expect(tree.map(node => node.position)).toEqual([0, 3, 5]);
    expect(tree[0]!.children.map(node => node.href)).toEqual(['p1c1', 'p1c2#ch2']);
    expect(tree[1]!.children[0]!.position).toBe(4);
    expect(tree[2]!.children).toEqual([]);
  });

  test('空 subitems 视为叶子，缺失标签回退未命名章节', () => {
    const { flat, tree } = buildToc([
      { label: '序', href: 'p0', subitems: [] },
      { href: 'p1' },
    ]);

    expect(tree[0]!.children).toEqual([]);
    expect(flat.map(item => item.label)).toEqual(['序', '未命名章节']);
  });

  test('多语言标签取第一个非空值', () => {
    const { flat } = buildToc([{ label: { en: '', zh: '目录' }, href: 'x' }]);
    expect(flat[0]!.label).toBe('目录');
  });
});
