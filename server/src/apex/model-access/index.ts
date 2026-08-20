/**
 * ModelAccess — the "how do model calls get paid for and routed here" entity.
 *
 * This module owns the GENERATE step: given a detected auth mode, provision
 * the artifacts (bridge registration, gateway provider row, apex-* aliases)
 * so that fresh evaluator calls work with zero credentials entered.
 *
 * Provider taxonomy (spec comment 5668607e, supersedes issue description):
 *
 *   PROVIDER CLAUDE (Anthropic):
 *     - subscription (DEFAULT): bridge over Agent SDK, openai_compatible row
 *     - api_key (Advanced): metered key via LiteLLM backend in gateway
 *
 *   PROVIDER OPENROUTER:
 *     - api_key only: openai_compatible row, PassthroughBackend, zero new code
 *
 *   ALIAS LAYER: apex-* aliases map to ordered provider-row lists. The aliases
 *   seeded here point at Claude first; OpenRouter re-points or adds fallback
 *   when configured.
 *
 * The cockpit server mounts the subscription bridge at `/bridge/v1` and
 * the bridge URL (http://localhost:{PORT}/bridge/v1) becomes the api_base
 * for the gateway's openai_compatible Claude-subscription provider row.
 */

import { detectClaudeAuth, type ClaudeDetectResult } from './detect-claude.js';
import { GatewayClient } from '../../gateway/gateway-client.js';

/** The apex-* aliases seeded for Claude and their purposes. */
export const APEX_MODEL_ALIASES = [
  { alias: 'apex-judge-default', modelId: 'claude-subscription', modelName: 'Claude Subscription — Judge Default' },
  { alias: 'apex-chat-general',  modelId: 'claude-subscription', modelName: 'Claude Subscription — Chat General'  },
  { alias: 'apex-smart',         modelId: 'claude-subscription', modelName: 'Claude Subscription — Smart Tier'    },
  { alias: 'apex-fast',          modelId: 'claude-subscription', modelName: 'Claude Subscription — Fast Tier'     },
] as const;

/** Internal provider name constants — referenced by setup and status probes. */
export const CLAUDE_SUBSCRIPTION_PROVIDER_NAME = 'claude-subscription-bridge';
export const CLAUDE_API_KEY_PROVIDER_NAME      = 'claude-api-key';
export const OPENROUTER_PROVIDER_NAME          = 'openrouter';

/** Detected + generated state for this instance's model access. */
export interface ModelAccessState {
  claude: {
    /** How (if at all) Claude is authenticated. */
    mode: ClaudeDetectResult['mode'];
    /** Whether the `claude` CLI binary is installed. */
    installed: boolean;
    /** Whether the subscription bridge provider row exists in the gateway. */
    subscriptionProviderRegistered: boolean;
    /** Whether the api_key provider row exists in the gateway. */
    apiKeyProviderRegistered: boolean;
  };
  openrouter: {
    /** Whether an OpenRouter provider row exists in the gateway. */
    configured: boolean;
  };
  /** Which apex-* aliases are currently registered in the gateway. */
  aliasesRegistered: string[];
}

/**
 * Bridge shared secret for machine-to-machine auth.
 *
 * Set APEX_BRIDGE_SECRET to a stable value in containerised deployments so the
 * gateway can authenticate itself to the bridge. Returns null in local mode —
 * the loopback interface is the network-level isolation there.
 */
export function getBridgeSecret(): string | null {
  return process.env.APEX_BRIDGE_SECRET?.trim() || null;
}

/**
 * Derive the bridge's externally-reachable host. In host-local mode the default
 * (127.0.0.1) is correct. When the gateway runs in Docker, set APEX_BRIDGE_HOST
 * to host.docker.internal so the container can reach the host process.
 */
function bridgeHost(): string {
  return process.env.APEX_BRIDGE_HOST?.trim() || '127.0.0.1';
}

/** True when the bridge host is not a standard loopback — needs SSRF bypass. */
function isPrivateBridgeHost(host: string): boolean {
  return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
}

/** Derive the subscription bridge URL from the cockpit's own listen port. */
function bridgeUrl(): string {
  const port = process.env.PORT ?? '3100';
  return `http://${bridgeHost()}:${port}/bridge/v1`;
}

