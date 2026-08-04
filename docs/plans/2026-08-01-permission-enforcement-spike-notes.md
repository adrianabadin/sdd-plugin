# `permission.edit` / `permission.bash` Enforcement Spike Notes

**Date:** 2026-08-01
**OpenCode Version installed:** 1.18.11 (repo/spec expects 1.18.9 — **version mismatch**, noted below; all findings are for 1.18.11 and may not transfer to 1.18.9 without re-verification)
**Branch Selection:** empirical dispatch + disk verification (same method family as the 2026-07-31 `cfg.agent` spike, extended with an actual tool-dispatch observable)

## The question

Does an OpenCode agent generated with `permission: { edit: "deny" }` and/or `permission: { bash: "deny" }` actually prevent that agent from editing files / running shell commands, in the installed OpenCode runtime?

Two distinct observables, per the assignment:

- **Observable 1** — does the `edit`/`bash` key survive config parsing (unlike `permission.task`, which the 2026-07-31 spike found is stripped)?
- **Observable 2** — if the key survives, does it actually block the action?

## Method

1. Built an isolated spike workspace (not the repo) at
   `C:\Users\aabad\AppData\Local\Temp\claude\...\scratchpad\permission-spike\`
   with its own `.opencode/agents/` directory. The repo's real `.opencode/agents` and `.opencode/commands` (13 files each) were never touched — confirmed via `git status --porcelain` on those paths before and after (empty diff both times).
2. Wrote two hand-authored agent definitions in that isolated workspace:
   - `spike-deny.md` — `permission: { edit: deny, bash: deny }`
   - `spike-allow.md` — `permission: { edit: allow, bash: allow }` (control)
   Both use `model: opencode/claude-haiku-4-5` (a model actually available via `opencode models`, confirmed reachable through the existing `opencode/*` provider credential already configured on this machine).
3. Started `opencode serve --hostname 127.0.0.1 --port <port>` with cwd set to the spike workspace (a separate OpenCode "project" from the real repo).
4. **Observable 1**: `GET /agent` (same endpoint family the SDK exposes as `client.agent.agents()`) and inspected the resolved `permission` array for each agent by name — this is the host's own resolved view, the same technique the 2026-07-31 spike used to determine `task` was dropped.
5. **Observable 2**: created a session via `POST /session` scoped to the spike workspace directory, then dispatched a prompt via `POST /session/{id}/message` with `"agent": "spike-deny"` (or `"spike-allow"`), explicitly instructing the model to write a file and run a bash command. Verified purely by reading the resulting files back from disk (`ls` / `cat`), not by trusting the model's self-reported tool result text — the model's own claims are unreliable (see finding below) and cannot be treated as ground truth.
6. Cross-referenced the `opencode serve --print-logs` output, which logs every permission-engine check as `evaluated permission=<name> ... action.action=<allow|deny|ask>` — this let us confirm *whether the permission engine was even invoked*, not just what it decided.

## Observable 1 — does the key survive parsing?

**Verdict: YES, observed directly. `edit` and `bash` survive; unlike `permission.task`, they are NOT stripped.**

`GET /agent` for `spike-deny` returned a resolved `permission` array (host's flattened rule list) that terminates with:

```json
{"permission":"edit","pattern":"*","action":"deny"},
{"permission":"bash","pattern":"*","action":"deny"}
```

and for `spike-allow`:

```json
{"permission":"edit","pattern":"*","action":"allow"},
{"permission":"bash","pattern":"*","action":"allow"}
```

These entries are appended after all global/default permission rules (project defaults, credential-file deny rules, `git commit`/`git push` ask-rules, etc.), i.e. the agent-level `permission.edit` / `permission.bash` clearly reach the host's resolved permission model as agent-scoped override rules. This matches the SDK type declaration (`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:857-865`), which explicitly types `edit` and `bash` inside `AgentConfig.permission` (unlike `task`, which has no declared slot and was found stripped by the prior spike).

## Observable 2 — is it actually applied?

**Verdict: PARTIALLY ENFORCED, and the enforcement is bypassable — observed directly, not inferred.**

What was directly observed:

- **The named `bash` and `edit`/`write` tools are removed from the agent's exposed toolset when denied.** Asked `spike-allow` (control) to list its exact tool names: 18 tools including `bash`, `edit`, `write`. Asked `spike-deny` the same: it listed 15 tools — `bash`, `edit`, and `write` are absent; everything else (including `pty_spawn`, `pty_write`, `pty_read`, `pty_kill`, `pty_list`) remains present. So at the tool-definition level, `deny` does suppress the two "canonical" tool names.
- **But the `pty_*` tools are NOT gated by `permission.bash` (or `permission.edit`) at all, and remain fully available regardless.** Using `spike-deny`, explicitly instructed the model to use `pty_spawn` + `pty_write` to run `echo pty-bypass-worked > pty-test.txt`. The command executed and the file was created on disk with the exact expected content:
  ```
  $ cat pty-test.txt
  pty-bypass-worked
  ```
  The `opencode serve --print-logs` output for this entire session contains **zero** `evaluated permission=bash` or `evaluated permission=edit` log lines — compare to the `spike-allow` control session, where every `edit`/`bash` tool invocation produced an explicit `evaluated permission=edit ... action.action=allow` / `evaluated permission=bash ... action.action=allow` log line. This is direct evidence that PTY-tool dispatch never reaches the permission-evaluation code path at all, for either `edit` or `bash`. `deny` on the named tool does not extend to the underlying PTY primitives, which can trivially reproduce the same effect (arbitrary shell exec, arbitrary file write via shell redirection).
- **The very first dispatch (before the explicit pty-bypass test) already demonstrated this accidentally**: asked `spike-deny` (without mentioning `pty_spawn`) to "write a file" and "run a bash command." The model claimed in its text response that the write failed ("no write/edit tool available") and that the bash command "succeeded" — but its own text report is **not reliable evidence** (see below). Checking disk directly: `edit-test.txt` was never created (consistent with `edit` truly being blocked/unavailable), but `bash-test.txt` **was** created on disk with the exact requested content, at a timestamp matching the model's tool-call turn to the millisecond, with no `evaluated permission=bash` log line anywhere in the session. The model had silently used a PTY tool to achieve this without narrating it as such.
- **The model's self-reported tool-result text is not trustworthy and must not be used as the observable.** In the first `spike-deny` run the model asserted "Bash execution is permitted... status: SUCCESS" as if the named `bash` tool had been invoked and allowed, when in fact (per the logs and disk state) it had used an ungated PTY tool instead — the model narrated a plausible-sounding but inaccurate account of what happened. This is exactly why Observable 2's method here is "verify via disk state and server-side logs," not "trust the agent's reported tool outcome."

### Summary table

| Permission key | Survives parsing (Observable 1) | Named tool removed from toolset | Action actually preventable | Verdict |
|---|---|---|---|---|
| `edit: deny` | Yes (observed) | Yes (`edit`/`write` absent from tool list) | **No** — file writes are still achievable via `pty_spawn`/`pty_write`, unobserved by the permission engine | Enforced only for the literal named tool; bypassable |
| `bash: deny` | Yes (observed) | Yes (`bash` absent from tool list) | **No** — shell commands are still achievable via `pty_spawn`/`pty_write`, unobserved by the permission engine, and disk evidence confirms actual execution | Enforced only for the literal named tool; bypassable |

## Version caveat

The repo/spec (`disk-agent-generator.ts` header comment, `REQUIRED_OPENCODE_VERSION`, and the 2026-07-31 spike note) target **OpenCode 1.18.9**. The binary actually installed and used for this spike is **1.18.11**. All findings above are for 1.18.11 as observed; behavior on 1.18.9 was not independently re-verified and could differ (though the PTY-tool bypass looks like a structural gap in the permission model rather than a version-specific regression, given it applies symmetrically to both `edit` and `bash`).

## What was NOT verified

- Whether this PTY bypass also exists for a `primary`-mode agent (only `subagent` mode, matching the repo's routed-host generation pattern, was tested).
- Whether disabling/hiding the `pty_*` tools themselves (e.g. via `tools: { pty_spawn: false, ... }` in the agent frontmatter) would close the bypass — not tested, out of scope for this spike's question.
- Behavior on the repo's pinned OpenCode 1.18.9 specifically (only 1.18.11 was available to test against).

## Conclusion

`permission.edit: deny` and `permission.bash: deny` are real, observable fields (unlike `permission.task`) that OpenCode 1.18.11 parses, keeps, and partially acts on: they remove the literal `edit`/`write`/`bash` tools from the dispatched agent's toolset. However, this is **not a security boundary** — the `pty_spawn`/`pty_write`/`pty_read` tools remain fully available and completely ungated by either permission key, and a model can (and, when merely asked to "write a file" / "run bash", spontaneously did) use them to achieve the exact same file-write / shell-exec effect, with zero permission-engine involvement (confirmed by the total absence of `evaluated permission=*` log lines for the bypass path, versus their reliable presence in the allow-control run). Any design relying on `permission.edit`/`permission.bash: deny` to make a routed subagent non-mutating must not treat this as sufficient on its own — it should also strip/disable the `pty_*` tools (untested here) or verify enforcement through some other mechanism.
