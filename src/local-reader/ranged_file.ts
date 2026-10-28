/**
 * atreader:// 区间读取的惰性文件替身，替代「整本 fetch 成 Blob」。
 * vendored mobi.js 对文件对象的全部用法只有 slice(a, b).arrayBuffer()
 * （已审计，无 text/stream/size 之外的消费），按同样形状按需取字节，
 * 打开大书不再整本进内存。
 */
export type SliceFetcher = (start: number, end: number) => Promise<ArrayBuffer>;

export class RangedFile {
  readonly size: number;

  constructor(
    private readonly fetchSlice: SliceFetcher,
    size: number,
  ) {
    this.size = Math.max(0, size);
  }

  /** 与 Blob.slice 对齐：end 可省略（到文件尾），越界收拢到 [0, size]。 */
  slice(start: number, end = this.size): { arrayBuffer(): Promise<ArrayBuffer> } {
    const from = Math.max(0, Math.min(this.size, start));
    const to = Math.max(from, Math.min(this.size, end));
    return {
      arrayBuffer: () => (to <= from
        ? Promise.resolve(new ArrayBuffer(0))
        : this.fetchSlice(from, to)),
    };
  }
}
