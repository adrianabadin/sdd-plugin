---
name: model-benchmark-pricing-enricher
description: "Automate comprehensive research and population of AI model benchmarks (MMLU, SWE-bench, GPQA, MATH, etc.), pricing (input, output, cached per 1M), context limits, capabilities, and subscription metadata using official vendor docs, trusted leaderboards, and comparative efficiency interpolation when unreleased."
---

# Skill: model-benchmark-pricing-enricher

## Overview

Use this skill when you need to research, collect, verify, or automatically populate **all AI model metadata**, including:
1. **8 Benchmark Scores**: MMLU/MMLU-Pro, HumanEval, SWE-bench, GPQA, MATH, BBH, MT-Bench, MultiNEEDLE.
2. **Pricing Rates**: Input per 1M tokens, Output per 1M tokens, Cached per 1M tokens, Currency.
3. **Model Specifications**: Context Window size (tokens), Max Output Tokens, Capabilities (`vision`, `tools`, `reasoning`).
4. **Subscription Metadata**: Plan name, Subscription Tier, Periodic Cost, Included Usage, Overage Rate.

This skill enforces a strict 3-tier lookup pipeline:
1. **Primary Official Provider Sources** (ground truth).
2. **Trusted Benchmark Aggregators** (leaderboards & evaluation platforms).
3. **Comparative Efficiency Interpolation** (fallback estimation when exact data is unreleased or unlisted).

---

## Triggers

Activate this skill when the user asks to:
- "completar benchmarks de los modelos" / "enrich model benchmarks"
- "buscar pricing de los modelos" / "find model pricing"
- "actualizar métricas de modelos" / "update model metrics"
- "autocompletar benchmarks/pricings" / "fill missing model benchmarks"
- Mentioning model benchmarks (MMLU, SWE-bench, GPQA, etc.) or pricing per 1M tokens for OpenAI, Anthropic, Google Gemini, Mistral, Meta Llama, Cohere, DeepSeek, etc.

---

## Complete Target Payload Schema (`SaveModelDetailInput`)

The skill populates and validates all fields required by `SaveModelDetailUseCase`:

```typescript
interface SaveModelDetailInput {
  providerId: string;
  modelId: string;
  providerName: string;
  modelName: string;
  isBlocked: boolean;
  contextWindow: number | null;     // e.g. 128000, 200000, 1000000, 2000000
  maxOutputTokens: number | null;    // e.g. 4096, 8192, 16384, 64000
  capabilities: string[];           // ["vision", "tools", "reasoning"]
  benchmarks: {
    mmlu: number | null;            // 0.0 - 100.0 (MMLU / MMLU-Pro)
    humaneval: number | null;       // 0.0 - 100.0 (HumanEval coding score)
    sweBench: number | null;        // 0.0 - 100.0 (SWE-bench / Lite / Verified)
    gpqa: number | null;            // 0.0 - 100.0 (GPQA Diamond / Graduate Reasoning)
    math: number | null;            // 0.0 - 100.0 (MATH competition benchmark)
    bbh: number | null;             // 0.0 - 100.0 (Big-Bench Hard)
    mtBench: number | null;         // 0.0 - 10.0 or 0.0 - 100.0 (MT-Bench multi-turn)
    multineedle: number | null;     // 0.0 - 100.0 (MultiNEEDLE long-context retrieval)
  };
  pricing: {
    inputPerMillion: number | null;  // USD per 1M input tokens
    outputPerMillion: number | null; // USD per 1M output tokens
    cachedPerMillion: number | null; // USD per 1M cached input tokens
    currency: string;               // e.g. "USD"
  } | null;
  subscription: string | null;      // e.g. "pro", "custom", "free"
  planName: string | null;          // e.g. "Pro Plan", "Enterprise"
  periodicCost: number | null;      // USD per period
  includedUsage: number | null;     // Included usage limit
  overageRate: number | null;       // Overage rate per unit
}
```

---

## Research & Trusted Sources Matrix

### Priority 1: Primary Official Provider Sources (Ground Truth)
Always check these official documentation pages first:

| Provider | Official Documentation / Pricing URL |
|----------|-------------------------------------|
| **OpenAI** | `https://platform.openai.com/docs/models`, `https://openai.com/api/pricing/`, official technical reports. |
| **Anthropic** | `https://docs.anthropic.com/en/docs/models-overview`, `https://www.anthropic.com/pricing`. |
| **Google DeepMind** | `https://ai.google.dev/pricing`, `https://cloud.google.com/vertex-ai/generative-ai/pricing`, Gemini technical papers. |
| **Mistral AI** | `https://console.mistral.ai/pricing`, `https://mistral.ai/technology/`. |
| **Meta (Llama)** | `https://llama.meta.com`, Hugging Face official Meta Llama model cards. |
| **Cohere** | `https://docs.cohere.com`, `https://cohere.com/pricing`. |
| **DeepSeek** | `https://platform.deepseek.com/api-docs/pricing`, DeepSeek technical reports. |

