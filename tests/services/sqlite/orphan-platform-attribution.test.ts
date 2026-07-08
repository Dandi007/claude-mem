import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { ORPHAN_PLATFORM_SOURCE } from '../../../src/shared/platform-source.js';

// Orphan platform attribution: an observation whose owning sdk_sessions row can
// no longer be resolved (its mutable memory_session_id was rewritten on session
// resume while PRAGMA foreign_keys was off, so ON UPDATE CASCADE never fired)
// must NOT be silently attributed to 'claude'. Read-side LEFT-JOIN sites bucket
// it as ORPHAN_PLATFORM_SOURCE ('unknown') so it stays honest and quantifiable,
// and never bleeds into a claude-scoped search.
describe('orphan platform attribution', () => {
  let store: SessionStore;
  let search: SessionSearch;

  function seedObservation(
    contentSessionId: string,
    memorySessionId: string,
    platformSource: string,
    title: string,
    narrative: string,
  ): void {
    const sdkId = store.createSDKSession(contentSessionId, 'orphan-project', 'prompt', undefined, platformSource);
    store.ensureMemorySessionIdRegistered(sdkId, memorySessionId);
    store.storeObservation(memorySessionId, 'orphan-project', {
      type: 'discovery',
      title,
      subtitle: null,
      facts: [],
      narrative,
      concepts: [],
      files_read: [],
      files_modified: [],
    }, 1);
  }

  // Reproduce the real bug: the production worker's DB handle ran with
  // PRAGMA foreign_keys OFF, so rewriting a session's mutable memory_session_id
  // on resume did NOT cascade to its observations — they were left dangling.
  // We turn FK off here to model that exact condition, then rewrite in place.
  function orphanSession(oldMemorySessionId: string, newMemorySessionId: string): void {
    store.db.run('PRAGMA foreign_keys = OFF');
    store.db.run(
      'UPDATE sdk_sessions SET memory_session_id = ? WHERE memory_session_id = ?',
      [newMemorySessionId, oldMemorySessionId],
    );
    store.db.run('PRAGMA foreign_keys = ON');
  }

  beforeEach(() => {
    store = new SessionStore(':memory:');
    search = new SessionSearch(store.db);

    seedObservation('live-sess', 'live-mem', 'claude', 'Live finding', 'shared orphan keyword live');
    seedObservation('doomed-sess', 'doomed-mem', 'claude', 'Doomed finding', 'shared orphan keyword doomed');
    // Sever the second observation's lineage — it is now an orphan.
    orphanSession('doomed-mem', 'doomed-mem-rewritten');
  });

  afterEach(() => {
    store.close();
  });

  it('sanity: exactly one observation is now an orphan', () => {
    const orphanCount = store.db
      .prepare(`SELECT COUNT(*) AS n FROM observations o
                LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
                WHERE s.memory_session_id IS NULL`)
      .get() as { n: number };
    expect(orphanCount.n).toBe(1);
  });

  it('SELECT path: orphan observation reads back as unknown, not claude', () => {
    const recent = store.getAllRecentObservations(50);
    const orphan = recent.find(o => o.title === 'Doomed finding');
    const live = recent.find(o => o.title === 'Live finding');
    expect(orphan?.platform_source).toBe(ORPHAN_PLATFORM_SOURCE); // 'unknown'
    expect(live?.platform_source).toBe('claude');
  });

  it('filter path: orphan does NOT bleed into a claude-scoped search', () => {
    const claudeResults = search.searchObservations('orphan', { platformSource: 'claude', project: 'orphan-project' });
    expect(claudeResults.map(r => r.title)).toEqual(['Live finding']);
  });

  it('filter path: orphan IS retrievable under an unknown-scoped search', () => {
    const unknownResults = search.searchObservations('orphan', { platformSource: ORPHAN_PLATFORM_SOURCE, project: 'orphan-project' });
    expect(unknownResults.map(r => r.title)).toEqual(['Doomed finding']);
  });
});
