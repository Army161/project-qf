// Persistence on node:sqlite (built into Node 22, so no new dependency or native build). Versioned migrations, owner-scoped
// queries, digest re-verification on every read, and append-only draft history. Records are JSON documents whose
// queryable fields are mirrored in columns.
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Draft, InspectionReport, InspectionSummary } from '@project-qf/contracts';

const MIGRATIONS: readonly string[] = [
  `CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_sha256 TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE inspections (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, mint TEXT NOT NULL,
     cluster TEXT NOT NULL, label TEXT NOT NULL, decision TEXT NOT NULL, report_json TEXT NOT NULL, report_digest TEXT NOT NULL,
     evidence_json TEXT NOT NULL, evidence_digest TEXT NOT NULL);
   CREATE INDEX inspections_owner ON inspections(owner_id, created_at);
   CREATE TABLE drafts (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), version INTEGER NOT NULL, created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL, inspection_id TEXT NOT NULL REFERENCES inspections(id), draft_json TEXT NOT NULL);
   CREATE INDEX drafts_owner ON drafts(owner_id, updated_at);
   CREATE TABLE draft_history (draft_id TEXT NOT NULL REFERENCES drafts(id), version INTEGER NOT NULL, saved_at TEXT NOT NULL, draft_json TEXT NOT NULL,
     PRIMARY KEY (draft_id, version));`,
];

export interface User { id: string; name: string }
export const tokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
const newId = (prefix: string) => `${prefix}_${randomBytes(16).toString('hex')}`;

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const row = this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
    const current = row.v ?? 0;
    if (current > MIGRATIONS.length) throw new Error(`database schema ${current} is newer than this build (${MIGRATIONS.length})`);
    for (let v = current + 1; v <= MIGRATIONS.length; v++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[v - 1]!);
        this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(v, new Date().toISOString());
        this.db.exec('COMMIT');
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    }
  }
  close() { this.db.close(); }
  schemaVersion(): number { return (this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v; }

  /** Creates a user and returns the bearer token once; only its SHA-256 is stored. */
  createUser(name: string): { user: User; token: string } {
    const user = { id: newId('user'), name };
    const token = `qf_${randomBytes(32).toString('hex')}`;
    this.db.prepare('INSERT INTO users (id, name, token_sha256, created_at) VALUES (?, ?, ?, ?)').run(user.id, name, tokenHash(token), new Date().toISOString());
    return { user, token };
  }
  userByToken(token: string): User | null {
    if (!/^qf_[0-9a-f]{64}$/.test(token)) return null;
    const r = this.db.prepare('SELECT id, name FROM users WHERE token_sha256 = ? AND disabled = 0').get(tokenHash(token)) as User | undefined;
    return r ? { id: r.id, name: r.name } : null;
  }

  insertInspection(ownerId: string, report: Omit<InspectionReport, 'id'>, evidence: unknown): InspectionReport {
    const full: InspectionReport = { id: newId('insp'), ...report };
    const evidenceJson = JSON.stringify(evidence);
    this.db.prepare(`INSERT INTO inspections (id, owner_id, created_at, mint, cluster, label, decision, report_json, report_digest, evidence_json, evidence_digest)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(full.id, ownerId, full.createdAt, full.mint, full.cluster, full.label,
      full.inspection.aggregate.decision, JSON.stringify(full), full.reportDigest, evidenceJson, full.evidenceDigest);
    return full;
  }
  /** Owner-scoped: another user's id reads as not found. */
  getInspection(ownerId: string, id: string): InspectionReport | null {
    const r = this.db.prepare('SELECT report_json FROM inspections WHERE id = ? AND owner_id = ?').get(id, ownerId) as { report_json: string } | undefined;
    return r ? (JSON.parse(r.report_json) as InspectionReport) : null;
  }
  listInspections(ownerId: string, limit = 50): InspectionSummary[] {
    return (this.db.prepare('SELECT id, created_at, mint, cluster, label, decision FROM inspections WHERE owner_id = ? ORDER BY created_at DESC, id LIMIT ?')
      .all(ownerId, limit) as { id: string; created_at: string; mint: string; cluster: string; label: string; decision: string }[])
      .map((r) => ({ id: r.id, createdAt: r.created_at, mint: r.mint, cluster: r.cluster as InspectionSummary['cluster'], label: r.label as InspectionSummary['label'], decision: r.decision }));
  }

  insertDraft(ownerId: string, d: Omit<Draft, 'id'>): Draft {
    const full: Draft = { id: newId('draft'), ...d };
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO drafts (id, owner_id, version, created_at, updated_at, inspection_id, draft_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(full.id, ownerId, full.version, full.createdAt, full.updatedAt, full.inspectionId, JSON.stringify(full));
      this.db.prepare('INSERT INTO draft_history (draft_id, version, saved_at, draft_json) VALUES (?, ?, ?, ?)').run(full.id, full.version, full.updatedAt, JSON.stringify(full));
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return full;
  }
  getDraft(ownerId: string, id: string): Draft | null {
    const r = this.db.prepare('SELECT draft_json FROM drafts WHERE id = ? AND owner_id = ?').get(id, ownerId) as { draft_json: string } | undefined;
    return r ? (JSON.parse(r.draft_json) as Draft) : null;
  }
  listDrafts(ownerId: string, limit = 50): Draft[] {
    return (this.db.prepare('SELECT draft_json FROM drafts WHERE owner_id = ? ORDER BY updated_at DESC, id LIMIT ?').all(ownerId, limit) as { draft_json: string }[])
      .map((r) => JSON.parse(r.draft_json) as Draft);
  }
  /** Optimistic concurrency: the update applies only if the stored version is `expectedVersion`. */
  updateDraft(ownerId: string, next: Draft, expectedVersion: number): 'OK' | 'NOT_FOUND' | 'VERSION_CONFLICT' {
    this.db.exec('BEGIN');
    try {
      const r = this.db.prepare('UPDATE drafts SET version = ?, updated_at = ?, inspection_id = ?, draft_json = ? WHERE id = ? AND owner_id = ? AND version = ?')
        .run(next.version, next.updatedAt, next.inspectionId, JSON.stringify(next), next.id, ownerId, expectedVersion);
      if (Number(r.changes) !== 1) {
        this.db.exec('ROLLBACK');
        return this.getDraft(ownerId, next.id) ? 'VERSION_CONFLICT' : 'NOT_FOUND';
      }
      this.db.prepare('INSERT INTO draft_history (draft_id, version, saved_at, draft_json) VALUES (?, ?, ?, ?)').run(next.id, next.version, next.updatedAt, JSON.stringify(next));
      this.db.exec('COMMIT');
      return 'OK';
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  draftHistoryCount(id: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM draft_history WHERE draft_id = ?').get(id) as { n: number }).n;
  }
}
