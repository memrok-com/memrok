import type { ContextHeader, ResolvedConfig } from "./types.js";

export class DaemonClient {
  private config: ResolvedConfig;
  private cachedHeader: string | null = null;

  constructor(config: ResolvedConfig) {
    this.config = config;
  }

  /** Fetch context header from daemon. Returns cached/empty on failure. */
  async fetchHeader(recentMessages?: string): Promise<string> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (attempt > 0) {
        await sleep(this.config.retryMs);
      }
      try {
        const header = await this.doFetchHeader(recentMessages);
        this.cachedHeader = header;
        return header;
      } catch (err) {
        lastError = err;
      }
    }

    // All attempts failed — degrade gracefully
    if (lastError) {
      console.warn(`[memrok] daemon unreachable: ${lastError}`);
    }
    return this.cachedHeader ?? "";
  }

  private async doFetchHeader(recentMessages?: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const body = recentMessages ? JSON.stringify({ recentMessages }) : undefined;
      const res = await fetch(`${this.config.daemonUrl}/header`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`daemon returned ${res.status}`);
      }

      const data = (await res.json()) as ContextHeader;
      return data.text;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Fire-and-forget notify to daemon. Never throws. */
  notifyTurn(sessionId: string): void {
    const body = JSON.stringify({ sessionId });
    fetch(`${this.config.daemonUrl}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }).catch((err) => {
      console.warn(`[memrok] notify failed: ${err}`);
    });
  }

  /** Get the last cached header (for testing). */
  getCachedHeader(): string | null {
    return this.cachedHeader;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
