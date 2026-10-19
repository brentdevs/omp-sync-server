import type { Server } from "bun";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config";
import { startServer, type SyncServer } from "../src/server";
import { Store } from "../src/store";
import { waitForServerEOF } from "../scripts/smoke-stream";

const apps: SyncServer[] = [];
const upstreams: Server<undefined>[] = [];
const directories: string[] = [];
function fixture(overrides: Partial<Config> = {}, suppliedStore?: Store) {
  const dataDir = suppliedStore ? overrides.dataDir! : mkdtempSync(join(tmpdir(), "omp-sync-security-"));
  if (!suppliedStore) directories.push(dataDir);
  const app = startServer({ dataDir, host: "127.0.0.1", port: 0, ...overrides }, suppliedStore);
  apps.push(app);
  const paired = app.store.pair(app.store.issuePairing("Laptop", "work").code);
  const headers = { Authorization: `Bearer ${paired.token}`, "Content-Type": "application/json" };
  return { app, paired, headers, url: app.server.url.origin };
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const server of upstreams.splice(0)) await server.stop(true);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("public broker health cannot bypass authentication for credential routes", async () => {
  let protectedHits = 0;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/v1/healthz") return Response.json({ ok: true });
    protectedHits++;
    return Response.json({ credentials: [{ key: "protected-vault-value" }] });
  } });
  upstreams.push(upstream);
  const { url, paired } = fixture({ brokerUrl: upstream.url.origin, brokerToken: "private-master" });
  const health = await fetch(`${url}/v1/healthz`);
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ ok: true });
  for (const authorization of [undefined, "Basic arbitrary", "Bearer invalid", "Bearer ", `Bearer ${"x".repeat(257)}`]) {
    const response = await fetch(`${url}/v1/snapshot`, { headers: authorization ? { Authorization: authorization } : {} });
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("protected-vault-value");
  }
  expect(protectedHits).toBe(0);
  const authorized = await fetch(`${url}/v1/snapshot`, { headers: { Authorization: `bEaReR ${paired.token}` } });
  expect(authorized.status).toBe(200);
  expect(await authorized.text()).toContain("protected-vault-value");
  const method = await fetch(`${url}/v1/snapshot`, { method: "POST", headers: { Authorization: `Bearer ${paired.token}` } });
  expect(method.status).toBe(405);
  expect(method.headers.get("allow")).toBe("GET");
  expect(protectedHits).toBe(1);
});

test("an unconfigured broker fails without changing sync availability", async () => {
  const { url, headers } = fixture();
  const health = await fetch(`${url}/v1/healthz`);
  expect(health.status).toBe(503);
  const broker = await fetch(`${url}/v1/snapshot`, { headers });
  expect(broker.status).toBe(503);
  const sync = await fetch(`${url}/sync/v1/snapshot`, { headers });
  expect(sync.status).toBe(200);
});

test("HTTP broker stream revocation cancels upstream and releases device slots", async () => {
  const cancelled = Promise.withResolvers<void>();
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("event: snapshot\ndata: {}\n\n")); },
      cancel() { cancelled.resolve(); },
    }), { headers: { "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" } });
  } });
  upstreams.push(upstream);
  const { app, url, paired, headers } = fixture({ brokerUrl: upstream.url.origin, brokerToken: "master" });
  const response = await fetch(`${url}/v1/snapshot/stream`, { headers, signal: AbortSignal.timeout(5000) });
  const reader = response.body!.getReader();
  await reader.read();
  app.store.revoke(paired.device.id);
  expect(await waitForServerEOF(reader, 3000)).toBe(true);
  await cancelled.promise;
  expect((await fetch(`${url}/v1/snapshot`, { headers })).status).toBe(401);
}, 7000);

