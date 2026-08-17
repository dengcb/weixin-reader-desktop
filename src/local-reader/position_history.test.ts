import { describe, expect, it } from 'bun:test';
import { PositionHistory } from './position_history';

describe('本地阅读位置历史', () => {
  it('保留跳转起点，并支持后退和前进', async () => {
    const history = new PositionHistory<string>();
    let current = 'A';
    history.reset(current);
    await history.record(current, () => { current = 'B'; }, () => current);
    expect(await history.back(value => { current = value; })).toBe(true);
    expect(current).toBe('A');
    expect(await history.forward(value => { current = value; })).toBe(true);
    expect(current).toBe('B');
  });

  it('导航失败后不会卡在移动状态，也不会提交目标位置', async () => {
    const history = new PositionHistory<string>();
    history.reset('A');
    await expect(history.record('A', () => { throw new Error('failed'); }, () => 'B'))
      .rejects.toThrow('failed');
    expect(await history.back(() => {})).toBe(false);
    await history.record('A', () => {}, () => 'C');
    let current = 'C';
    expect(await history.back(value => { current = value; })).toBe(true);
    expect(current).toBe('A');
  });
});