/** Read ModelAccessState from the live gateway + local detection. Never throws. */
export async function readModelAccessState(
  client: GatewayClient = new GatewayClient(),
): Promise<ModelAccessState> {
  const [claudeDetect, providers, models] = await Promise.all([
    detectClaudeAuth().catch(() => ({ mode: 'none' as const, installed: false })),
    client.listLLMProviders().catch(() => []),
    client.listLLMModels().catch(() => []),
  ]);

  const providerNames = new Set(providers.map((p) => p.name));
  const registeredAliases = models
    .filter((m) => m.modelAlias?.startsWith('apex-') && m.enabled)
    .map((m) => m.modelAlias as string);

  return {
    claude: {
      mode: claudeDetect.mode,
      installed: claudeDetect.installed,
      subscriptionProviderRegistered: providerNames.has(CLAUDE_SUBSCRIPTION_PROVIDER_NAME),
      apiKeyProviderRegistered: providerNames.has(CLAUDE_API_KEY_PROVIDER_NAME),
    },
    openrouter: {
      configured: providerNames.has(OPENROUTER_PROVIDER_NAME),
    },
    aliasesRegistered: registeredAliases,
  };
}

export type ProvisionResult =
  | { ok: true; providerName: string; aliasesSeeded: string[] }
  | { ok: false; reason: string };

/**
 * Provision the Claude subscription bridge:
 * 1. Register (or idempotently skip existing) the openai_compatible provider
 *    row pointing at the cockpit's in-process bridge endpoint.
 * 2. Seed apex-* model aliases pointing at that provider.
 *
 * Idempotent: if the provider already exists (409) we discover its ID and
 * proceed to seed any missing aliases.
 */
export async function provisionClaudeSubscription(
  client: GatewayClient = new GatewayClient(),
): Promise<ProvisionResult> {
  // Verify gateway is reachable first
  const reachable = await client.reachable();
  if (!reachable) {
    return { ok: false, reason: 'apex-gateway is unreachable — start the gateway before provisioning' };
  }

  // Create or find the subscription bridge provider
  const url = bridgeUrl();
  const host = bridgeHost();
  const secret = getBridgeSecret();
  const privateHost = isPrivateBridgeHost(host);

  let providerId: string | null = null;
  const createRes = await client.createLLMProvider({
    name: CLAUDE_SUBSCRIPTION_PROVIDER_NAME,
    providerType: 'openai_compatible',
    apiBase: url,
    defaultModel: 'claude-subscription',
    description: 'Subscription bridge — Agent SDK shim; never stores OAuth token as a raw key',
    // Secret allows the bridge to authenticate the gateway caller (not the Host header).
    // Omitted in local mode (null) — loopback-only access is the network-level guard.
    ...(secret ? { apiKey: secret } : {}),
    // When the bridge is on a private/docker-internal host, tell the gateway to
    // allow SSRF to that specific host. Ignored if the gateway API does not
    // support per-provider SSRF bypass (operator must set SSRF_ALLOW_PRIVATE_NETWORKS
    // on the gateway instead).
    ...(privateHost ? { ssrfAllowPrivateNetworks: true } : {}),
  });

  if (createRes.ok) {
    providerId = createRes.id;
  } else if (createRes.status === 'conflict') {
    // Already exists — find it
    const existing = await client.listLLMProviders().catch(() => []);
    const found = existing.find((p) => p.name === CLAUDE_SUBSCRIPTION_PROVIDER_NAME);
    if (!found) {
      return { ok: false, reason: `Gateway reports conflict but provider not found in list` };
    }
    providerId = found.id;
  } else if (createRes.status === 'validation' && privateHost) {
    // 422 from gateway SSRF guard: the bridge URL resolved to a private/docker host.
    return {
      ok: false,
      reason:
        `Gateway SSRF guard blocked ${url}. ` +
        `Set SSRF_ALLOW_PRIVATE_NETWORKS=true on the apex-gateway container to allow ` +
        `${host} as the bridge endpoint. (${createRes.message})`,
    };
  } else {
    return { ok: false, reason: createRes.message };
  }

  if (!providerId) {
    return { ok: false, reason: 'Provider created but gateway did not return an ID' };
  }

  // Seed apex-* aliases. Skip any that already exist (409 = idempotent).
  const seeded: string[] = [];
  const existingModels = await client.listLLMModels().catch(() => []);
  const existingAliases = new Set(existingModels.map((m) => m.modelAlias));

  for (const { alias, modelId, modelName } of APEX_MODEL_ALIASES) {
    if (existingAliases.has(alias)) {
      seeded.push(alias);
      continue;
    }
    const modelRes = await client.createLLMModel({
      providerId,
      modelId,
      modelName,
      modelAlias: alias,
    });
    if (modelRes.ok || modelRes.status === 'conflict') {
      seeded.push(alias);
    }
  }

  return { ok: true, providerName: CLAUDE_SUBSCRIPTION_PROVIDER_NAME, aliasesSeeded: seeded };
}