### Priority 2: Trusted Benchmark Aggregators
If official documentation does not list specific benchmark scores or multi-provider pricing:

1. **Artificial Analysis** (`https://artificialanalysis.ai`):
   - Ratings: MMLU-Pro, GPQA, SWE-bench, Latency, Output Speed (tokens/sec).
   - Pricing: Input, Output, and Cached cost per 1M tokens.
2. **LMSYS Chatbot Arena** (`https://lmarena.ai` / `https://chat.lmsys.org`):
   - Elo Ratings, Win Rates, Arena-Hard-Auto.
3. **Hugging Face Open LLM Leaderboard v2** (`https://huggingface.co/spaces/open-llm-leaderboard/open_llm_leaderboard`):
   - MMLU-Redux, GPQA, MuSR, MATH Level 5, IFEval, BBH.
4. **LiveBench** (`https://livebench.ai`):
   - Contamination-free benchmarks (Coding, Math, Reasoning, Language, Data Analysis).
5. **SWE-bench Official** (`https://www.swebench.com`):
   - SWE-bench Lite / Verified real GitHub issue resolution percentages.

---

## Comparative Interpolation & Estimation Protocol (Priority 3 Fallback)

When exact benchmark scores, context limits, or pricing are **unreleased, unlisted, or unverified** after exhausting Priority 1 and Priority 2 sources:

1. **Identify Anchor Models**: Select 2 or 3 verified reference models from the same provider family or direct competitor tier (e.g. GPT-4o vs Claude 3.5 Sonnet vs Gemini 1.5 Pro).
2. **Establish Relative Efficiency Index**:
   - Compare overall positioning in Chatbot Arena Elo, MMLU-Pro, or vendor release announcements.
   - *Example*: If Model $A$ (e.g. Claude Opus 4.5 / 5) is established as superior to Model $B$ (GPT-4o with MMLU 88.7), then Model $A$'s estimated MMLU **must be strictly greater than $B$** ($\ge 88.7 + \delta$).
3. **Apply Pricing Tier Scaling**:
   - Small/Flash models: Typically 10%–20% of flagship price.
   - Reasoning/O-series models: Apply compute multiplier based on thought-token overhead ratios.
4. **Mandatory Provenance Tagging**:
   - Any interpolated value MUST be flagged in notes/logs:
     `[ESTIMATED/INTERPOLATED]`
   - Document the anchor models and comparative logic used (e.g. *"Interpolated: > GPT-4o (88.7) based on +25 Elo Arena delta"*).

---

## Workflow & Step-by-Step Execution

### Step 1: Target Identification
- Extract target provider and model IDs (e.g. `anthropic / claude-3-5-sonnet`, `openai / gpt-4o`, `google / gemini-1.5-pro`).
- Read current baseline metadata via `pmc get-context` or SQLite queries.

### Step 2: Search Official & Aggregator Sources
- Fetch current documentation using `webfetch` or `google_search` targeted at Priority 1 and Priority 2 URLs.
- Parse key metrics across all categories (specs, benchmarks, pricing, subscription).

### Step 3: Apply Interpolation (If Needed)
- If missing any benchmark/pricing key, execute the Comparative Interpolation Protocol.
- Log the reference anchors and comparative calculation.

### Step 4: Format & Persist
- Prepare input payload for `SaveModelDetailUseCase` or TUI `ModelControlCenter`.
- Verify data type constraints:
  - Benchmark scores: Numbers between 0.0 and 100.0 (or percentages).
  - Pricing: Numbers $\ge 0.0$ USD per 1M tokens.
- Persist through the project's persistence context or memory store (`pmc-agent-memory_store`).

---

## Reference Examples

### Example 1: Found Official Benchmark & Pricing
- Model: `openai / gpt-4o`
- Found:
  - `contextWindow`: 128000
  - `maxOutputTokens`: 16384
  - `capabilities`: `["vision", "tools", "reasoning"]`
  - `inputPerMillion`: $2.50
  - `outputPerMillion`: $10.00
  - `cachedPerMillion`: $1.25
  - `mmlu`: 88.7
  - `humaneval`: 90.2
  - `sweBench`: 38.8
  - `gpqa`: 53.6
  - `math`: 76.6

### Example 2: Interpolated Unreleased Model
- Model: `anthropic / claude-3-7-sonnet-preview` (hypothetical unreleased score)
- Anchor: `claude-3-5-sonnet` (SWE-bench: 49.0, MMLU: 88.7)
- Reasoning: Claude 3.7 Sonnet is stated as 15% superior in coding/reasoning.
- Interpolation:
  - `sweBench`: $49.0 \times 1.12 = 54.88$ `[ESTIMATED/INTERPOLATED]`
  - `mmlu`: $88.7 + 1.5 = 90.2$ `[ESTIMATED/INTERPOLATED]`
