export class BackgroundModelRefreshCoordinator {
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly refreshFn: () => Promise<void>,
    private readonly logger?: { error: (message: string, error: unknown) => void }
  ) {}

  trigger(): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = (async () => {
      try {
        await this.refreshFn();
      } catch (error) {
        this.logger?.error("Background refresh failed", error);
      } finally {
        this.inFlight = null;
      }
    })();

    return this.inFlight;
  }

  isInFlight(): boolean {
    return this.inFlight !== null;
  }
}
