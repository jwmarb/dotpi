/**
 * Tests for the pure half of the LiteLLM extension: `thinkingLevelMapFor`
 * (the prefix→effort-map choice that was a nested ternary inside the
 * registration callback) and `buildModels` (chat filtering, cost conversion,
 * first-wins cache rates, token defaults).
 *
 * Importing `../litellm.js` must not reach the network: the fetches live in
 * the default export only, so this file exercises the real module.
 */

import { describe, expect, jest, test } from "bun:test";

import {
  buildModels,
  thinkingLevelMapFor,
  type LiteLLMModelGroupInfo,
  type LiteLLMModelGroupInfoResponse,
  type LiteLLMModelInfoEntry,
  type LiteLLMModelInfoResponse,
} from "../litellm.js";

/** A group-info row with every field named: tests override only what they pin. */
function group(over: Partial<LiteLLMModelGroupInfo> = {}): LiteLLMModelGroupInfo {
  return {
    model_group: "m/1",
    providers: [],
    max_input_tokens: null,
    max_output_tokens: null,
    input_cost_per_token: null,
    output_cost_per_token: null,
    input_cost_per_pixel: null,
    mode: "chat",
    tpm: null,
    rpm: null,
    supports_parallel_function_calling: false,
    supports_vision: false,
    supports_web_search: false,
    supports_url_context: false,
    supports_reasoning: false,
    supports_function_calling: false,
    supported_openai_params: [],
    configurable_clientside_auth_params: null,
    is_public_model_group: false,
    health_status: null,
    health_response_time: null,
    health_checked_at: null,
    ...over,
  };
}

/** A /model/info deployment; only the cache-cost fields matter here. */
function deploy(
  model_name: string,
  litellm_params: LiteLLMModelInfoEntry["litellm_params"] = {},
  model_info: Partial<LiteLLMModelInfoEntry["model_info"]> = {},
): LiteLLMModelInfoEntry {
  return {
    model_name,
    litellm_params,
    model_info: {
      id: model_name,
      db_model: false,
      max_input_tokens: null,
      max_output_tokens: null,
      input_cost_per_token: null,
      output_cost_per_token: null,
      cache_creation_input_token_cost: null,
      cache_read_input_token_cost: null,
      key: model_name,
      max_tokens: null,
      litellm_provider: "litellm",
      mode: "chat",
      supports_vision: null,
      supports_function_calling: null,
      supports_reasoning: null,
      supports_prompt_caching: null,
      supported_openai_params: [],
      ...model_info,
    },
  };
}

const groups = (...rows: LiteLLMModelGroupInfo[]): LiteLLMModelGroupInfoResponse => ({ data: rows });
const deployments = (...rows: LiteLLMModelInfoEntry[]): LiteLLMModelInfoResponse => ({ data: rows });

describe("thinkingLevelMapFor", () => {
  test("qwen groups get the full clamping map, and max lands on xhigh", () => {
    expect(thinkingLevelMapFor("qwen/x")).toEqual({
      off: "none",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "xhigh",
      xhigh: "xhigh",
      max: "xhigh",
    });
    expect(thinkingLevelMapFor("qwen/x").max).toBe("xhigh");
  });

  test("anthropic groups get off+xhigh; everything else only xhigh", () => {
    expect(thinkingLevelMapFor("anthropic/c")).toEqual({ off: "none", xhigh: "xhigh" });
    expect(thinkingLevelMapFor("openai/g")).toEqual({ xhigh: "xhigh" });
  });
});

