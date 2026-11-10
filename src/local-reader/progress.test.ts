import { describe, expect, it } from 'bun:test';
import { computeBookFraction } from './progress';

describe('书级进度按篇幅加权', () => {
  it('等篇幅时与章节计数法一致', () => {
    const sections = [{ size: 100 }, { size: 100 }, { size: 100 }, { size: 100 }];
    expect(computeBookFraction(sections, 1, 0.5)).toBeCloseTo(0.375);
    expect(computeBookFraction(sections, 0, 0)).toBe(0);
  });

  it('短章在前不再虚高：进入正文章时进度贴近真实篇幅', () => {
    // 前言 5%、正文 95%：进入正文章开头 ≈ 5%，而非计数法的 1/10
    const sections = [{ size: 5 }, { size: 95 }];
    expect(computeBookFraction(sections, 1, 0)).toBeCloseTo(0.05);
    expect(computeBookFraction(sections, 1, 0.5)).toBeCloseTo(0.525);
  });

  it('size 缺失或非正数的 section 退回等权', () => {
    const sections = [{ size: 0 }, {}, { size: -3 }, { size: 40 }];
    // 退化权重 [1,1,1,40]：index 2 fraction 1 → (2 + 1)/43
    expect(computeBookFraction(sections, 2, 1)).toBeCloseTo(3 / 43);
  });

  it('越界索引与超范围 fraction 被钳制', () => {
    const sections = [{ size: 1 }, { size: 3 }];
    expect(computeBookFraction(sections, 9, 0)).toBeCloseTo(0.25);
    expect(computeBookFraction(sections, 9, 1)).toBe(1);
    expect(computeBookFraction(sections, 0, 5)).toBeCloseTo(0.25);
    expect(computeBookFraction(sections, -3, 0.5)).toBeCloseTo(0.125);
  });

  it('空书返回 0', () => {
    expect(computeBookFraction([], 0, 0.5)).toBe(0);
  });
});
