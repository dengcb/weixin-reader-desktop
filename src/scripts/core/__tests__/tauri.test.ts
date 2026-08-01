import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
  invoke,
  listen,
  logToFile,
  waitForTauri,
  waitForTauriReady,
} from '../tauri';

const originalTauri = window.__TAURI__;

afterEach(() => {
  window.__TAURI__ = originalTauri;
});

describe('Tauri bridge', () => {
  it('looks up the injected API dynamically for invoke and listen', async () => {
    const invokeMock = mock(async (command: string, args?: Record<string, unknown>) => ({ command, args }));
    const unlisten = mock(() => undefined);
    const listenMock = mock(async (_event: string, _handler: (event: { payload: unknown }) => void) => unlisten);
    window.__TAURI__ = {
      core: { invoke: invokeMock },
      event: { listen: listenMock },
    } as any;

    await expect(invoke('demo', { value: 1 })).resolves.toEqual({
      command: 'demo',
      args: { value: 1 },
    });
    const cancel = await listen('changed', () => undefined);
    cancel();

    expect(invokeMock).toHaveBeenCalledWith('demo', { value: 1 });
    expect(listenMock).toHaveBeenCalledTimes(1);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('provides harmless fallbacks before Tauri is injected', async () => {
    window.__TAURI__ = undefined as any;

    await expect(invoke('missing')).resolves.toEqual({});
    const cancel = await listen('missing', () => undefined);
    expect(cancel()).toBeUndefined();
  });

  it('waits until the global API appears and removes its polling work', async () => {
    window.__TAURI__ = undefined as any;
    const waiting = waitForTauri();
    setTimeout(() => {
      window.__TAURI__ = {
        core: { invoke: async () => undefined },
        event: { listen: async () => () => undefined },
      } as any;
    }, 20);

    await expect(waiting).resolves.toBeUndefined();
  });

  it('resolves immediately when aborted before or during the wait', async () => {
    window.__TAURI__ = undefined as any;
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(waitForTauri(alreadyAborted.signal)).resolves.toBeUndefined();

    const controller = new AbortController();
    const waiting = waitForTauri(controller.signal);
    controller.abort();
    await expect(waiting).resolves.toBeUndefined();
  });

  it('retries the readiness probe until IPC succeeds', async () => {
    let attempts = 0;
    window.__TAURI__ = {
      core: {
        invoke: async () => {
          attempts++;
          if (attempts < 3) throw new Error('not ready');
          return '艾特阅读';
        },
      },
      event: { listen: async () => () => undefined },
    } as any;

    await waitForTauriReady();
    expect(attempts).toBe(3);
  });

  it('stops readiness retries when its signal is aborted', async () => {
    const controller = new AbortController();
    let attempts = 0;
    window.__TAURI__ = {
      core: {
        invoke: async () => {
          attempts++;
          controller.abort();
          throw new Error('not ready');
        },
      },
      event: { listen: async () => () => undefined },
    } as any;

    await waitForTauriReady(controller.signal);
    expect(attempts).toBe(1);
  });

  it('routes file logging through IPC without leaking a rejected promise', async () => {
    const invokeMock = mock(async () => {
      throw new Error('log unavailable');
    });
    window.__TAURI__ = {
      core: { invoke: invokeMock },
      event: { listen: async () => () => undefined },
    } as any;

    expect(logToFile('hello')).toBeUndefined();
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledWith('log_to_file', { message: 'hello' });
  });
});
