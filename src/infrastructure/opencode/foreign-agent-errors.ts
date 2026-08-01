import type { ForeignAgentFinding } from "./foreign-agent-scan.js";

export class ForeignAgentDefinitionError extends Error {
  constructor(
    public readonly code: "FOREIGN_AGENT_DEFINITION",
    public readonly findings: readonly ForeignAgentFinding[]
  ) {
    super("Foreign agent definitions found");
    this.name = "ForeignAgentDefinitionError";
  }
}

export class ForeignAgentInspectionError extends Error {
  constructor(
    public readonly code: "FOREIGN_AGENT_INSPECTION",
    public readonly findings: readonly ForeignAgentFinding[]
  ) {
    super("Foreign agent inspection failed");
    this.name = "ForeignAgentInspectionError";
  }
}

export class RoutedAgentDefinitionMismatchError extends Error {
  constructor(
    public readonly code: "ROUTED_AGENT_DEFINITION_MISMATCH",
    public readonly mismatchedKeys: readonly string[]
  ) {
    super("Routed agent definition mismatch");
    this.name = "RoutedAgentDefinitionMismatchError";
  }
}

export class ResolvedAgentConfigUnavailableError extends Error {
  constructor(
    public readonly code: "RESOLVED_AGENT_CONFIG_UNAVAILABLE"
  ) {
    super("Resolved agent config unavailable");
    this.name = "ResolvedAgentConfigUnavailableError";
  }
}
