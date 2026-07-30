<purpose>
Run a resumable project-memory-context workflow for existing repositories.

Stage A collects project intent, uses `brainstorming` to clarify ambiguity, persists intake artifacts, and invokes `graphify` as the structural mapping phase.

Stage B scans supported files (`JS/TS + .NET`), extracts top-level symbols, computes stable symbol identities, and writes `.planning/project-memory-context/enrichment/worklist.json` for semantic enrichment and agent-memory upserts.
</purpose>

<process>

<step name="parse_stage" priority="first">
Parse `$ARGUMENTS` and normalize one of:

- `stage-a`
- `stage-b`
- `all`

Default to `stage-a` when omitted.
</step>

<step name="stage_a_intake" condition="stage-a or all">
Ask the user for:

- a short project description
- the mapping goals
- optional focus areas

Then invoke the `brainstorming` skill to clarify any ambiguity in the intake before continuing.

Persist the normalized intake using:

```bash
node "C:\Users\aabad\AppData\Roaming\npm\node_modules\@aabadin\project-memory-context/cli/save-intake-context.mjs" "<project description>" <goal1> <goal2>
```
</step>

<step name="stage_a_graphify" condition="stage-a or all">
Run `graphify` against the current workspace after intake has been clarified.

Expected graph artifacts:

- `.planning/project-memory-context/graph/graph.json`
- `.planning/project-memory-context/graph/graph.html`
- `.planning/project-memory-context/graph/GRAPH_REPORT.md`
- `.planning/project-memory-context/graph/graph.metadata.json`

If `graphify` writes to `graphify-out/`, copy or mirror the resulting graph artifacts into `.planning/project-memory-context/graph/`.
</step>

<step name="stage_b_scan" condition="stage-b or all">
Select supported files from the repo for v1:

- `*.js`, `*.jsx`, `*.ts`, `*.tsx`
- `*.mjs`, `*.cjs`
- `*.cs`

Exclude generated folders such as `node_modules`, `dist`, `.git`, `bin`, `obj`.

Build the deterministic worklist with:

```bash
node "C:\Users\aabad\AppData\Roaming\npm\node_modules\@aabadin\project-memory-context/cli/build-worklist.mjs" <relative-file-paths>
```

The script writes `.planning/project-memory-context/enrichment/worklist.json`.
</step>

<step name="stage_b_semantic_enrichment" condition="stage-b or all">
Prepare semantic jobs with:

```bash
node "C:\Users\aabad\AppData\Roaming\npm\node_modules\@aabadin\project-memory-context/cli/prepare-semantic-jobs.mjs"
```

The script writes `.planning/project-memory-context/enrichment/semantic-jobs.json`.

For each pending job in `semantic-jobs.json`:

1. load the exact file fragment for the symbol range
2. call the `pmc-local-model` MCP with the prepared prompt and require a `semantic_report` result using this stable prefix format:

```text
responsibility: ...
inputs: item1, item2
output: ...
dependencies: dep1, dep2
role: ...
```

3. materialize the memory payload before calling `pmc-agent-memory`:

```bash
node "C:\Users\aabad\AppData\Roaming\npm\node_modules\@aabadin\project-memory-context/cli/materialize-enrichment-artifacts.mjs" @<job-file> @<report-file>
```

4. persist or update the semantic payload in `pmc-agent-memory`

5. once `pmc-agent-memory` returns the `memoryId`, materialize the graph update payload:

```bash
node "C:\Users\aabad\AppData\Roaming\npm\node_modules\@aabadin\project-memory-context/cli/materialize-enrichment-artifacts.mjs" @<job-file> @<report-file> <memory-id>
```

6. finalize the successful symbol using:

```bash
node "C:\Users\aabad\AppData\Roaming\npm\node_modules\@aabadin\project-memory-context/cli/finalize-enrichment.mjs" @<symbol>.result.json
```

If a symbol cannot be processed, mark it as `error` without aborting the rest of the run:

```bash
node "C:\Users\aabad\AppData\Roaming\npm\node_modules\@aabadin\project-memory-context/cli/fail-enrichment.mjs" <symbol-key> "<error message>"
```
</step>

<step name="report">
Print a compact summary:

- intake saved
- graph artifacts present or missing
- supported symbols found
- worklist count
- pending / enriched counts when Stage B runs

End by pointing to `.planning/project-memory-context/` as the persistent run directory.
</step>

</process>
