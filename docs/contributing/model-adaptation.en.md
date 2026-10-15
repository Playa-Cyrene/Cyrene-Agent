# Model Adaptation Contribution Guide

Models ship quickly. If a model you want to use has not been adapted yet, you can open a PR directly. A focused, single-provider update with an exact model ID, supporting evidence, and targeted regression coverage does not need to wait for a maintainer to claim an issue. If you need help, use the repository's **Model Adaptation / Contribution Help** issue form.

Start with the [model compatibility catalog](../references/adapted-models.en.md). A model being recommended does not mean that every transport, endpoint, or capability is supported. The catalog marks legacy and unknown entries explicitly.

## Where to make changes

| Change | Source of truth | Used by |
| --- | --- | --- |
| Models and recommended uses | `models` in `src/shared/vendor-registry/entries/<provider>.ts` | UI suggestions and generated catalog |
| Prefilled UI values | `presetDefaults` in the same file | Model presets |
| Runtime defaults and provider-level information | `capability` in the same file | Existing adapters |
| Reasoning rules | `reasoningRules` in the same file | Shared reasoning resolution and request conversion |
| Sampling allowlists | `samplingRules` in the same file | Main-process sampling policy |
| Structured output declarations | `structuredOutputRules` in the same file | Main-process structured output configuration |

Reuse the existing declaration helpers, adapters, and official SDKs (software development kits). Routine model updates do not need a new generic request framework or external model database. Existing consumers handle repair budgets, timeouts, retries, and parameter value mapping.

## Three contribution scopes

### 1. A new model covered by existing capability rules

1. Add the exact API model ID to the provider's `models`. Set `recommendedFor: ["chat"]` or `"vision"` when appropriate. Keep historical entries with `recommendedFor: []`; do not remove existing models without a reason.
2. Check the **first matching** reasoning, sampling, and structured output rules. Similar names do not prove compatibility. Include model documentation and the applicable transport in your PR.
3. For capabilities without coverage or valid evidence on the recommended transport, use `unknownCapabilities` to record the transport and reason. If there is no structured output rule, keep the prompt-based JSON fallback. If there is no sampling allowlist, sampling parameters are omitted.
4. Add behavioral assertions for the exact model, with expected values written independently rather than copied from the same registry. Generate and commit the updated catalogs.

### 2. A model that needs a new or corrected rule

Keep the provider's entry file as the source of truth. Put specific rules before broad rules. Do not use the `g` (global) or `y` (sticky) regular expression flags. Do not manually add a provider ID to a rule or a trailing `/.*/` catch-all; the declaration helper fills those in.

Set `modelInferencePattern` only when the model family is known to be identifiable in hosted or custom-provider scenarios too. A broad provider-specific suffix must not be used as cross-provider inference. When adding a family rule, set `familyLabel` and add tests for a matching model, a nearby non-match, and precedence when rules overlap.

Structured output rules must specify `transport`. Evidence for one transport does not establish support for another, and adding a model to the catalog does not expand the official endpoint checks. Sampling conditions such as `requiresReasoningOff` and temperature limits need corresponding behavioral tests.

### 3. A new provider or a change to shared behavior

Open an issue first to discuss a new provider, transport, authentication method, caching behavior, official endpoint scope, shared adapter interface, request conversion, or repair policy. Once a new provider is approved, add its provider file, register it in both provider-order lists in `index.ts`, and add its icon and website presentation in the UI. Routine model updates for an existing provider do not need this step.

## Complete model catalog entry example

The name below is an **illustrative placeholder, not a real support declaration**. Assume it is added to the end of `models` in `qwen.ts`. The existing Qwen reasoning prefix matches it, while sampling and structured output have no coverage, so those capabilities are explicitly marked unknown.

