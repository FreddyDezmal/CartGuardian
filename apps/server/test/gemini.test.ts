import { describe, expect, it } from "vitest";
import { ApiError, type GenerateContentParameters } from "@google/genai";
import { GeminiAdapter, mapGeminiError, type GeminiModelsClient } from "../src/ai/gemini.js";
import { loadConfig } from "../src/config.js";
import { createAiAdapter } from "../src/ai/index.js";
import type { TrialRequest } from "../src/ai/types.js";

const req: TrialRequest = {
  input: { productName: "Desk lamp", price: "40", currency: "USD", description: "", intendedUse: "", usesPerMonth: 30, lifetimeMonths: 12 },
  amount: { currency: "USD", value: "40.00" },
  metrics: { totalExpectedUses: 360, costPerUse: { currency: "USD", value: "0.11" }, costPerMonth: { currency: "USD", value: "3.33" } },
};

const goodTrial = {
  buyCase: { headline: "Useful daily", arguments: [{ point: "Used every day.", basis: "your_input" }] },
  skipCase: { headline: "Maybe later", arguments: [{ point: "You may already own a lamp.", basis: "assumption" }] },
  verdict: "buy",
  confidence: "medium",
  verdictRationale: "Low cost per use.",
  questionsBeforeBuying: [],
  unverifiedAssumptions: [],
};

function fake(texts: string[]): GeminiModelsClient & { calls: GenerateContentParameters[] } {
  const calls: GenerateContentParameters[] = [];
  return {
    calls,
    models: {
      async generateContent(p) {
        calls.push(structuredClone(p));
        return { text: texts[calls.length - 1] };
      },
    },
  };
}

/** Fake whose behaviour depends on which model is asked. */
function byModel(behaviour: Record<string, () => string>): GeminiModelsClient & { models_asked: string[] } {
  const models_asked: string[] = [];
  return {
    models_asked,
    models: {
      async generateContent(p) {
        models_asked.push(p.model);
        const f = behaviour[p.model];
        if (!f) throw new Error(`unexpected model ${p.model}`);
        return { text: f() };
      },
    },
  };
}
const overloaded = () => {
  throw new ApiError({ status: 503, message: '{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}' });
};

