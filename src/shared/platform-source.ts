export const DEFAULT_PLATFORM_SOURCE = 'claude';

// Read-side attribution for a memory row (observation / summary / prompt) whose
// owning sdk_sessions row cannot be resolved via LEFT JOIN — i.e. an *orphan*.
// These rows are NOT claude sessions with a missing field; their lineage is
// severed (the mutable memory_session_id was rewritten while PRAGMA foreign_keys
// was off, so ON UPDATE CASCADE never fired). Bucketing them as DEFAULT_PLATFORM_SOURCE
// ('claude') silently misattributes them and lets them bleed into a claude-scoped
// filter. 'unknown' keeps the attribution honest and quantifiable.
// NOTE: only use this at read sites that LEFT JOIN sdk_sessions (orphan-capable).
// Sites that query sdk_sessions directly, or INNER JOIN it, keep DEFAULT_PLATFORM_SOURCE
// because their COALESCE fallback mirrors the NOT NULL column default, not an orphan.
export const ORPHAN_PLATFORM_SOURCE = 'unknown';

function sanitizeRawSource(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

export function normalizePlatformSource(value?: string | null): string {
  if (!value) return DEFAULT_PLATFORM_SOURCE;

  const source = sanitizeRawSource(value);
  if (!source) return DEFAULT_PLATFORM_SOURCE;

  if (source === 'transcript') return 'codex';
  if (source.includes('codex')) return 'codex';
  if (source.includes('cursor')) return 'cursor';
  if (source.includes('claude')) return 'claude';

  return source;
}

export function sortPlatformSources(sources: string[]): string[] {
  const priority = ['claude', 'codex', 'cursor'];

  return [...sources].sort((a, b) => {
    const aPriority = priority.indexOf(a);
    const bPriority = priority.indexOf(b);

    if (aPriority !== -1 || bPriority !== -1) {
      if (aPriority === -1) return 1;
      if (bPriority === -1) return -1;
      return aPriority - bPriority;
    }

    return a.localeCompare(b);
  });
}
