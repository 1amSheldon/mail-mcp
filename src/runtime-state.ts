import { MailService } from './services/mail.js';
import { TieredRateLimiter } from './utils/rate-limiter.js';

export class MailMCPRuntimeState {
  readonly services = new Map<string, MailService>();
  readonly serviceCreations = new Map<string, Promise<MailService>>();
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
      await Promise.allSettled(Array.from(this.serviceCreations.values()));
      await Promise.allSettled(
        Array.from(this.services.values()).map(service => service.disconnect())
      );
      this.services.clear();
      this.serviceCreations.clear();
    })();
    return this.shutdownPromise;
  }
}
