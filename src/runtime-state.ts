import { MailService } from './services/mail.js';
import type { AppleMailAdapter } from './providers/apple-mail/adapter.js';
import type { MailtrapClient } from './providers/mailtrap/client.js';
import type { EwsClient } from './providers/microsoft/ews.js';
import type { MicrosoftGraphClient } from './providers/microsoft/graph.js';
import { TieredRateLimiter } from './utils/rate-limiter.js';
import { PaginationSnapshotStore } from './utils/pagination-store.js';
import type { AppleMailMessageSummary } from './providers/apple-mail/types.js';

export type RuntimeProviderClient =
  | AppleMailAdapter
  | MicrosoftGraphClient
  | EwsClient
  | MailtrapClient;

async function disconnectIfSupported(client: unknown): Promise<void> {
  if (
    typeof client === 'object'
    && client !== null
    && 'disconnect' in client
    && typeof client.disconnect === 'function'
  ) {
    await client.disconnect();
  }
}

export class MailMCPRuntimeState {
  readonly services = new Map<string, MailService>();
  readonly serviceCreations = new Map<string, Promise<MailService>>();
  readonly appleMailAdapters = new Map<string, AppleMailAdapter>();
  readonly microsoftGraphClients = new Map<string, MicrosoftGraphClient>();
  readonly ewsClients = new Map<string, EwsClient>();
  readonly mailtrapClients = new Map<string, MailtrapClient>();
  readonly providerCreations = new Map<string, Promise<RuntimeProviderClient>>();
  readonly appleMailPages = new PaginationSnapshotStore<AppleMailMessageSummary>({
    maxItemsPerSnapshot: 10_000,
    maxPageSize: 100,
  });
  readonly rateLimiter = new TieredRateLimiter();

  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;

    this.shutdownPromise = (async () => {
      await Promise.allSettled([
        ...this.serviceCreations.values(),
        ...this.providerCreations.values(),
      ]);
      await Promise.allSettled(
        Array.from(this.services.values()).map(service => service.disconnect())
      );
      const providerClients = new Set<RuntimeProviderClient>([
        ...this.appleMailAdapters.values(),
        ...this.microsoftGraphClients.values(),
        ...this.ewsClients.values(),
        ...this.mailtrapClients.values(),
      ]);
      await Promise.allSettled(
        Array.from(providerClients).map(client => disconnectIfSupported(client))
      );
      this.services.clear();
      this.serviceCreations.clear();
      this.appleMailAdapters.clear();
      this.microsoftGraphClients.clear();
      this.ewsClients.clear();
      this.mailtrapClients.clear();
      this.appleMailPages.clear();
      this.providerCreations.clear();
    })();
    return this.shutdownPromise;
  }
}
