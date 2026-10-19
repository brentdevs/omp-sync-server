import { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { HttpError } from "./errors";
import { canonical, type Kind, type MutationRequest, text } from "./validation";

type DeviceRow = { id: string; name: string; profile: string; created_at: number; revoked_at: number | null };
export type Device = { id: string; name: string; profile: string; createdAt: number; revokedAt: number | null };
type Row = { revision: number; kind: Kind; key: string; value: string | null; deleted: number; device_id: string; created_at: number };
export type SyncRecord = { revision: number; kind: Kind; key: string; value?: unknown; deleted: boolean; deviceId: string; updatedAt: number };
export function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function device(row: DeviceRow): Device { return { id: row.id, name: row.name, profile: row.profile, createdAt: row.created_at, revokedAt: row.revoked_at }; }
function record(row: Row): SyncRecord {
  return { revision: row.revision, kind: row.kind, key: row.key, deleted: !!row.deleted, deviceId: row.device_id, updatedAt: row.created_at, ...(!row.deleted ? { value: JSON.parse(row.value!) } : {}) };
}

export class Store {
  readonly db: Database;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const path = join(dataDir, "sync.db");
    this.db = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
    if (version > 1) throw new Error("Database schema is newer than this server");
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, profile TEXT NOT NULL,
          token_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS pairings (
          code_hash TEXT PRIMARY KEY, name TEXT NOT NULL, profile TEXT NOT NULL, expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS changes (
          revision INTEGER PRIMARY KEY AUTOINCREMENT, profile TEXT NOT NULL,
          kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT, deleted INTEGER NOT NULL,
          device_id TEXT NOT NULL REFERENCES devices(id), created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS changes_profile ON changes(profile, revision);
        CREATE TABLE IF NOT EXISTS records (
          profile TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL,
          revision INTEGER NOT NULL REFERENCES changes(revision),
          PRIMARY KEY(profile, kind, key)
        );
        CREATE TABLE IF NOT EXISTS operations (
          device_id TEXT NOT NULL REFERENCES devices(id), operation_id TEXT NOT NULL,
          fingerprint TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(device_id, operation_id)
        );
        PRAGMA user_version=1;
      `);
      this.db.query("INSERT OR IGNORE INTO metadata(key,value) VALUES ('epoch',?)").run(randomUUID());
    }).immediate();
  }
  get epoch(): string { return this.db.query<{ value: string }, []>("SELECT value FROM metadata WHERE key='epoch'").get()!.value; }
  rotateEpoch(): string {
    const epoch = randomUUID();
    this.db.query("UPDATE metadata SET value=? WHERE key='epoch'").run(epoch);
    return epoch;
  }
  close(): void { this.db.close(); }
  backup(path: string): void { this.db.query("VACUUM INTO ?").run(resolve(path)); chmodSync(resolve(path), 0o600); }
  issuePairing(name: string, profile: string): { code: string; expiresAt: number; profile: string } {
    text(name, "name"); text(profile, "profile");
    const code = randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + 600_000;
    this.db.transaction(() => {
      this.db.query("DELETE FROM pairings WHERE expires_at<=?").run(Date.now());
      this.db.query("INSERT INTO pairings VALUES (?,?,?,?)").run(digest(code), name, profile, expiresAt);
    }).immediate();
    return { code, expiresAt, profile };
  }
  pair(code: string): { device: Device; token: string } {
    return this.db.transaction(() => {
      const pairing = this.db.query<{ name: string; profile: string; expires_at: number }, [string]>("SELECT name,profile,expires_at FROM pairings WHERE code_hash=?").get(digest(code));
      if (!pairing || pairing.expires_at <= Date.now()) throw new HttpError(401, "invalid_pairing", "Pairing code is invalid or expired");
      const id = randomUUID();
      const token = `omps_${randomBytes(32).toString("base64url")}`;
      const now = Date.now();
      this.db.query("DELETE FROM pairings WHERE code_hash=?").run(digest(code));
      this.db.query("INSERT INTO devices VALUES (?,?,?,?,?,NULL)").run(id, pairing.name, pairing.profile, digest(token), now);
      return { device: { id, name: pairing.name, profile: pairing.profile, createdAt: now, revokedAt: null }, token };
    }).immediate();
  }
  authenticate(token: string): Device {
    const row = this.db.query<DeviceRow, [string]>("SELECT id,name,profile,created_at,revoked_at FROM devices WHERE token_hash=? AND revoked_at IS NULL").get(digest(token));
    if (!row) throw new HttpError(401, "unauthorized", "Invalid or revoked device token");
    return device(row);
  }
  isActive(id: string): boolean { return !!this.db.query("SELECT 1 FROM devices WHERE id=? AND revoked_at IS NULL").get(id); }
  devices(): Device[] { return this.db.query<DeviceRow, []>("SELECT id,name,profile,created_at,revoked_at FROM devices ORDER BY created_at,id").all().map(device); }
  revoke(id: string): void {
    const result = this.db.query("UPDATE devices SET revoked_at=COALESCE(revoked_at,?) WHERE id=?").run(Date.now(), id);
    if (!result.changes) throw new HttpError(404, "device_not_found", "No such device");
  }
  cursor(profile: string): number { return this.db.query<{ cursor: number }, [string]>("SELECT COALESCE(MAX(revision),0) AS cursor FROM changes WHERE profile=?").get(profile)!.cursor; }
  snapshot(profile: string) {
    return this.db.transaction(() => ({
      epoch: this.epoch,
      profile,
      cursor: this.cursor(profile),
      records: this.db.query<Row, [string]>("SELECT c.* FROM records r JOIN changes c ON c.revision=r.revision WHERE r.profile=? ORDER BY c.kind,c.key").all(profile).map(record),
    }))();
  }
  checkCursor(profile: string, epoch: string, cursor: number): void {
    if (epoch !== this.epoch || cursor > this.cursor(profile)) throw new HttpError(409, "resync_required", "Fetch a fresh snapshot before resuming changes");
  }
  changes(profile: string, epoch: string, cursor: number) {
    return this.db.transaction(() => {
      this.checkCursor(profile, epoch, cursor);
      const rows = this.db.query<Row, [string, number]>("SELECT * FROM changes WHERE profile=? AND revision>? ORDER BY revision LIMIT 101").all(profile, cursor);
      const page = rows.slice(0, 100);
      return { epoch: this.epoch, changes: page.map(record), cursor: page.at(-1)?.revision ?? cursor, hasMore: rows.length > 100 };
    })();
  }
  mutate(caller: Device, input: MutationRequest) {
    return this.db.transaction(() => {
      // Recheck inside the write transaction: a revoked device cannot win a race with an administrator.
      if (!this.isActive(caller.id)) throw new HttpError(401, "unauthorized", "Device revoked");
      if (input.epoch !== this.epoch) throw new HttpError(409, "resync_required", "Fetch a fresh snapshot before writing changes");
      const fingerprint = digest(canonical(input));
      const previous = this.db.query<{ fingerprint: string; response: string }, [string, string]>("SELECT fingerprint,response FROM operations WHERE device_id=? AND operation_id=?").get(caller.id, input.operationId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new HttpError(409, "operation_reused", "operationId was already used for different mutations");
        return JSON.parse(previous.response) as { epoch: string; cursor: number; records: SyncRecord[] };
      }
      const conflicts = input.mutations.flatMap(mutation => {
        const current = this.db.query<{ revision: number }, [string, string, string]>("SELECT revision FROM records WHERE profile=? AND kind=? AND key=?").get(caller.profile, mutation.kind, mutation.key)?.revision ?? 0;
        return current === mutation.expectedRevision ? [] : [{ kind: mutation.kind, key: mutation.key, expectedRevision: mutation.expectedRevision, actualRevision: current }];
      });
      if (conflicts.length) throw new HttpError(409, "conflict", "No changes were applied; refresh and resolve conflicting revisions", { conflicts });
      const now = Date.now();
      const records = input.mutations.map(mutation => {
        const value = mutation.deleted ? null : JSON.stringify(mutation.value);
        const result = this.db.query("INSERT INTO changes(profile,kind,key,value,deleted,device_id,created_at) VALUES (?,?,?,?,?,?,?)").run(caller.profile, mutation.kind, mutation.key, value, Number(mutation.deleted), caller.id, now);
        const revision = Number(result.lastInsertRowid);
        this.db.query("INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(profile,kind,key) DO UPDATE SET revision=excluded.revision").run(caller.profile, mutation.kind, mutation.key, revision);
        return { ...mutation, revision, deviceId: caller.id, updatedAt: now };
      }).map(({ expectedRevision: _, ...item }) => item);
      const response = { epoch: this.epoch, cursor: this.cursor(caller.profile), records };
      this.db.query("INSERT INTO operations VALUES (?,?,?,?)").run(caller.id, input.operationId, fingerprint, JSON.stringify(response));
      return response;
    }).immediate();
  }
}
