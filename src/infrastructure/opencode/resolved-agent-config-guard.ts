import { ResolvedAgentConfigUnavailableError, RoutedAgentDefinitionMismatchError } from "./foreign-agent-errors.js";
import { buildCanonicalRoutedAgentDefinition, compareResolvedAgentDefinition } from "./routed-agent-definition.js";
import type { Manifest } from "./disk-agent-generator.js";

export class ResolvedAgentConfigGuard {
  private observed = false;
  private getAgents: (() => unknown) | undefined;
  private recordedFailure: Error | undefined;
  private recordedAuditFailure: Error | undefined;

  observe(getAgents: () => unknown): void {
    this.observed = true;
    this.getAgents = getAgents;
    this.recordedFailure = undefined;
    this.recordedAuditFailure = undefined;
  }

  recordObservationFailure(error: unknown): Error {
    const bounded = error instanceof Error ? error : new Error(String(error));
    this.recordedFailure = bounded;
    return bounded;
  }

  recordAuditFailure(error: unknown): void {
    this.recordedAuditFailure = error instanceof Error ? error : new Error(String(error));
  }

  assertMatches(manifest: Manifest): void {
    if (this.recordedFailure) {
       throw new RoutedAgentDefinitionMismatchError("ROUTED_AGENT_DEFINITION_MISMATCH", [this.recordedFailure.message]);
    }
    if (!this.observed || !this.getAgents) {
       throw new ResolvedAgentConfigUnavailableError("RESOLVED_AGENT_CONFIG_UNAVAILABLE");
    }
    const agents = this.getAgents();
    if (agents === undefined || agents === null) {
       if (manifest.routes && manifest.routes.length > 0) {
           throw new ResolvedAgentConfigUnavailableError("RESOLVED_AGENT_CONFIG_UNAVAILABLE");
       }
       return;
    }
    
    if (typeof agents !== "object") {
       throw new RoutedAgentDefinitionMismatchError("ROUTED_AGENT_DEFINITION_MISMATCH", ["not an object"]);
    }

    const agentKeys = Object.getOwnPropertyNames(agents);
    
    for (const route of manifest.routes) {
        const canonical = buildCanonicalRoutedAgentDefinition({
            hostName: route.hostName,
            providerId: route.providerId,
            modelId: route.modelId,
            baseTemplate: (route as any).baseTemplateName || (route as any).baseTemplate || "base"
        });
        
        // Find matching keys case insensitively
        const matchingKeys = agentKeys.filter(k => k.toLowerCase() === route.hostName.toLowerCase());
        
        if (matchingKeys.length === 0) {
            // Observed-field projection fallback: absent reserved keys pass
            continue;
        }
        
        if (matchingKeys.length > 1 || matchingKeys[0] !== route.hostName) {
            throw new RoutedAgentDefinitionMismatchError("ROUTED_AGENT_DEFINITION_MISMATCH", ["invalid case or duplicate"]);
        }
        
        const actualAgent = (agents as any)[route.hostName];
        
        // Reject accessors
        const desc = Object.getOwnPropertyDescriptor(agents, route.hostName);
        if (desc && (desc.get || desc.set)) {
            throw new RoutedAgentDefinitionMismatchError("ROUTED_AGENT_DEFINITION_MISMATCH", ["accessor"]);
        }

        const diffs = compareResolvedAgentDefinition(actualAgent, canonical);
        if (diffs.length > 0) {
            throw new RoutedAgentDefinitionMismatchError("ROUTED_AGENT_DEFINITION_MISMATCH", diffs);
        }
    }
  }
}
