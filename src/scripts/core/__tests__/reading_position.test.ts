import { afterEach, describe, expect, it, mock } from 'bun:test';
import { getReadingPosition, saveReadingPosition } from '../reading_position';

const originalTauri = window.__TAURI__;

afterEach(() => {
  window.__TAURI__ = originalTauri;
});

describe('reading position bridge', () => {
  it('loads only the requested site and URL entry', async () => {
    const invokeMock = mock(async () => 321);
    window.__TAURI__ = {
      core: { invoke: invokeMock },
      event: { listen: async () => () => undefined },
    } as any;

    await expect(getReadingPosition('demo', 'https://example.com/book/1')).resolves.toBe(321);
    expect(invokeMock).toHaveBeenCalledWith('get_reading_position', {
      siteId: 'demo',
      url: 'https://example.com/book/1',
    });
  });

  it('preserves a missing position as null', async () => {
    window.__TAURI__ = {
      core: { invoke: async () => null },
      event: { listen: async () => () => undefined },
    } as any;

    await expect(getReadingPosition('demo', 'https://example.com/new')).resolves.toBeNull();
  });

  it('saves one numeric position and propagates backend rejection', async () => {
    const invokeMock = mock(async (command: string) => {
      if (command === 'save_reading_position') throw new Error('disk full');
    });
    window.__TAURI__ = {
      core: { invoke: invokeMock },
      event: { listen: async () => () => undefined },
    } as any;

    await expect(saveReadingPosition('demo', 'https://example.com/book/1', 99))
      .rejects.toThrow('disk full');
    expect(invokeMock).toHaveBeenCalledWith('save_reading_position', {
      siteId: 'demo',
      url: 'https://example.com/book/1',
      position: 99,
    });
  });
});
