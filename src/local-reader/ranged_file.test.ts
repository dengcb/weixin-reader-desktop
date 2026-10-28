import { describe, expect, it } from 'bun:test';
import { RangedFile } from './ranged_file';

describe('RangedFile 区间收拢', () => {
  it('请求越界时收拢到 [0, size]', async () => {
    const requested: Array<[number, number]> = [];
    const file = new RangedFile(async (start, end) => {
      requested.push([start, end]);
      return new ArrayBuffer(end - start);
    }, 100);
    await file.slice(-20, 30).arrayBuffer();
    await file.slice(90, 500).arrayBuffer();
    expect(requested).toEqual([[0, 30], [90, 100]]);
  });
  it('空切片不发起请求', async () => {
    let calls = 0;
    const file = new RangedFile(async () => {
      calls += 1;
      return new ArrayBuffer(0);
    }, 10);
    const buffer = await file.slice(5, 5).arrayBuffer();
    expect(buffer.byteLength).toBe(0);
    expect(calls).toBe(0);
  });

  it('size 负值归一为 0 且任何切片为空', async () => {
    const file = new RangedFile(async () => {
      throw new Error('不应请求');
    }, -3);
    expect(file.size).toBe(0);
    expect((await file.slice(0, 10).arrayBuffer()).byteLength).toBe(0);
  });
});