describe("buildModels", () => {
  test("a response without `data` yields no models instead of throwing", () => {
    expect(buildModels({}, null)).toEqual([]);
    expect(buildModels({}, {})).toEqual([]);
    // A missing /model/info list leaves cache rates at zero, not a crash.
    // The warning each missing `data` emits is pinned by the next test.
    const models = buildModels(groups(group({ model_group: "m/1" })), {});
    expect(models.map((m) => m.id)).toEqual(["m/1"]);
    expect(models[0]!.cost.cacheRead).toBe(0);
  });

  test("a body without `data` warns, naming the endpoint that produced it", () => {
    // The `?? []` guards are what keep extension load alive; the warnings are
    // what stop a proxy that answers 200 with an unexpected body from quietly
    // registering zero models. `mock.calls` is read before `mockRestore`,
    // which clears them.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    let noGroups: ReturnType<typeof buildModels> = [];
    let noDeployments: ReturnType<typeof buildModels> = [];
    let messages: string[] = [];
    try {
      noGroups = buildModels({}, null);
      noDeployments = buildModels(groups(group({ model_group: "m/1" })), {});
      // A real but empty gateway (`data: []`) is not misconfigured: no warning.
      expect(buildModels({ data: [] }, { data: [] })).toEqual([]);
      messages = warn.mock.calls.map((call) => call.join(" "));
    } finally {
      warn.mockRestore();
    }
    // The guard is a warning, not an exception: the empty result still holds,
    // and the surviving group keeps registering with zero cache costs. A null
    // `/model/info` adds no warning of its own — a non-ok fetch already
    // console.errors in `fetchJson`.
    expect(noGroups).toEqual([]);
    expect(noDeployments.map((m) => m.id)).toEqual(["m/1"]);
    expect(noDeployments[0]!.cost.cacheRead).toBe(0);
    expect(messages).toEqual([
      expect.stringContaining("/model_group/info"),
      expect.stringContaining("/model/info"),
    ]);
  });

  test("a non-reasoning group carries no thinkingLevelMap", () => {
    const models = buildModels(groups(group({ model_group: "m/1", supports_reasoning: false })), null);
    expect(models[0]!.thinkingLevelMap).toBeUndefined();
  });

  test("null token limits fall back to the bounded defaults", () => {
    const models = buildModels(groups(group()), null);
    expect(models[0]!.maxTokens).toBe(32_768);
    expect(models[0]!.contextWindow).toBe(262_144);
    const stated = buildModels(groups(group({ max_output_tokens: 8000 })), null);
    expect(stated[0]!.maxTokens).toBe(8000);
  });

  test("only chat-capable groups register, order preserved", () => {
    const models = buildModels(
      groups(
        group({ model_group: "a/1", mode: null }),
        group({ model_group: "b/2", mode: "embedding" }),
        group({ model_group: "c/3", mode: "chat" }),
        group({ model_group: "d/4", mode: "image_generation" }),
        group({ model_group: "e/5", mode: "completion" }),
      ),
      null,
    );
    expect(models.map((m) => m.id)).toEqual(["a/1", "c/3", "e/5"]);
  });

  test("the first deployment with cache costs wins, params before model_info", () => {
    const models = buildModels(
      groups(group({ model_group: "m/1" })),
      deployments(
        deploy("m/1", { cache_read_input_token_cost: 1e-6 }),
        deploy("m/1", { cache_read_input_token_cost: 2e-6 }),
      ),
      null,
    );
    expect(models[0]!.cost.cacheRead).toBe(1);
  });

  test("a first deployment without cache costs does not shadow a later one", () => {
    const models = buildModels(
      groups(group({ model_group: "m/1" })),
      deployments(deploy("m/1"), deploy("m/1", { cache_read_input_token_cost: 3e-6 })),
      null,
    );
    expect(models[0]!.cost.cacheRead).toBe(3);
  });

  test("litellm_params beats model_info on the same deployment", () => {
    const models = buildModels(
      groups(group({ model_group: "m/1" })),
      deployments(deploy("m/1", { cache_read_input_token_cost: 1e-6 }, { cache_read_input_token_cost: 9e-6 })),
      null,
    );
    expect(models[0]!.cost.cacheRead).toBe(1);
  });

  test("a missing /model/info still registers with zero cache costs", () => {
    const models = buildModels(groups(group({ model_group: "m/1" })), null);
    expect(models[0]!.cost.cacheRead).toBe(0);
    expect(models[0]!.cost.cacheWrite).toBe(0);
  });

  test("vision groups advertise image input", () => {
    const models = buildModels(groups(group({ model_group: "m/1", supports_vision: true })), null);
    expect(models[0]!.input).toEqual(["text", "image"]);
  });
});
