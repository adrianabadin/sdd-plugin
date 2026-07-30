---
name: project-memory-context
description: Intake an existing project, clarify mapping goals, run graphify, and build a resumable semantic enrichment worklist for JS/TS and .NET symbols.
argument-hint: "[stage-a|stage-b|all] [--paths <p1,p2,...>]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Edit
  - Write
  - Agent
  - TaskOutput
  - Question
  - Skill
---

<objective>
Create a persistent project memory context for an existing codebase by combining intake context, graphify structural mapping, symbol extraction, local semantic enrichment, and agent-memory persistence.
</objective>

<execution_context>
@./project-memory-context workflow.md
</execution_context>

<context>
Arguments: $ARGUMENTS

Supported stages:
- `stage-a` — intake, clarification, graphify, artifact persistence
- `stage-b` — load graph artifacts, build symbol worklist, prepare semantic enrichment
- `all` — run Stage A then Stage B

Default stage is `stage-a`.
</context>

<success_criteria>
- Intake artifacts persisted under `.planning/project-memory-context/intake/`
- Graph artifacts persisted under `.planning/project-memory-context/graph/`
- Enrichment worklist persisted under `.planning/project-memory-context/enrichment/worklist.json`
- Workflow leaves resumable metadata for future semantic enrichment runs
</success_criteria>
