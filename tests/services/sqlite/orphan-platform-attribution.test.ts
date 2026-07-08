import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { ORPHAN_PLATFORM_SOURCE } from '../../../src/shared/platform-source.js';

// Post-migration-33 attribution model: read paths resolve a memory row to its
// session via the immutable session_db_id (→ sdk_sessions.id), NOT the mutable
// memory_session_id. So:
//   - a resume rewrite of memory_session_id no longer orphans anything (the
//     migration's whole point — session_db_id is stable);
//   - a TRUE orphan is a row whose session_db_id could not be resolved (NULL,
//     e.g. an old row the log-mining backfill couldn't recover). Those must read
//     as ORPHAN_PLATFORM_SOURCE ('unknown') and never bleed into a claude search.
describe('orphan platform attribution (session_db_id model)', () => {
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

  // An unrecoverable orphan: session_db_id could not be resolved/backfilled.
  function makeUnrecoverableOrphan(title: string): void {
    store.db.run('UPDATE observations SET session_db_id = NULL WHERE title = ?', [title]);
  }

  beforeEach(() => {
    store = new SessionStore(':memory:');
    search = new SessionSearch(store.db);

    seedObservation('live-sess', 'live-mem', 'claude', 'Live finding', 'shared orphan keyword live');
    seedObservation('doomed-sess', 'doomed-mem', 'claude', 'Doomed finding', 'shared orphan keyword doomed');
    makeUnrecoverableOrphan('Doomed finding');
  });

  afterEach(() => {
    store.close();
  });

  it('sanity: exactly one observation has an unresolved session_db_id', () => {
    const n = store.db.prepare('SELECT COUNT(*) AS n FROM observations WHERE session_db_id IS NULL').get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('SELECT path: unresolved-lineage observation reads back as unknown, not claude', () => {
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

  it('migration 33 heal: a memory_session_id rewrite (resume) no longer orphans — session_db_id keeps it linked', () => {
    // 'Live finding' was stored with session_db_id pointing at its session.
    // Simulate a resume rewrite of the session's mutable key.
    store.db.run("UPDATE sdk_sessions SET memory_session_id = 'live-mem-RESUMED' WHERE memory_session_id = 'live-mem'");
    const recent = store.getAllRecentObservations(50);
    const live = recent.find(o => o.title === 'Live finding');
    // Still resolves to the real platform via session_db_id — not orphaned.
    expect(live?.platform_source).toBe('claude');
  });
});
