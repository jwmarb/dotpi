import type { ExtensionAPI, ProviderConfig } from '@mariozechner/pi-coding-agent';
import { requireEnv } from './lib/dotenv.js';

/**
 * The LiteLLM provider key, read from `LITELLM_API_KEY` (see docs/adr/0042).
 *
 * Read lazily rather than at module load so a missing value fails when the
 * provider is actually being configured, where the error can be reported,
 * instead of throwing during extension import and taking the session with it.
 *
 * There is deliberately NO fallback to a literal: a fallback would mean the
 * value stays in this file, which is the whole point of moving it out.
 */
const apiKey = () => requireEnv('LITELLM_API_KEY', 'the LiteLLM provider');
const baseUrl = () => requireEnv('LITELLM_BASE_URL', 'the LiteLLM provider');

const TOKENS_PER_MILLION = 1_000_000;

interface LiteLLMModelGroupInfo {
  model_group: string;
  providers: string[];
  max_input_tokens: number | null;
  max_output_tokens: number | null;
  input_cost_per_token: number | null;
  output_cost_per_token: number | null;
  input_cost_per_pixel: number | null;
  mode: string | null;
  tpm: number | null;
  rpm: number | null;
  supports_parallel_function_calling: boolean;
  supports_vision: boolean;
  supports_web_search: boolean;
  supports_url_context: boolean;
  supports_reasoning: boolean;
  supports_function_calling: boolean;
  supported_openai_params: string[];
  configurable_clientside_auth_params: unknown;
  is_public_model_group: boolean;
  health_status: string | null;
  health_response_time: number | null;
  health_checked_at: string | null;
}

interface LiteLLMModelGroupInfoResponse {
  data: LiteLLMModelGroupInfo[];
}

interface LiteLLMModelInfoEntry {
  model_name: string;
  litellm_params: {
    input_cost_per_token?: number;
    output_cost_per_token?: number;
    cache_creation_input_token_cost?: number | null;
    cache_read_input_token_cost?: number | null;
    api_base?: string;
    use_in_pass_through?: boolean;
    use_litellm_proxy?: boolean;
    merge_reasoning_content_in_choices?: boolean;
    model?: string;
  };
  model_info: {
    id: string;
    db_model: boolean;
    max_input_tokens: number | null;
    max_output_tokens: number | null;
    input_cost_per_token: number | null;
    output_cost_per_token: number | null;
    cache_creation_input_token_cost: number | null;
    cache_read_input_token_cost: number | null;
    key: string;
    max_tokens: number | null;
    litellm_provider: string;
    mode: string | null;
    supports_vision: boolean | null;
    supports_function_calling: boolean | null;
    supports_reasoning: boolean | null;
    supports_prompt_caching: boolean | null;
    supported_openai_params: string[];
  };
}

interface LiteLLMModelInfoResponse {
  data: LiteLLMModelInfoEntry[];
}

/**
 * Converts a per-token cost to a per-million-tokens cost for display.
 *
 * @param costPerToken - The cost per single token, or null/undefined if unknown.
 * @returns The cost per million tokens, or 0 if the input is null/undefined.
 */
function perMillionTokens(costPerToken: number | null | undefined): number {
  return costPerToken != null ? costPerToken * TOKENS_PER_MILLION : 0;
}

/**
 * Fetches JSON from a LiteLLM proxy endpoint, authenticating via Bearer token.
 *
 * Preconditions:
 * - LITELLM_API_KEY must be set (in the environment or agent/.env); throws naming it if not
 *
 * @param url - The full URL of the LiteLLM proxy endpoint.
 * @returns The parsed JSON response typed as T, or null if the request fails.
 */
async function fetchJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey()}` },
  });
  if (!response.ok) {
    console.error(`LiteLLM fetch failed: ${response.status} ${response.statusText} (${url})`);
    return null;
  }
  // JSON.parse returns unknown; cast to T as the proxy schema is trusted.
  return (await response.json()) as T;
}

/**
 * pi thinking levels mapped to the effort values the qwen model groups accept
 * upstream, verified 2026-09-18 against the live proxy.
 *
 * qwen only accepts `low` / `medium` / `xhigh` — anything else (including pi's
 * `high`, `minimal` and `max`) 400s with "Unexpected reasoning effort". Higher
 * pi levels clamp to `xhigh`, the top effort; `off` maps to `none`, the one
 * value the proxy accepts that actually disables thinking (sending no effort
 * at all would leave the model on its default, which is `xhigh`).
 */
const QWEN_THINKING_LEVEL_MAP = {
  off: 'none',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'xhigh',
  xhigh: 'xhigh',
  max: 'xhigh',
} as const;
/**
 * LiteLLM proxy extension. Fetches model metadata from a LiteLLM proxy and
 * registers it as a provider, including per-token costs and cache read/write rates.
 *
 * Preconditions:
 * - LITELLM_BASE_URL and LITELLM_API_KEY must be set (in the environment or
 *   agent/.env); throws naming the missing variable if not.
 * - The LiteLLM proxy at LITELLM_BASE_URL must be reachable.
 *
 * @param pi - The Pi extension API handle.
 */
export default async function (pi: ExtensionAPI) {
  const baseOrigin = baseUrl().replace(/\/v1$/, '');
  const [groupInfo, modelInfo] = await Promise.all([
    fetchJson<LiteLLMModelGroupInfoResponse>(`${baseOrigin}/model_group/info`),
    fetchJson<LiteLLMModelInfoResponse>(`${baseOrigin}/model/info`),
  ]);

  if (!groupInfo) return;

  // Build a lookup of cache costs from /model/info keyed by model_name.
  // A model_name can appear multiple times (multiple deployments); take the
  // first entry that has cache costs defined.
  const cacheCosts = new Map<string, { cacheWrite: number; cacheRead: number }>();
  if (modelInfo) {
    for (const entry of modelInfo.data) {
      if (cacheCosts.has(entry.model_name)) continue;
      const cacheWrite =
        entry.litellm_params.cache_creation_input_token_cost ?? entry.model_info.cache_creation_input_token_cost;
      const cacheRead =
        entry.litellm_params.cache_read_input_token_cost ?? entry.model_info.cache_read_input_token_cost;
      if (cacheWrite != null || cacheRead != null) {
        cacheCosts.set(entry.model_name, {
          cacheWrite: perMillionTokens(cacheWrite),
          cacheRead: perMillionTokens(cacheRead),
        });
      }
    }
  }

  const chatModels = groupInfo.data.filter((m) => m.mode == null || m.mode === 'chat' || m.mode === 'completion');

  pi.registerProvider('litellm', {
    baseUrl: baseUrl(),
    apiKey: apiKey(),
    api: 'openai-completions',
    models: chatModels.map((m) => {
      const cache = cacheCosts.get(m.model_group);
      return {
        id: m.model_group,
        name: m.model_group,
        reasoning: m.supports_reasoning,
        thinkingLevelMap: m.supports_reasoning
          ? m.model_group.startsWith('qwen/')
            ? QWEN_THINKING_LEVEL_MAP
            : { xhigh: 'xhigh' }
          : undefined,
        input: m.supports_vision ? (['text', 'image'] as const) : (['text'] as const),
        cost: {
          input: perMillionTokens(m.input_cost_per_token),
          output: perMillionTokens(m.output_cost_per_token),
          cacheRead: cache?.cacheRead ?? 0,
          cacheWrite: cache?.cacheWrite ?? 0,
        },
        contextWindow: m.max_input_tokens ?? 262_144,
        maxTokens: m.max_output_tokens ?? 256_000,
      };
    }),
  } satisfies ProviderConfig);
}
