import type { ConsolidationConfig } from './types.js';

const DEFAULT_DELTA_THRESHOLD = 20;
const DEFAULT_IDLE_MINUTES = 15;
const DEFAULT_MAX_INTERVAL = 120;

export interface ConsolidationState {
  newMessageCount: number;
  lastMessageTime: number;
  lastPassTime: number;
}

export type TriggerCallback = () => void | Promise<void>;

export class ConsolidationEngine {
  private deltaThreshold: number;
  private idleMinutes: number;
  private maxInterval: number;
  private state: ConsolidationState;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private onTrigger: TriggerCallback | null = null;
  private triggering = false;

  constructor(config?: ConsolidationConfig) {
    this.deltaThreshold = config?.deltaThreshold ?? DEFAULT_DELTA_THRESHOLD;
    this.idleMinutes = config?.idleMinutes ?? DEFAULT_IDLE_MINUTES;
    this.maxInterval = config?.maxInterval ?? DEFAULT_MAX_INTERVAL;
    this.state = {
      newMessageCount: 0,
      lastMessageTime: Date.now(),
      lastPassTime: Date.now(),
    };
  }

  setTriggerCallback(cb: TriggerCallback): void {
    this.onTrigger = cb;
  }

  recordMessages(count: number): void {
    this.state.newMessageCount += count;
    this.state.lastMessageTime = Date.now();
  }

  recordPassComplete(): void {
    this.state.newMessageCount = 0;
    this.state.lastPassTime = Date.now();
  }

  shouldTrigger(now?: number): { trigger: boolean; reason: string } {
    const currentTime = now ?? Date.now();
    const idleMs = currentTime - this.state.lastMessageTime;
    const idleThresholdMs = this.idleMinutes * 60 * 1000;
    const sinceLastPass = currentTime - this.state.lastPassTime;
    const maxIntervalMs = this.maxInterval * 60 * 1000;

    // Max interval elapsed — trigger regardless
    if (sinceLastPass >= maxIntervalMs && this.state.newMessageCount > 0) {
      return { trigger: true, reason: 'max_interval' };
    }

    // Delta threshold met AND idle long enough
    if (this.state.newMessageCount >= this.deltaThreshold && idleMs >= idleThresholdMs) {
      return { trigger: true, reason: 'delta_and_idle' };
    }

    return { trigger: false, reason: 'none' };
  }

  async forceTrigger(): Promise<void> {
    if (this.onTrigger && !this.triggering) {
      this.triggering = true;
      try {
        await this.onTrigger();
        this.recordPassComplete();
      } catch (err) {
        console.warn(`[consolidation] Trigger callback failed, counter NOT reset: ${err}`);
      } finally {
        this.triggering = false;
      }
    }
  }

  startLoop(intervalMs = 60_000): void {
    if (this.checkTimer) return;
    this.checkTimer = setInterval(async () => {
      try {
        const { trigger } = this.shouldTrigger();
        if (trigger && this.onTrigger && !this.triggering) {
          this.triggering = true;
          try {
            await this.onTrigger();
            this.recordPassComplete();
          } catch (err) {
            console.warn(`[consolidation] Trigger callback failed, counter NOT reset: ${err}`);
          } finally {
            this.triggering = false;
          }
        }
      } catch (err) {
        console.warn(`[consolidation] Error in check loop: ${err}`);
      }
    }, intervalMs);
  }

  stopLoop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  getState(): ConsolidationState {
    return { ...this.state };
  }

  /** Exposed for testing: override internal state */
  _setState(partial: Partial<ConsolidationState>): void {
    Object.assign(this.state, partial);
  }
}
