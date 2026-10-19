import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { parseMutations } from "../src/validation";

const directories: string[] = [];
const stores: Store[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omp-sync-test-"));
  directories.push(dir);
  const store = new Store(dir);
  stores.push(store);
  const a = store.pair(store.issuePairing("A", "work").code).device;
  const b = store.pair(store.issuePairing("B", "work").code).device;
  return { store, dir, a, b };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("stale concurrent writes conflict atomically without losing independent changes", () => {
  const { store, dir, a, b } = fixture();
  const peer = new Store(dir); stores.push(peer);
  const mutation = (operationId: string, key: string, value: unknown, expectedRevision = 0) => parseMutations({ epoch: store.epoch, operationId, mutations: [{ kind: "setting", key, value, expectedRevision }] });
  const first = store.mutate(a, mutation("one", "theme", "dark"));
  peer.mutate(b, mutation("two", "model", "provider/model"));
  const before = store.snapshot("work");
  expect(() => peer.mutate(b, parseMutations({ epoch: store.epoch, operationId: "stale", mutations: [
    { kind: "setting", key: "theme", value: "light", expectedRevision: 0 },
    { kind: "setting", key: "retry", value: 3, expectedRevision: 0 },
  ] }))).toThrow("No changes were applied");
  expect(store.snapshot("work")).toEqual(before);
  expect(first.records[0]!.value).toBe("dark");
  expect(store.snapshot("personal").records).toEqual([]);
});

test("deletion tombstones prevent resurrection and replay cannot duplicate changes", () => {
  const { store, a, b } = fixture();
  const input = parseMutations({ epoch: store.epoch, operationId: "add", mutations: [{ kind: "provider", key: "custom", expectedRevision: 0, value: { baseUrl: "https://example.com", models: [] } }] });
  const initial = store.mutate(a, input);
  const deleted = store.mutate(b, parseMutations({ epoch: store.epoch, operationId: "delete", mutations: [{ kind: "provider", key: "custom", expectedRevision: initial.records[0]!.revision, deleted: true }] }));
  expect(store.mutate(a, input)).toEqual(initial);
  expect(store.snapshot("work").cursor).toBe(deleted.cursor);
  expect(store.snapshot("work").records[0]).toMatchObject({ deleted: true, revision: deleted.cursor });
  expect(() => store.mutate(a, { ...input, operationId: "resurrect" })).toThrow("No changes were applied");
  expect(() => store.mutate(a, { ...input, mutations: [{ ...input.mutations[0]!, value: {} }] })).toThrow("operationId was already used");
});

test("pairing codes are single use, expiring, and revocation is shared across processes", () => {
  const { store, dir } = fixture();
  const pairing = store.issuePairing("Laptop", "personal");
  const paired = store.pair(pairing.code);
  expect(() => store.pair(pairing.code)).toThrow("Pairing code is invalid");
  expect(store.authenticate(paired.token).profile).toBe("personal");
  const expired = store.issuePairing("Expired", "personal");
  store.db.query("UPDATE pairings SET expires_at=0").run();
  expect(() => store.pair(expired.code)).toThrow("Pairing code is invalid");
  const peer = new Store(dir); stores.push(peer);
  peer.revoke(paired.device.id);
  expect(() => store.authenticate(paired.token)).toThrow("Invalid or revoked");
  expect(() => store.mutate(paired.device, parseMutations({ epoch: store.epoch, operationId: "revoked", mutations: [{ kind: "setting", key: "x", expectedRevision: 0, value: true }] }))).toThrow("Device revoked");
});

test("change pagination and epoch invalidation protect reconnects and restored backups", () => {
  const { store, a, dir } = fixture();
  const epoch = store.epoch;
  for (let i = 0; i < 102; i++) store.mutate(a, parseMutations({ epoch, operationId: `op-${i}`, mutations: [{ kind: "setting", key: `key-${i}`, expectedRevision: 0, value: i }] }));
  const first = store.changes("work", epoch, 0);
  expect(first.hasMore).toBe(true);
  const second = store.changes("work", epoch, first.cursor);
  expect(second.hasMore).toBe(false);
  expect([...first.changes, ...second.changes].map(item => item.value)).toEqual(Array.from({ length: 102 }, (_, i) => i));
  const backup = join(dir, "backup.db");
  store.backup(backup);
  expect(() => store.backup(backup)).toThrow();
  store.rotateEpoch();
  expect(() => store.changes("work", epoch, first.cursor)).toThrow("Fetch a fresh snapshot");
  expect(() => store.mutate(a, parseMutations({ epoch, operationId: "old-epoch", mutations: [{ kind: "setting", key: "new", value: true, expectedRevision: 0 }] }))).toThrow("Fetch a fresh snapshot");
  expect(store.snapshot("work").cursor).toBe(second.cursor);
});
