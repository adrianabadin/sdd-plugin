import path from "node:path";

export type AgentDefinitionDirectoryKind = "agent" | "mode";
export type AgentSourceOwnership = "workspace-owned-candidate" | "foreign";

export type ObservableAgentSource =
  | { readonly kind: "definition-directory"; readonly path: string; readonly directoryKind: AgentDefinitionDirectoryKind; readonly ownership: AgentSourceOwnership; readonly label: string }
  | { readonly kind: "config-file"; readonly path: string; readonly ownership: "foreign"; readonly label: string }
  | { readonly kind: "inline-config"; readonly raw: string; readonly ownership: "foreign"; readonly label: "OPENCODE_CONFIG_CONTENT" };

export type AbsolutePath = string & { readonly __brand: unique symbol };

export interface ResolveForeignAgentSourcesOptions {
  readonly workspaceRoot: AbsolutePath | string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly managedConfigFiles?: readonly string[];
  readonly additionalConfigRoots?: readonly string[];
}

export function resolveForeignAgentSources(
  options: ResolveForeignAgentSourcesOptions,
): readonly ObservableAgentSource[] {
  const sources: ObservableAgentSource[] = [];
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  
  function pushFile(p: string, ownership: "foreign" = "foreign", label?: string) {
    sources.push({ kind: "config-file", path: p, ownership, label: label ?? p });
  }
  
  function pushDir(p: string, dirKind: AgentDefinitionDirectoryKind, ownership: AgentSourceOwnership, label?: string) {
    sources.push({ kind: "definition-directory", path: p, directoryKind: dirKind, ownership, label: label ?? p });
  }

  function addConfigRoot(root: string, labelPrefix: string, isWorkspace: boolean = false) {
    pushFile(path.resolve(root, "opencode.json"), "foreign", labelPrefix ? "${labelPrefix} opencode.json" : "opencode.json");
    pushFile(path.resolve(root, "opencode.jsonc"), "foreign", labelPrefix ? "${labelPrefix} opencode.jsonc" : "opencode.jsonc");
    
    const opencodeDir = isWorkspace ? path.resolve(root, ".opencode") : root;
    pushDir(path.resolve(opencodeDir, "agent"), "agent", isWorkspace ? "workspace-owned-candidate" : "foreign", labelPrefix ? "${labelPrefix} agent dir" : "agent dir");
    pushDir(path.resolve(opencodeDir, "agents"), "agent", isWorkspace ? "workspace-owned-candidate" : "foreign", labelPrefix ? "${labelPrefix} agents dir" : "agents dir");
    pushDir(path.resolve(opencodeDir, "mode"), "mode", "foreign", labelPrefix ? "${labelPrefix} mode dir" : "mode dir");
    pushDir(path.resolve(opencodeDir, "modes"), "mode", "foreign", labelPrefix ? "${labelPrefix} modes dir" : "modes dir");
  }

  // 1 & 2: Workspace root
  const wsRoot = path.resolve(cwd, options.workspaceRoot);
  addConfigRoot(wsRoot, "workspace", true);

  // 3: Ancestors
  let current = path.dirname(wsRoot);
  while (current !== path.dirname(current)) {
    addConfigRoot(current, "ancestor", true); // Wait, "ancestor contributes opencode.json/jsonc and .opencode/{agent,agents,mode,modes}"
    current = path.dirname(current);
  }
  
  // 4: XDG/global
  const home = options.homeDir ?? (env.HOME || env.USERPROFILE || "");
  if (home) {
    const xdgConfigHome = env.XDG_CONFIG_HOME ? path.resolve(cwd, env.XDG_CONFIG_HOME) : path.resolve(home, ".config");
    addConfigRoot(path.resolve(xdgConfigHome, "opencode"), "xdg");
    addConfigRoot(path.resolve(home, ".opencode"), "home");
  }

  // 5: OPENCODE_CONFIG
  if (env.OPENCODE_CONFIG) {
    pushFile(path.resolve(cwd, env.OPENCODE_CONFIG), "foreign", "OPENCODE_CONFIG");
  }

  // 6: OPENCODE_CONFIG_DIR
  if (env.OPENCODE_CONFIG_DIR) {
    addConfigRoot(path.resolve(cwd, env.OPENCODE_CONFIG_DIR), "OPENCODE_CONFIG_DIR");
  }

  // 7: OPENCODE_CONFIG_CONTENT
  if (env.OPENCODE_CONFIG_CONTENT) {
    sources.push({ kind: "inline-config", raw: env.OPENCODE_CONFIG_CONTENT, ownership: "foreign", label: "OPENCODE_CONFIG_CONTENT" });
  }

  // 8: Managed & SDD_MODEL_ROUTING_EXTRA_WATCHED_CONFIG_ROOTS
  if (options.managedConfigFiles) {
    for (const f of options.managedConfigFiles) {
      pushFile(path.resolve(cwd, f), "foreign", "managed config");
    }
  }
  
  const extraRootsEnv = env.SDD_MODEL_ROUTING_EXTRA_WATCHED_CONFIG_ROOTS;
  if (extraRootsEnv) {
    for (const p of extraRootsEnv.split(path.delimiter)) {
      if (p) addConfigRoot(path.resolve(cwd, p), "extra config root");
    }
  }
  
  if (options.additionalConfigRoots) {
    for (const p of options.additionalConfigRoots) {
      if (p) addConfigRoot(path.resolve(cwd, p), "extra config root");
    }
  }

  // 9: Deduplicate by canonical path, keep first occurrence. Workspace agents retain workspace-owned-candidate
  const seen = new Set<string>();
  const deduped: ObservableAgentSource[] = [];
  
  for (const s of sources) {
    if (s.kind === "inline-config") {
      deduped.push(s);
      continue;
    }
    const cpath = (s.path as string).toLowerCase(); // basic normalization for deduplication
    if (!seen.has(cpath)) {
      seen.add(cpath);
      deduped.push(s);
    } else {
      // If the existing one is not workspace-owned-candidate and this one is, that shouldn't happen based on order.
      // Actually, if we encounter a workspace-owned candidate again via env, it should retain workspace-owned candidate.
      // But we keep the first one, which is the workspace-owned-candidate because we put workspace first.
    }
  }

  return deduped;
}
