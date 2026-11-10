/// 书级阅读进度：按 section 篇幅加权（EPUB=zip 条目字节、MOBI=记录长度、
/// TXT/PDF=字符数，loader/foliate 各自填好 section.size），替代旧的
/// 「章节序号/总章数」计数法——章节长短不均时计数法严重偏离真实阅读进度
/// （2026-11-09 用户实证：翻几页即显示 10%+）。size 缺失/非正数的 section
/// 退回等权 1，退化后仍单调、有界。
export const computeBookFraction = (
  sections: ReadonlyArray<{ size?: number }>,
  index: number,
  fraction: number,
): number => {
  const count = sections.length;
  if (!count) return 0;
  const safeIndex = Math.min(Math.max(0, Math.trunc(index)), count - 1);
  const weightAt = (i: number): number => {
    const size = sections[i]?.size;
    return Number.isFinite(size) && (size as number) > 0 ? (size as number) : 1;
  };
  const clampedFraction = Math.min(1, Math.max(0, fraction));
  let before = 0;
  let total = 0;
  for (let i = 0; i < count; i++) {
    const weight = weightAt(i);
    if (i < safeIndex) before += weight;
    total += weight;
  }
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, (before + clampedFraction * weightAt(safeIndex)) / total));
};