describe("GeminiAdapter", () => {
  it("requests JSON constrained by the trial schema and returns validated output", async () => {
    const client = fake([JSON.stringify(goodTrial)]);
    const adapter = new GeminiAdapter({ model: "gemini-test", timeoutMs: 5000 }, client);
    await expect(adapter.runTrial(req)).resolves.toMatchObject({ trial: { verdict: "buy" } });

    const cfg = client.calls[0]!.config!;
    expect(cfg.responseMimeType).toBe("application/json");
    expect(cfg.responseJsonSchema).toMatchObject({ type: "object", required: expect.arrayContaining(["buyCase", "verdict"]) });
    expect(JSON.stringify(cfg.responseJsonSchema)).not.toContain("$schema");
    // the tool-calling instruction is swapped for a JSON instruction
    expect(String(cfg.systemInstruction)).toContain("single JSON object");
    expect(String(cfg.systemInstruction)).not.toContain("record_purchase_trial");
    expect(String(cfg.systemInstruction)).toContain("untrusted_listing");
  });

  it("repairs invalid output once (e.g. an over-long argument Gemini didn't enforce)", async () => {
    const tooLong = structuredClone(goodTrial);
    tooLong.buyCase.arguments[0]!.point = "x".repeat(300);
    const client = fake([JSON.stringify(tooLong), JSON.stringify(goodTrial)]);
    const adapter = new GeminiAdapter({ model: "gemini-test", timeoutMs: 5000 }, client);
    await expect(adapter.runTrial(req)).resolves.toMatchObject({ trial: { verdict: "buy" } });
    expect(client.calls).toHaveLength(2);
    const contents = client.calls[1]!.contents as Array<{ role: string; parts: Array<{ text: string }> }>;
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(contents[2]!.parts[0]!.text).toContain("buyCase.arguments.0.point");
  });

  it("gives up after two invalid outputs, including non-JSON", async () => {
    const adapter = new GeminiAdapter({ model: "gemini-test", timeoutMs: 5000 }, fake(["not json", "{}"]));
    await expect(adapter.runTrial(req)).rejects.toMatchObject({ name: "AiError", kind: "invalid_output" });
  });

  it("maps provider errors and keeps the provider's explanation as detail", () => {
    const quota = mapGeminiError(new ApiError({ status: 429, message: '{"error":{"status":"RESOURCE_EXHAUSTED"}}' }), "m");
    expect(quota).toMatchObject({ kind: "rate_limited" });
    expect(quota.detail).toContain("RESOURCE_EXHAUSTED");
    // Gemini reports a bad key as 400 INVALID_ARGUMENT
    expect(mapGeminiError(new ApiError({ status: 400, message: "API key not valid. Please pass a valid API key." }), "m")).toMatchObject({ kind: "auth" });
    expect(mapGeminiError(new ApiError({ status: 404, message: "models/x is not found" }), "x")).toMatchObject({ kind: "upstream", message: 'AI model "x" was not found.' });
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(mapGeminiError(abort, "m")).toMatchObject({ kind: "timeout" });
  });

  it("is selected by AI_PROVIDER=gemini and requires a key", () => {
    expect(() => loadConfig({ AI_PROVIDER: "gemini" })).toThrow(/GEMINI_API_KEY/);
    const cfg = loadConfig({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k" });
    expect(cfg.ai.model).toBe("gemini-3.5-flash-lite");
    const adapter = createAiAdapter(cfg.ai);
    expect(adapter).toMatchObject({ name: "gemini", model: "gemini-3.5-flash-lite" });
  });

  it("builds a request the real SDK sends with the schema intact", async () => {
    // Uses the real SDK with a custom fetch, so nothing leaves the machine.
    let sentUrl = "";
    let sentBody: Record<string, unknown> = {};
    let sentHeaders = new Headers();
    const { GoogleGenAI } = await import("@google/genai");
    const sdk = new GoogleGenAI({
      apiKey: "test-key",
      httpOptions: {
        retryOptions: { attempts: 1 },
        fetch: (async (url: string | URL, init?: RequestInit) => {
          sentUrl = String(url);
          sentBody = JSON.parse(String(init?.body));
          sentHeaders = new Headers(init?.headers);
          return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(goodTrial) }] } }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }) as typeof fetch,
      },
    });
    const adapter = new GeminiAdapter({ model: "gemini-3.8-flash", timeoutMs: 5000 }, sdk);
    await expect(adapter.runTrial(req)).resolves.toMatchObject({ trial: { verdict: "buy" } });
    expect(sentUrl).toContain("models/gemini-3.8-flash:generateContent");
    const gen = sentBody.generationConfig as Record<string, unknown>;
    expect(gen.responseMimeType).toBe("application/json");
    expect(gen.responseJsonSchema).toMatchObject({ type: "object" });
    expect(sentBody.systemInstruction).toBeTruthy();
    // low thinking by default, and the SDK forwards it to the API
    expect(gen.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
    // per-request timeout reaches Google as the server deadline (5000 ms budget -> 5 s)
    expect(sentHeaders.get("X-Server-Timeout")).toBe("5");
  });

  it("omits the thinking setting when GEMINI_THINKING_LEVEL=default", async () => {
    const client = fake([JSON.stringify(goodTrial)]);
    await new GeminiAdapter({ model: "m", timeoutMs: 5000, thinkingLevel: "default" }, client).runTrial(req);
    expect(client.calls[0]!.config!.thinkingConfig).toBeUndefined();
    const cfg = loadConfig({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k", GEMINI_THINKING_LEVEL: "minimal" });
    expect(cfg.ai.geminiThinkingLevel).toBe("minimal");
    expect(() => loadConfig({ GEMINI_THINKING_LEVEL: "extreme" })).toThrow();
  });

  it("treats DEADLINE_EXCEEDED as a timeout and points at the fix for a rejected thinking setting", () => {
    const deadline = mapGeminiError(new ApiError({ status: 504, message: '{"error":{"code":504,"status":"DEADLINE_EXCEEDED"}}' }), "m");
    expect(deadline).toMatchObject({ kind: "timeout" });
    const thinking = mapGeminiError(new ApiError({ status: 400, message: "Thinking level is not supported for this model." }), "m");
    expect(thinking.message).toContain("GEMINI_THINKING_LEVEL=default");
  });

  it("falls back to the next model when the primary is overloaded, and reports which one answered", async () => {
    const client = byModel({ primary: overloaded, backup: () => JSON.stringify(goodTrial) });
    const adapter = new GeminiAdapter({ model: "primary", fallbackModels: ["backup"], timeoutMs: 5000 }, client);
    await expect(adapter.runTrial(req)).resolves.toMatchObject({ model: "backup", trial: { verdict: "buy" } });
    expect(client.models_asked).toEqual(["primary", "backup"]);
  });

  it("keeps the repair attempt on the model that answered", async () => {
    const bad = JSON.stringify({ ...goodTrial, verdict: "nope" });
    let backupCalls = 0;
    const client = byModel({ primary: overloaded, backup: () => (++backupCalls === 1 ? bad : JSON.stringify(goodTrial)) });
    const adapter = new GeminiAdapter({ model: "primary", fallbackModels: ["backup"], timeoutMs: 5000 }, client);
    await expect(adapter.runTrial(req)).resolves.toMatchObject({ model: "backup" });
    expect(client.models_asked).toEqual(["primary", "backup", "backup"]);
  });

  it("does not fall back on errors another model can't fix, and reports every failure when all are down", async () => {
    const badKey = () => {
      throw new ApiError({ status: 400, message: "API key not valid." });
    };
    const authClient = byModel({ primary: badKey, backup: () => JSON.stringify(goodTrial) });
    await expect(
      new GeminiAdapter({ model: "primary", fallbackModels: ["backup"], timeoutMs: 5000 }, authClient).runTrial(req),
    ).rejects.toMatchObject({ kind: "auth" });
    expect(authClient.models_asked).toEqual(["primary"]);

    const allDown = byModel({ a: overloaded, b: overloaded });
    const err = await new GeminiAdapter({ model: "a", fallbackModels: ["b"], timeoutMs: 5000 }, allDown).runTrial(req).catch((e) => e);
    expect(err).toMatchObject({ name: "AiError", kind: "upstream" });
    expect(err.detail).toMatch(/a: .*UNAVAILABLE.*\| b: .*UNAVAILABLE/);
  });

  it("parses GEMINI_FALLBACK_MODELS as a comma-separated list", () => {
    const cfg = loadConfig({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k", GEMINI_FALLBACK_MODELS: " m1, ,m2 " });
    expect(cfg.ai.geminiFallbackModels).toEqual(["m1", "m2"]);
    expect(loadConfig({}).ai.geminiFallbackModels).toEqual([]);
  });

  it("caps each model's wait while fallbacks remain, giving the last model the rest of the budget", async () => {
    const timeouts: Array<[string, number | undefined]> = [];
    const client: GeminiModelsClient = {
      models: {
        async generateContent(p) {
          timeouts.push([p.model, p.config?.httpOptions?.timeout]);
          if (p.model === "a") overloaded();
          return { text: JSON.stringify(goodTrial) };
        },
      },
    };
    const adapter = new GeminiAdapter({ model: "a", fallbackModels: ["b"], timeoutMs: 30_000, perModelTimeoutMs: 12_000 }, client);
    await expect(adapter.runTrial(req)).resolves.toMatchObject({ model: "b" });
    expect(timeouts[0]).toEqual(["a", 12_000]);
    expect(timeouts[1]![0]).toBe("b");
    expect(timeouts[1]![1]).toBeGreaterThan(29_000);
  });

  it("stops with a timeout once the whole-trial budget is used up", async () => {
    const asked: string[] = [];
    const client: GeminiModelsClient = {
      models: {
        async generateContent(p) {
          asked.push(p.model);
          await new Promise((r) => setTimeout(r, 700));
          overloaded();
          return { text: "" };
        },
      },
    };
    const adapter = new GeminiAdapter({ model: "a", fallbackModels: ["b", "c"], timeoutMs: 1500 }, client);
    const err = await adapter.runTrial(req).catch((e) => e);
    expect(err).toMatchObject({ name: "AiError", kind: "timeout" });
    expect(err.detail).toContain("AI_TIMEOUT_MS");
    expect(asked).toEqual(["a"]); // after ~700 ms, under 1 s remains, so b and c are never tried
  });
});
