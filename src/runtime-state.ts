import { MailService } from './services/mail.js';
import { TieredRateLimiter } from './utils/rate-limiter.js';

export class MailMCPRuntimeState {
  readonly services = new Map<string, MailService>();
  readonly serviceCreations = new Map<string, Promise<MailService>>();
  readonly rateLimiter = new TieredRateLimiter();

  private shuttingDown = false;

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    await Promise.allSettled(
      Array.from(this.services.values()).map(service => service.disconnect())
    );
    this.services.clear();
    this.serviceCreations.clear();
  }
}
