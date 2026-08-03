/**
 * Domain logic for SDD entry flow (specs from `sdd-entry-flow`).
 * Design from docs/superpowers/specs/2026-08-01-sdd-phase-agents-design.md (§3).
 */

export interface ParsedRequest {
  taskDescription: string;
  modelPhrase: string | null;
  explicitSddMention: boolean;
}

export interface ResolvedChangeName {
  changeName: string | null;
  reused: boolean;
  askUser?: boolean;
  candidates?: string[];
}

/**
 * Pure domain parsing of free-text requests for explicit SDD mention,
 * task description, and raw model phrase.
 */
export function parseRequestTextDomain(text: string): ParsedRequest {
  const lower = text.toLowerCase();
  const hasExplicitSdd =
    lower.includes("sdd") ||
    lower.includes("/sdd-go") ||
    lower.includes("usando sdd") ||
    lower.includes("con sdd") ||
    lower.includes("en sdd");

  if (!hasExplicitSdd) {
    return {
      taskDescription: text.trim(),
      modelPhrase: null,
      explicitSddMention: false,
    };
  }

  let modelPhrase: string | null = null;
  let cleanText = text;

  const modelRegex =
    /(?:y\s+el\s+modelo|usando\s+el\s+modelo|con\s+el\s+modelo|el\s+modelo|modelo)\s+([a-zA-Z0-9.\-\s]+)$/i;
  const match = modelRegex.exec(text);

  if (match && match[1]) {
    modelPhrase = match[1].trim();
    cleanText = cleanText.slice(0, match.index);
  }

  cleanText = cleanText
    .replace(/\/sdd-go/gi, "")
    .replace(/\busando\s+sdd\b/gi, "")
    .replace(/\bcon\s+sdd\b/gi, "")
    .replace(/\ben\s+sdd\b/gi, "")
    .replace(/\by\s+sdd\b/gi, "")
    .replace(/\bsdd\b/gi, "")
    .replace(/^\s*Quiero\s+crear\s+(?:un|una)?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  return {
    taskDescription: cleanText,
    modelPhrase,
    explicitSddMention: true,
  };
}

/**
 * Derives a deterministic slug from the task description.
 */
export function slugifyTaskDescription(description: string): string {
  const normalized = description
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const words = normalized
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0 && !["en", "de", "del", "el", "la", "los", "las", "un", "una", "unos", "unas", "a", "an", "the", "in", "for", "of", "to", "and", "y"].includes(w));

  return words.join("-");
}


/**
 * Resolves change name against existing changes, handling reuse vs ambiguous collision.
 *
 * EF-6: an EXACT match reuses; a PREFIX match (existing change starts with
 * `derivedSlug + "-"`, i.e. a real word boundary) flags ambiguity. The
 * earlier `startsWith(derivedSlug)` check let a slug like "auth" silently
 * reuse "auth-refactor" — `startsWith` without a boundary matches any
 * extension, not just the same change with a suffix. Now "auth" only collides
 * with "auth-something", and a bare "auth" existing change is the exact-match
 * reuse path, never a prefix collision with itself.
 */
export function resolveChangeNameDomain(
  derivedSlug: string,
  existingChanges: readonly { changeName: string }[],
): ResolvedChangeName {
  const exactMatches = existingChanges.filter((c) => c.changeName === derivedSlug);
  const prefixMatches = existingChanges.filter(
    (c) => c.changeName !== derivedSlug && c.changeName.startsWith(`${derivedSlug}-`),
  );

  if (exactMatches.length > 0) {
    // Exact name already exists — reuse it. (Two exact matches is itself
    // ambiguous, but the store keys by changeName so this shouldn't happen.)
    if (exactMatches.length > 1) {
      return {
        changeName: null,
        reused: false,
        askUser: true,
        candidates: exactMatches.map((c) => c.changeName),
      };
    }
    return {
      changeName: exactMatches[0]!.changeName,
      reused: true,
    };
  }

  if (prefixMatches.length > 1) {
    return {
      changeName: null,
      reused: false,
      askUser: true,
      candidates: prefixMatches.map((c) => c.changeName),
    };
  }

  if (prefixMatches.length === 1) {
    // A single prefix match is still ambiguous from the user's perspective:
    // "did you mean auth-login or auth-signup?" We ask rather than silently
    // reuse, because a bare slug colliding with a suffixed change is the
    // exact ambiguity EF-6 targets.
    return {
      changeName: null,
      reused: false,
      askUser: true,
      candidates: prefixMatches.map((c) => c.changeName),
    };
  }

  return {
    changeName: derivedSlug,
    reused: false,
  };
}
