import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import yaml from "yaml";
import { parse as parseJsonc } from "jsonc-parser";
import type { ObservableAgentSource, AbsolutePath } from "./foreign-agent-sources.js";

export type ForeignAgentFindingKind = "foreign-reserved-definition" | "owned-definition-mismatch" | "inspection-failure";

export interface ForeignAgentFinding {
  readonly kind: ForeignAgentFindingKind;
  readonly sourceLabel: string;
  readonly collidingName?: string;
  readonly reason: string;
}

export interface OwnedAgentFile {
  readonly relativePath: string;
  readonly sha256: string;
}

function sha256(content: Buffer | string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function scanForForeignAgentDefinitions(input: {
  readonly workspaceRoot: AbsolutePath | string;
  readonly sources: readonly ObservableAgentSource[];
  readonly ownedAgentFiles: readonly OwnedAgentFile[];
  readonly reservedPrefix: string;
}): readonly ForeignAgentFinding[] {
  const findings: ForeignAgentFinding[] = [];
  const wsRoot = path.resolve(input.workspaceRoot);
  const prefixLower = input.reservedPrefix.toLowerCase();

  const ownedMap = new Map<string, string>();
  for (const o of input.ownedAgentFiles) {
    const p = path.resolve(wsRoot, o.relativePath).toLowerCase();
    ownedMap.set(p, o.sha256);
  }

  function report(kind: ForeignAgentFindingKind, sourceLabel: string, reason: string, collidingName?: string) {
    findings.push({ kind, sourceLabel, reason, collidingName });
  }

  function checkName(name: string, sourceLabel: string, filePath?: string, ownership?: string) {
    if (name.toLowerCase().startsWith(prefixLower)) {
      if (ownership === "workspace-owned-candidate" && filePath) {
        const canonical = path.resolve(filePath).toLowerCase();
        if (ownedMap.has(canonical)) {
          const expectedHash = ownedMap.get(canonical);
          try {
            const actualHash = sha256(fs.readFileSync(filePath));
            if (actualHash !== expectedHash) {
              report("owned-definition-mismatch", sourceLabel, "Owned file modified", name);
            }
          } catch (e: any) {
             report("inspection-failure", sourceLabel, "Failed to read owned file", name);
          }
          return;
        }
      }
      report("foreign-reserved-definition", sourceLabel, "Reserved prefix used", name);
    }
  }

  for (const source of input.sources) {
    try {
      if (source.kind === "inline-config") {
        let parsed: any;
        try {
          parsed = parseJsonc(source.raw, [], { allowTrailingComma: true, disallowComments: false });
        } catch {
          report("inspection-failure", source.label, "Failed to parse JSON/JSONC");
          continue;
        }
        if (parsed && typeof parsed === "object" && parsed.agent && typeof parsed.agent === "object") {
          for (const key of Object.keys(parsed.agent)) {
            checkName(key, source.label);
          }
        }
      } else if (source.kind === "config-file") {
        if (!fs.existsSync(source.path)) continue;
        let content: string;
        try {
          // Lstat check for symlink
          const stat = fs.lstatSync(source.path);
          if (stat.isSymbolicLink()) {
            report("inspection-failure", source.label, "Symlink not allowed");
            continue;
          }
          content = fs.readFileSync(source.path, "utf8");
        } catch {
          report("inspection-failure", source.label, "Unreadable file");
          continue;
        }
        let parsed: any;
        try {
          if (source.path.endsWith(".json") || source.path.endsWith(".jsonc")) {
             parsed = parseJsonc(content, [], { allowTrailingComma: true, disallowComments: false });
          } else {
             // Assuming other configs might not be JSON, but the task says "Workspace opencode.json/jsonc"
             parsed = parseJsonc(content, [], { allowTrailingComma: true, disallowComments: false });
          }
        } catch {
          report("inspection-failure", source.label, "Parse error");
          continue;
        }
        if (parsed && typeof parsed === "object" && parsed.agent && typeof parsed.agent === "object") {
          for (const key of Object.keys(parsed.agent)) {
            checkName(key, source.label);
          }
        }
      } else if (source.kind === "definition-directory") {
        if (!fs.existsSync(source.path)) continue;
        const stat = fs.lstatSync(source.path);
        if (stat.isSymbolicLink()) {
           report("inspection-failure", source.label, "Symlink not allowed");
           continue;
        }
        if (!stat.isDirectory()) continue;
        
        const walk = (dir: string, baseDir: string) => {
          let entries: fs.Dirent[];
          try {
             entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
          } catch {
             report("inspection-failure", source.label, "Cannot read dir");
             return;
          }
          for (const entry of entries) {
             const fullPath = path.join(dir, entry.name);
             try {
                 const estata = fs.lstatSync(fullPath);
                 if (estata.isSymbolicLink()) {
                     report("inspection-failure", source.label, "Symlink not allowed");
                     continue;
                 }
                 if (estata.isDirectory()) {
                     walk(fullPath, baseDir);
                 } else if (estata.isFile() && entry.name.endsWith(".md")) {
                     const relPath = path.relative(baseDir, fullPath);
                     // Path derived name as per opencode
                     let defaultName = relPath.slice(0, -3).replace(/\\/g, "/");
                     let content = fs.readFileSync(fullPath, "utf8");
                     
                     let nameToUse = defaultName;
                     if (content.startsWith("---\n") || content.startsWith("---\r\n")) {
                        const end = content.indexOf("\n---\n", 4) !== -1 ? content.indexOf("\n---\n", 4) : content.indexOf("\r\n---\r\n", 4);
                        if (end !== -1) {
                           const fm = content.slice(4, end);
                           try {
                              const doc = yaml.parseDocument(fm, { strict: true, uniqueKeys: true });
                              if (doc.errors && doc.errors.length > 0) {
                                  report("inspection-failure", source.label, "YAML error");
                              } else {
                                  const parsed = doc.toJSON();
                                  if (parsed && typeof parsed.name === "string") {
                                      nameToUse = parsed.name;
                                  } else if (parsed && "name" in parsed) {
                                      report("inspection-failure", source.label, "Non-string name");
                                  }
                              }
                           } catch {
                              report("inspection-failure", source.label, "YAML parse error");
                           }
                        }
                     }
                     checkName(nameToUse, source.label, fullPath, source.ownership);
                 }
             } catch (e) {
                 report("inspection-failure", source.label, "File error");
             }
          }
        };
        walk(source.path, source.path);
      }
    } catch (e) {
       report("inspection-failure", source.label, "Fatal error");
    }
  }
  
  return findings;
}
import { ForeignAgentInspectionError, ForeignAgentDefinitionError } from "./foreign-agent-errors.js";
export function assertNoForeignAgentDefinitions(input: {
  readonly workspaceRoot: AbsolutePath | string;
  readonly sources: readonly ObservableAgentSource[];
  readonly ownedAgentFiles: readonly OwnedAgentFile[];
  readonly reservedPrefix: string;
}): void {
  const findings = scanForForeignAgentDefinitions(input);
  const inspection = findings.filter((f) => f.kind === "inspection-failure");
  if (inspection.length) throw new ForeignAgentInspectionError("FOREIGN_AGENT_INSPECTION", inspection);
  const definitions = findings.filter((f) => f.kind !== "inspection-failure");
  if (definitions.length) throw new ForeignAgentDefinitionError("FOREIGN_AGENT_DEFINITION", definitions);
}