```ts
{
  model: "qwen-plus-contribution-example",
  recommendedFor: ["chat"],
  note: "Illustrative placeholder. Replace it with the exact provider model ID and include documentation in the PR.",
  unknownCapabilities: [
    { feature: "sampling", transport: "openai", note: "The sampling allowlist does not cover this model; verification is pending." },
    { feature: "structuredOutput", transport: "openai", note: "Native output has not been verified; keep the prompt-based JSON fallback." },
  ],
},
```

Add an independent behavioral assertion in `src/shared/vendor-registry/resolver-golden.test.ts`:

```ts
test("a new Qwen model keeps the existing reasoning toggle", () => {
  const cap = resolveReasoningCapability("qwen", "qwen-plus-contribution-example");
  expect(cap.control).toBe("toggle");
  expect(cap.requestStyle).toBe("qwen-enable-thinking");
  expect(cap.supportsDisable).toBe(true);
});
```

A catalog-only contribution usually changes one provider file, one related test, and the generated catalogs. A new capability rule also needs tests for the actual consumer's request fields or fallback behavior.

## How to provide capability evidence

The `metadata` for a new capability rule contains a `status` and `evidence`:

```ts
metadata: {
  status: "supported",
  evidence: {
    kind: "official",
    url: "https://example.com/vendor-documentation", // Replace with documentation that supports this declaration.
    checkedAt: "2026-10-04", // Replace with the date you actually checked it.
    transports: ["openai"],
  },
},
```

For a redacted observation, use `kind: "observed"` and provide `artifact` (a record file or public link), `checkedAt`, `transport`, and the public `endpoint`. Record the exact model, request capability fields, and response or error. Remove API keys, authorization headers, private conversations, and credential-bearing URLs.

Use `kind: "legacy"` only when migrating an old rule. Historical comments are not current official guarantees. If the old transport matrix is unavailable, keep the rule marked as unverified. When a new model reuses an old rule, include model documentation, preserve the existing evidence level, and mark unverified transports as unknown. Do not invent verification dates or links to pass checks.

Metadata does not control runtime switches. Changing only `status` cannot fix request behavior; an actual capability change also requires updating rule fields and consumer tests. Aliases are descriptive and do not automatically replace the model name sent to the service.

## Local checks and submission

After installing the repository dependencies, these checks do not require paid API credentials:

```powershell
pnpm exec vitest run src/shared/vendor-registry src/shared/reasoning.test.ts src/renderer/settings/api/presets.test.ts
pnpm run check:main
pnpm run check:renderer
pnpm run generate:adapted-models
pnpm run check:adapted-models
```

Run focused checks for the capability you changed:

```powershell
# Sampling and actual request fields
pnpm exec vitest run src/main/orchestrator/vendors
# Output modes, transport and endpoint fallbacks, and repair budgets
pnpm exec vitest run src/main/orchestrator/structured-output
```

The checks validate duplicate model IDs, coverage or explicit unknown notes for recommended models, basic evidence formatting, and whether both generated catalogs are up to date. Check mode does not modify files and accepts different line-ending styles. CI (continuous integration) runs the same catalog check; generated output is version-controlled and should not be edited by hand.

Include the provider, exact model ID, transport, endpoint type, documentation or redacted observation, verification date, unknown capabilities, and the checks you ran in your submission. Follow the repository's Chinese commit format, such as `feat(模型):新增型号声明` or `fix(模型):修正能力规则`, and keep the changes focused.

## Known boundaries

- Official endpoint checks still use the runtime default URL and the Moonshot coding endpoint. MiniMax's compatible endpoint may be treated as a custom endpoint. Expanding endpoint coverage requires separate verification.
- Memory callers and other callers do not yet use a unified source to select the output transport; this contribution workflow preserves the current behavior.
- `gpt-6.1-sol` is in the candidate list and reasoning declarations, but the existing Chat Completions structured output rule does not cover it. Adding the model to the catalog does not add that support automatically.
- Tool support is declared at the provider level, and vision candidates are recommendations by intended use. Do not describe either as verified per model without model-specific evidence.
