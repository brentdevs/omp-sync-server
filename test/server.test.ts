import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type SyncServer } from "../src/server";
import { Store } from "../src/store";

const apps: SyncServer[] = [];
const directories: string[] = [];
function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "omp-sync-http-"));
  directories.push(dataDir);
  const app = startServer({ dataDir, host: "127.0.0.1", port: 0 });
  apps.push(app);
  const paired = app.store.pair(app.store.issuePairing("Laptop", "work").code);
  const headers = { Authorization: `Bearer ${paired.token}`, "Content-Type": "application/json" };
  const url = app.server.url.origin;
  return { app, paired, headers, url, dataDir };
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("device scopes cannot be overridden and conflict responses never contain secret values", async () => {
  const { app, headers, url } = fixture();
  expect((await fetch(`${url}/sync/v1/snapshot`)).status).toBe(401);
  const snapshot = await (await fetch(`${url}/sync/v1/snapshot`, { headers })).json();
  const input = { epoch: snapshot.epoch, operationId: "write", profile: "personal", mutations: [{ kind: "secret", key: "search-token", expectedRevision: 0, value: "sensitive-value" }] };
  expect((await fetch(`${url}/sync/v1/mutations`, { method: "POST", headers, body: JSON.stringify(input) })).status).toBe(200);
  const personal = app.store.pair(app.store.issuePairing("Other", "personal").code);
  const isolated = await (await fetch(`${url}/sync/v1/snapshot?profile=work`, { headers: { Authorization: `Bearer ${personal.token}` } })).json();
  expect(isolated.records).toEqual([]);
  const conflict = await fetch(`${url}/sync/v1/mutations`, { method: "POST", headers, body: JSON.stringify({ ...input, operationId: "stale" }) });
  expect(conflict.status).toBe(409);
  const message = await conflict.text();
  expect(message).toContain("actualRevision");
  expect(message).not.toContain("sensitive-value");
});

test("live notification, cursor replay and cross-process revocation work over HTTP", async () => {
  const { app, headers, url, paired, dataDir } = fixture();
  const snapshot = app.store.snapshot("work");
  const stream = await fetch(`${url}/sync/v1/events?epoch=${snapshot.epoch}&cursor=0`, { headers, signal: AbortSignal.timeout(8000) });
  const reader = stream.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: ready");
  const written = await (await fetch(`${url}/sync/v1/mutations`, { method: "POST", headers, body: JSON.stringify({ epoch: snapshot.epoch, operationId: "event", mutations: [{ kind: "setting", key: "theme.dark", expectedRevision: 0, value: "dark" }] }) })).json();
  const notification = new TextDecoder().decode((await reader.read()).value);
  expect(notification).toContain(`id: ${snapshot.epoch}:${written.cursor}`);
  expect(notification).toContain("event: changes");
  const changes = await (await fetch(`${url}/sync/v1/changes?epoch=${snapshot.epoch}&cursor=0`, { headers })).json();
  expect(changes.changes[0]).toMatchObject({ key: "theme.dark", value: "dark" });
  const peer = new Store(dataDir);
  try { peer.revoke(paired.device.id); } finally { peer.close(); }
  expect((await reader.read()).done).toBe(true);
  expect((await fetch(`${url}/sync/v1/snapshot`, { headers })).status).toBe(401);
}, 10_000);

test("invalid mutations and browser requests cannot change persisted settings", async () => {
  const { app, headers, url } = fixture();
  const epoch = app.store.epoch;
  const invalid = [
    { epoch, operationId: "missing-value", mutations: [{ kind: "setting", key: "x", expectedRevision: 0 }] },
    { epoch, operationId: "duplicate", mutations: [0, 1].map(value => ({ kind: "setting", key: "x", expectedRevision: 0, value })) },
    { epoch, operationId: "array-provider", mutations: [{ kind: "provider", key: "x", expectedRevision: 0, value: [] }] },
    { epoch, operationId: "fractional", mutations: [{ kind: "setting", key: "x", expectedRevision: 0.5, value: true }] },
    { epoch, operationId: "object-kind", mutations: [{ kind: { toString: null }, key: "x", expectedRevision: 0, value: true }] },
  ];
  for (const input of invalid) expect((await fetch(`${url}/sync/v1/mutations`, { method: "POST", headers, body: JSON.stringify(input) })).status).toBe(400);
  expect((await fetch(`${url}/sync/v1/snapshot`, { headers: { ...headers, Origin: "https://attacker.example" } })).status).toBe(403);
  expect(app.store.snapshot("work").records).toEqual([]);
});
