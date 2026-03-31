import type { ContextHeader, ResolvedConfig } from "./types.js";

export class DaemonClient {
  private config: ResolvedConfig;
  private cachedHeader: string | null = null;

  constructor(config: ResolvedConfig) {
    this.config = config;
  }

  /** Fetch context header from daemon. No retries (hot path for assemble). Returns cached/empty on failure. */
  async fetchHeader(recentMessages?: string): Promise<string> {
    try {
      const header = await this.doFetchHeader(recentMessages);
      this.cachedHeader = header;
      return header;
    } catch (err) {
      console.warn(`[memrok] daemon unreachable: ${err}`);
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
