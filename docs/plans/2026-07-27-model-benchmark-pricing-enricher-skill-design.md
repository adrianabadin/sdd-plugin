# Design: Model Benchmark & Pricing Enricher Skill

## Executive Summary
This design defines the `model-benchmark-pricing-enricher` skill for OpenCode. The skill automates the collection and completion of AI model benchmark scores (MMLU, HumanEval, SWE-bench, GPQA, MATH, BBH, MT-Bench, MultiNEEDLE) and pricing parameters (input, output, cached per 1M tokens, currency) across AI providers.

When exact data is unreleased or unlisted, the skill applies a deterministic **comparative interpolation algorithm** based on performance hierarchy and relative efficiency indexes.

---

## 1. Trust Hierarchy & Source Matrix

### Priority 1: Primary Official Sources (Exact Ground Truth)
- **OpenAI**: `platform.openai.com/docs/models`, `openai.com/pricing`, official technical reports.
- **Anthropic**: `docs.anthropic.com/en/docs/models-overview`, `anthropic.com/pricing`.
- **Google DeepMind**: `ai.google.dev/pricing`, `cloud.google.com/vertex-ai/generative-ai/pricing`, Gemini technical papers.
- **Mistral AI**: `console.mistral.ai/pricing`, `mistral.ai/technology`.
- **Meta / Llama**: `llama.meta.com`, Hugging Face official Meta Llama model cards.
- **Cohere**: `docs.cohere.com`, `cohere.com/pricing`.
- **DeepSeek**: `platform.deepseek.com/api-docs/pricing`, DeepSeek technical reports.

### Priority 2: Trusted Benchmark Aggregators
- **Artificial Analysis** (`artificialanalysis.ai`): MMLU-Pro, GPQA, SWE-bench, Latency, Output Tokens/sec, 1M token pricing.
- **LMSYS Chatbot Arena** (`lmarena.ai` / `chat.lmsys.org`): Elo Ratings, Win Rates, Arena Hard.
- **Hugging Face Open LLM Leaderboard v2** (`huggingface.co/spaces/open-llm-leaderboard/open_llm_leaderboard`): MMLU-Redux, GPQA, MuSR, MATH, IFEval, BBH.
- **LiveBench** (`livebench.ai`): Contamination-free benchmarks (Coding, Math, Reasoning, Data Analysis).
- **SWE-bench Official** (`swebench.com`): Real GitHub issue resolution benchmarks.

---

## 2. Exhaustive Resolution & Interpolation Fallback Algorithm

### Step 1: Direct Exact Search
1. Query official documentation for exact benchmark values and token pricing.
2. If incomplete, query secondary trusted aggregators (Artificial Analysis, LMSYS, LiveBench).
3. If exact values exist, store with provenance tag `source: "official"` or `source: "aggregator:<name>"`.

### Step 2: Comparative Interpolation Fallback
When a benchmark or pricing metric cannot be found after exhausting Priority 1 and Priority 2 sources:
1. **Identify Anchor Models**: Locate 2+ reference models from the same or competing families that have verified scores and established performance rankings (e.g. GPT-4o, Claude 3.5 Sonnet, Gemini 1.5 Pro).
2. **Compute Relative Efficiency Delta ($\delta$)**:
   $$\text{Metric}_{\text{target}} = \text{Metric}_{\text{anchor}} \times (1 + \Delta_{\text{ELO/Capability}})$$
   - *Example*: If Model $X$ outperforms Anchor $Y$ (MMLU 88.7) by +35 Elo points in Chatbot Arena, interpolate MMLU $\approx 88.7 + 1.8 = 90.5$.
   - *Pricing Interpolation*: Use tier scaling ratios (e.g., Mini/Flash models typically cost 10–20% of their flagship counterparts).
3. **Label Provenance**: Store interpolated values with explicit tags and notices:
   - `[ESTIMATED/INTERPOLATED]`
   - `method: "comparative_efficiency_delta"`
   - `reference_anchors: ["gpt-4o", "claude-3-5-sonnet"]`

---

## 3. Skill Integration Architecture

The skill will be created in two locations:
1. **Project Skill Package**: `skills/model-benchmark-pricing-enricher/SKILL.md` (distributable with the `sdd-plugin2` repo).
2. **User OpenCode Skill Directory**: `.config/opencode/skills/model-benchmark-pricing-enricher/SKILL.md` (immediately active for the user's OpenCode session).

---

## 4. Verification & Quality Gates

- **Strict Range Validation**:
  - Benchmarks: $0.0 \le \text{score} \le 100.0$ (or percentages).
  - Pricing: Non-negative USD per 1M tokens.
- **TUI & DB Compatibility**:
  - Directly compatible with `SaveModelDetailUseCase` and `ModelControlCenter` TUI.
