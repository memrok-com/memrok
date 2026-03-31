import { DaemonClient } from "./client.js";
import type {
  AssembleParams,
  AssembleResult,
  AfterTurnParams,
  CompactParams,
  ContextEngine,
  IngestParams,
  MemrokPluginConfig,
  PluginApi,
  ResolvedConfig,
} from "./types.js";

const DEFAULTS: ResolvedConfig = {
  daemonUrl: "http://127.0.0.1:18790",
  timeoutMs: 50,
  retryMs: 200,
  maxRetries: 1,
};

export function resolveConfig(raw?: MemrokPluginConfig): ResolvedConfig {
  return {
    daemonUrl: raw?.daemonUrl ?? DEFAULTS.daemonUrl,
    timeoutMs: raw?.timeoutMs ?? DEFAULTS.timeoutMs,
    retryMs: raw?.retryMs ?? DEFAULTS.retryMs,
    maxRetries: raw?.maxRetries ?? DEFAULTS.maxRetries,
  };
}

/** Rough token estimate: ~4 chars per token. */
function estimateTokens(messages: AssembleParams["messages"]): number {
  let chars = 0;
  for (const m of messages) {
    chars += typeof m.content === "string" ? m.content.length : 0;
  }
  return Math.ceil(chars / 4);
}

export function createContextEngine(config: ResolvedConfig): ContextEngine {
  const client = new DaemonClient(config);

  return {
    info: {
      id: "memrok",
      name: "Memrok Memory Layer",
      ownsCompaction: false,
    },

    async assemble(params: AssembleParams): Promise<AssembleResult> {
      try {
        // Build a short summary of recent messages for the daemon
        const recentText = params.messages
          .slice(-5)
          .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content.slice(0, 200) : ""}`)
          .join("\n");

        const header = await client.fetchHeader(recentText);

        return {
          messages: params.messages,
          estimatedTokens: estimateTokens(params.messages),
          systemPromptAddition: header || undefined,
        };
      } catch {
        // assemble must NEVER throw
        return {
          messages: params.messages,
          estimatedTokens: estimateTokens(params.messages),
        };
      }
    },

    async compact(params: CompactParams): Promise<{ ok: boolean; compacted: boolean }> {
      // Delegate to OpenClaw's built-in compaction.
      // In a real plugin environment this would be:
      //   import { delegateCompactionToRuntime } from "openclaw/plugin-sdk/core";
      //   return delegateCompactionToRuntime(params);
      // Since we can't import from openclaw in dev, expose the delegation pattern.
      try {
        const { delegateCompactionToRuntime } = await import("openclaw/plugin-sdk/core");
        return delegateCompactionToRuntime(params);
      } catch {
        // Fallback if openclaw SDK not available (dev environment)
        return { ok: true, compacted: false };
      }
    },

    async ingest(_params: IngestParams): Promise<{ ingested: boolean }> {
      // Phase 1 no-op — daemon watches JSONL files directly
      return { ingested: true };
    },

    async afterTurn(params: AfterTurnParams): Promise<void> {
      // Fire-and-forget notification to daemon
      client.notifyTurn(params.sessionId);
    },
  };
}

/** Plugin registration entry point. */
export default function register(api: PluginApi, pluginConfig?: MemrokPluginConfig): void {
  const config = resolveConfig(pluginConfig);
  api.registerContextEngine("memrok", () => createContextEngine(config));
}

/** Export for testing. */
export { DaemonClient };
