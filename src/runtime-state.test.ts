import { describe, expect, it, vi } from 'vitest';
import type { MailService } from './services/mail.js';
import { MailMCPRuntimeState } from './runtime-state.js';

describe('MailMCPRuntimeState shutdown', () => {
  it('waits for an in-progress service creation and then disconnects the service', async () => {
    const state = new MailMCPRuntimeState();
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const service = { disconnect } as unknown as MailService;
    let finishCreation!: () => void;
    const creation = new Promise<MailService>(resolve => {
      finishCreation = () => {
        state.services.set('work', service);
        resolve(service);
      };
    });
    state.serviceCreations.set('work', creation);

    const shutdown = state.shutdown();
    expect(state.isShuttingDown).toBe(true);
    expect(disconnect).not.toHaveBeenCalled();

    finishCreation();
    await shutdown;

    expect(disconnect).toHaveBeenCalledOnce();
    expect(state.services.size).toBe(0);
    expect(state.serviceCreations.size).toBe(0);
  });

  it('makes concurrent callers wait for the same disconnect operation', async () => {
    const state = new MailMCPRuntimeState();
    let releaseDisconnect!: () => void;
    let markDisconnectStarted!: () => void;
    const disconnectGate = new Promise<void>(resolve => { releaseDisconnect = resolve; });
    const disconnectStarted = new Promise<void>(resolve => { markDisconnectStarted = resolve; });
    const disconnect = vi.fn(async () => {
      markDisconnectStarted();
      await disconnectGate;
    });
    state.services.set('work', { disconnect } as unknown as MailService);

    const first = state.shutdown();
    await disconnectStarted;
    let secondFinished = false;
    const second = state.shutdown().then(() => { secondFinished = true; });
    await Promise.resolve();

    expect(secondFinished).toBe(false);
    expect(disconnect).toHaveBeenCalledOnce();

    releaseDisconnect();
    await Promise.all([first, second]);
    expect(secondFinished).toBe(true);
  });
});