test("invalid Unicode identities never enter storage; valid supplementary characters round-trip", async () => {
  const { app, url, headers } = fixture();
  const epoch = app.store.epoch;
  const invalid = await fetch(`${url}/sync/v1/mutations`, { method: "POST", headers, body: JSON.stringify({
    epoch, operationId: "ill-formed", mutations: ["\ud800", "\ud801"].map(key => ({ kind: "setting", key, expectedRevision: 0, value: true })),
  }) });
  expect(invalid.status).toBe(400);
  expect(app.store.snapshot("work").records).toEqual([]);
  const key = "model.\ud83d\ude80";
  const created = await fetch(`${url}/sync/v1/mutations`, { method: "POST", headers, body: JSON.stringify({
    epoch, operationId: "valid-unicode", mutations: [{ kind: "setting", key, expectedRevision: 0, value: "\ud800" }],
  }) });
  expect(created.status).toBe(200);
  const snapshot = app.store.snapshot("work");
  expect(snapshot.records[0]).toMatchObject({ key, value: "\ud800" });
  const removed = await fetch(`${url}/sync/v1/mutations`, { method: "POST", headers, body: JSON.stringify({
    epoch, operationId: "delete-unicode", mutations: [{ kind: "setting", key: snapshot.records[0]!.key, expectedRevision: snapshot.records[0]!.revision, deleted: true }],
  }) });
  expect(removed.status).toBe(200);
  expect(app.store.snapshot("work").records[0]!.deleted).toBe(true);
});

test("declared and chunked oversized bodies are rejected without internal-error logging", async () => {
  const { app, url, headers } = fixture();
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const declared = await fetch(`${url}/sync/v1/mutations`, { method: "POST", headers, body: "x".repeat(1_048_577) });
    expect(declared.status).toBe(413);
    await declared.arrayBuffer();
    const chunked = await fetch(`${url}/sync/v1/mutations`, { method: "POST", headers, body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(524_288));
        controller.enqueue(new Uint8Array(524_290));
        controller.close();
      },
    }) });
    expect(chunked.status).toBe(413);
    await chunked.arrayBuffer();
    expect(log).not.toHaveBeenCalled();
    expect(app.store.snapshot("work").records).toEqual([]);
  } finally { log.mockRestore(); }
});

test("a failed revocation check closes existing streams rather than failing open", async () => {
  class FailingStore extends Store {
    failChecks = false;
    override isActive(id: string): boolean {
      if (this.failChecks) throw new Error("simulated unavailable database");
      return super.isActive(id);
    }
  }
  const dataDir = mkdtempSync(join(tmpdir(), "omp-sync-fault-"));
  directories.push(dataDir);
  const store = new FailingStore(dataDir);
  const { url, headers } = fixture({ dataDir }, store);
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await fetch(`${url}/sync/v1/events?epoch=${store.epoch}&cursor=0`, { headers, signal: AbortSignal.timeout(5000) });
    const reader = response.body!.getReader();
    await reader.read();
    store.failChecks = true;
    expect((await reader.read()).done).toBe(true);
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
  } finally { store.failChecks = false; log.mockRestore(); }
}, 7000);

test("shutdown releases the SQLite handle even when server stop fails", async () => {
  const { app } = fixture();
  const stop = app.server.stop.bind(app.server);
  app.server.stop = async force => { await stop(force); throw new Error("simulated stop failure"); };
  await expect(app.stop()).rejects.toBeInstanceOf(Error);
  expect(() => app.store.snapshot("work")).toThrow();
});

test("public pairing is single-use, profile-bound and rate-limited", async () => {
  const { app, url } = fixture();
  const issued = app.store.issuePairing("New device", "personal");
  const pair = () => fetch(`${url}/sync/v1/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: issued.code, profile: "work" }) });
  const first = await pair();
  expect(first.status).toBe(201);
  const enrolled = await first.json();
  const snapshot = await (await fetch(`${url}/sync/v1/snapshot`, { headers: { Authorization: `Bearer ${enrolled.token}` } })).json();
  expect(snapshot.profile).toBe("personal");
  for (let attempt = 1; attempt < 30; attempt++) {
    const reused = await pair();
    expect(reused.status).toBe(401);
    await reused.arrayBuffer();
  }
  expect((await pair()).status).toBe(429);
});

test("Last-Event-ID resumes notification position and epoch changes close the stream", async () => {
  const { app, headers, url } = fixture();
  const epoch = app.store.epoch;
  const response = await fetch(`${url}/sync/v1/events`, { headers: { ...headers, "Last-Event-ID": `${epoch}:0` }, signal: AbortSignal.timeout(5000) });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  await reader.read();
  app.store.rotateEpoch();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: resync\n");
  expect((await reader.read()).done).toBe(true);
  expect((await fetch(`${url}/sync/v1/changes?epoch=${epoch}&cursor=0`, { headers })).status).toBe(409);
}, 7000);