/**
 * Provision the Claude api_key provider (Advanced settings path).
 * Stores the key in the gateway's encrypted store (LiteLLM backend); the
 * cockpit never persists it.
 */
export async function provisionClaudeApiKey(
  apiKey: string,
  client: GatewayClient = new GatewayClient(),
): Promise<ProvisionResult> {
  if (!apiKey?.trim()) return { ok: false, reason: 'API key is required' };

  const reachable = await client.reachable();
  if (!reachable) return { ok: false, reason: 'apex-gateway is unreachable' };

  let providerId: string | null = null;
  const createRes = await client.createLLMProvider({
    name: CLAUDE_API_KEY_PROVIDER_NAME,
    providerType: 'anthropic',
    apiKey,
    defaultModel: 'claude-sonnet-4-6',
    description: 'Claude API key — metered, enables per-token cost attribution',
  });

  if (createRes.ok) {
    providerId = createRes.id;
  } else if (createRes.status === 'conflict') {
    const existing = await client.listLLMProviders().catch(() => []);
    const found = existing.find((p) => p.name === CLAUDE_API_KEY_PROVIDER_NAME);
    if (!found) return { ok: false, reason: `Gateway reports conflict but api_key provider not found` };
    providerId = found.id;
  } else {
    return { ok: false, reason: createRes.message };
  }

  if (!providerId) return { ok: false, reason: 'Provider created but no ID returned' };

  // Re-point apex-* aliases to the api_key provider (deletes existing subscription
  // aliases then re-seeds under the new provider)
  const existingModels = await client.listLLMModels().catch(() => []);
  for (const m of existingModels) {
    if (m.modelAlias?.startsWith('apex-')) {
      await client.deleteLLMModel(m.id).catch(() => null);
    }
  }

  const seeded: string[] = [];
  for (const { alias } of APEX_MODEL_ALIASES) {
    const modelRes = await client.createLLMModel({
      providerId,
      modelId: 'claude-sonnet-4-6',
      modelName: `Claude ${alias} (API Key)`,
      modelAlias: alias,
    });
    if (modelRes.ok || modelRes.status === 'conflict') seeded.push(alias);
  }

  return { ok: true, providerName: CLAUDE_API_KEY_PROVIDER_NAME, aliasesSeeded: seeded };
}

/**
 * Provision OpenRouter as a BYO-plane provider (api_key only).
 * Zero new code: standard openai_compatible row with the OpenRouter base URL.
 * Does NOT re-point existing apex-* aliases (they keep pointing at Claude
 * subscription first); the alias layer adds OpenRouter as an available provider
 * without disturbing existing routing until explicitly re-pointed.
 */
export async function provisionOpenRouter(
  apiKey: string,
  client: GatewayClient = new GatewayClient(),
): Promise<ProvisionResult> {
  if (!apiKey?.trim()) return { ok: false, reason: 'OpenRouter API key is required' };

  const reachable = await client.reachable();
  if (!reachable) return { ok: false, reason: 'apex-gateway is unreachable' };

  const createRes = await client.createLLMProvider({
    name: OPENROUTER_PROVIDER_NAME,
    providerType: 'openai_compatible',
    apiBase: 'https://openrouter.ai/api/v1',
    apiKey,
    description: 'OpenRouter — BYO-plane proof, non-Claude models answer',
  });

  if (createRes.ok) {
    return { ok: true, providerName: OPENROUTER_PROVIDER_NAME, aliasesSeeded: [] };
  }
  if (createRes.status === 'conflict') {
    return { ok: true, providerName: OPENROUTER_PROVIDER_NAME, aliasesSeeded: [] };
  }
  return { ok: false, reason: createRes.message };
}
