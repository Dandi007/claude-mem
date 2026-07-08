import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

// Regression for the orphan-lineage root cause: the worker's DatabaseManager
// opens a raw Database handle and hands it to SessionStore. foreign_keys is a
// per-connection pragma defaulting to OFF, and SessionStore only enables it on
// the path-constructed branch — so the worker connection ran with it OFF. When
// a session's memory_session_id is rewritten on resume (ensureMemorySessionIdRegistered),
// ON UPDATE CASCADE therefore never fired and every prior observation orphaned.
//
// These tests reproduce that exact handle-construction and prove the pragma is
// the difference between orphaning and cascading.
describe('worker DB handle FK pragma (orphan-lineage fix)', () => {
  let db: Database;
  let store: SessionStore;

  function orphanCount(): number {
    return (store.db
      .prepare(`SELECT COUNT(*) AS n FROM observations o
                LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
                WHERE s.memory_session_id IS NULL`)
      .get() as { n: number }).n;
  }

  function seedSessionWithObservation(): number {
    const sessionDbId = store.createSDKSession('content-id', 'fk-project', 'prompt');
    store.ensureMemorySessionIdRegistered(sessionDbId, 'mem-original');
    store.storeObservation('mem-original', 'fk-project', {
      type: 'discovery',
      title: 'Prior-round finding',
      subtitle: null,
      facts: [],
      narrative: 'written before the resume rewrite',
      concepts: [],
      files_read: [],
      files_modified: [],
    }, 1);
    return sessionDbId;
  }

  beforeEach(() => {
    // Mirror DatabaseManager: raw handle passed to SessionStore (FK-off branch).
    db = new Database(':memory:');
    store = new SessionStore(db);
  });

  afterEach(() => {
    store.close();
  });

  it('reproduces the bug: with foreign_keys OFF, a resume rewrite orphans prior observations', () => {
    db.run('PRAGMA foreign_keys = OFF');
    const sessionDbId = seedSessionWithObservation();
    expect(orphanCount()).toBe(0);

    // resume: SDK returns a new memory_session_id; ensureMemorySessionIdRegistered
    // rewrites it in place. With FK off, the prior observation is left dangling.
    store.ensureMemorySessionIdRegistered(sessionDbId, 'mem-rewritten');

    expect(orphanCount()).toBe(1);
  });

  it('the fix: with foreign_keys ON, the same rewrite CASCADES and keeps observations linked', () => {
    db.run('PRAGMA foreign_keys = ON'); // what DatabaseManager now sets on its handle
    const sessionDbId = seedSessionWithObservation();
    expect(orphanCount()).toBe(0);

    store.ensureMemorySessionIdRegistered(sessionDbId, 'mem-rewritten');

    // ON UPDATE CASCADE propagated the new id to the observation — no orphan.
    expect(orphanCount()).toBe(0);
    const obs = store.db
      .prepare(`SELECT memory_session_id FROM observations WHERE title = 'Prior-round finding'`)
      .get() as { memory_session_id: string };
    expect(obs.memory_session_id).toBe('mem-rewritten');
  });
});
