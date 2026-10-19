import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { integer, object, text } from "../src/validation";

const root = fileURLToPath(new URL("../", import.meta.url));
const project = `omp-sync-smoke-${randomUUID().slice(0, 8)}`;
const environment = { ...process.env, OMP_SYNC_PUBLISH_HOST: "127.0.0.1", OMP_SYNC_PUBLISH_PORT: "0" };
const prefix = ["docker", "compose", "--project-name", project];

async function compose(...args: string[]) {
  const process = Bun.spawn([...prefix, ...args], { cwd: root, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Compose ${args[0]} failed (${exitCode}): ${stderr}`);
  return stdout;
}

async function admin(...args: string[]) {
  return object(JSON.parse(await compose("exec", "-T", "sync", "bun", "/app/src/main.ts", ...args)));
}

let base: string;
async function api(path: string, token?: string, payload?: unknown, status = 200) {
  const response = await fetch(base + path, {
    method: payload === undefined ? "GET" : "POST",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(payload === undefined ? {} : { "Content-Type": "application/json" }) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, status, `${path} returned unexpected HTTP status`);
  return object(await response.json());
}

try {
  await compose("config", "--quiet");
  const pull = process.env.OMP_SYNC_SMOKE_PULL === "1";
  await compose("up", ...(pull ? ["--no-build", "--pull", "always"] : ["--build", "--pull", "never"]), "--wait", "--wait-timeout", "120");
  const address = (await compose("port", "sync", "8787")).trim();
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  base = `http://${address}`;
  assert.equal((await api("/healthz")).status, "ok");
  assert.equal((await api("/v1/healthz")).ok, true);
  await api("/v1/snapshot", undefined, undefined, 401);

  const first = await api("/sync/v1/pair", undefined, { code: text((await admin("pair", "--name", "Smoke A", "--profile", "smoke")).code, "pairing code") }, 201);
  const second = await api("/sync/v1/pair", undefined, { code: text((await admin("pair", "--name", "Smoke B", "--profile", "smoke")).code, "pairing code") }, 201);
  const token = text(first.token, "device token");
  const peerToken = text(second.token, "device token");
  const peerId = text(object(second.device).id, "device id");
  const initial = await api("/sync/v1/snapshot", token);
  const epoch = text(initial.epoch, "epoch");
  const write = { epoch, operationId: randomUUID(), mutations: [{ kind: "setting", key: "theme.dark", expectedRevision: 0, value: "smoke-theme" }] };
  const committed = await api("/sync/v1/mutations", token, write);
  const cursor = integer(committed.cursor, "cursor");
  assert.deepEqual(await api("/sync/v1/mutations", token, write), committed);
  const snapshot = await api("/sync/v1/snapshot", peerToken);
  assert.ok(Array.isArray(snapshot.records));
  assert.ok(snapshot.records.map(object).some(record => record.key === "theme.dark" && record.value === "smoke-theme"));
  assert.equal(object((await api("/sync/v1/mutations", peerToken, { ...write, operationId: randomUUID() }, 409)).error).code, "conflict");

  await api("/v1/credential", token, { provider: "ci-smoke", credential: { type: "api_key", key: "synthetic-ci-key-not-valid-at-any-provider" } });
  await compose("exec", "-T", "sync", "bun", "-e", "import {existsSync,readFileSync} from 'node:fs';if(existsSync('/broker')||existsSync('/broker-token/.omp/agent/agent.db')||existsSync('/data/.omp/agent/agent.db'))throw Error('broker vault is exposed');if(!readFileSync('/broker-token/.omp/auth-broker.token','utf8').trim())throw Error('broker token is missing');");

  const stream = await fetch(`${base}/v1/snapshot/stream`, { headers: { Authorization: `Bearer ${peerToken}` }, signal: AbortSignal.timeout(10_000) });
  assert.equal(stream.status, 200);
  assert.equal(stream.headers.get("x-accel-buffering"), "no");
  assert.ok(stream.body);
  const reader = stream.body.getReader();
  assert.equal((await reader.read()).done, false);
  await admin("revoke", peerId);
  const ended = await reader.read().then(chunk => chunk.done, () => true);
  assert.equal(ended, true);
  await api("/v1/snapshot", peerToken, undefined, 401);

  await compose("up", "--force-recreate", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "120");
  // A recreated service can receive a different ephemeral host port.
  const recreatedAddress = (await compose("port", "sync", "8787")).trim();
  assert.match(recreatedAddress, /^127\.0\.0\.1:\d+$/);
  base = `http://${recreatedAddress}`;
  const persisted = await api("/sync/v1/snapshot", token);
  assert.equal(persisted.epoch, epoch);
  assert.equal(persisted.cursor, cursor);
  assert.deepEqual(await api("/sync/v1/mutations", token, write), committed);
  await api("/v1/snapshot", peerToken, undefined, 401);
  const vault = await api("/v1/snapshot", token);
  assert.ok(Array.isArray(vault.credentials));
  assert.ok(vault.credentials.map(object).some(entry => entry.provider === "ci-smoke"));
  console.log(`Compose smoke passed (${pull ? "pulled images" : "local builds"}): pairing, two-device sync, conflicts, idempotency, broker isolation, stream revocation, and recreation persistence`);
} catch (error) {
  try { console.error(await compose("logs", "--no-color", "--tail", "100")); } catch { /* Preserve the original failure. */ }
  throw error;
} finally {
  await compose("down", "--volumes", "--remove-orphans");
}
