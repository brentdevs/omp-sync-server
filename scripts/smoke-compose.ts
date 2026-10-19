import type { Subprocess } from "bun";
import { waitForServerEOF } from "./smoke-stream";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { integer, object, text } from "../src/validation";

const root = fileURLToPath(new URL("../", import.meta.url));
const project = `omp-sync-smoke-${randomUUID().slice(0, 8)}`;
const pull = process.env.OMP_SYNC_SMOKE_PULL === "1";
const environment = {
  ...process.env,
  OMP_SYNC_PUBLISH_HOST: "127.0.0.1",
  OMP_SYNC_PUBLISH_PORT: "0",
  ...(!pull ? { OMP_SYNC_IMAGE: `${project}-sync:smoke`, OMP_SYNC_BROKER_IMAGE: `${project}-broker:smoke` } : {}),
};
const prefix = [
  "docker", "compose", "--project-name", project,
  ...(pull ? ["--file", "docker-compose.yml", "--file", "docker-compose.images.yml"] : []),
];
const requests = new AbortController();
let activeCompose: Subprocess<"ignore", "pipe", "pipe"> | undefined;
let interrupted: "SIGINT" | "SIGTERM" | undefined;
let cleaningUp = false;
let mayHaveResources = false;
let failed = false;
let failure: unknown;

async function compose(...args: string[]) {
  if (interrupted && !cleaningUp) throw new Error(`Smoke interrupted by ${interrupted}`);
  const child = Bun.spawn([...prefix, ...args], {
    cwd: root, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    detached: process.platform !== "win32",
  });
  activeCompose = child;
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (exitCode !== 0) throw new Error(`Compose ${args[0]} failed (${exitCode}): ${stderr}`);
    return stdout;
  } finally { if (activeCompose === child) activeCompose = undefined; }
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
    signal: AbortSignal.any([requests.signal, AbortSignal.timeout(10_000)]),
  });
  assert.equal(response.status, status, `${path} returned unexpected HTTP status`);
  return object(await response.json());
}

function interrupt(signal: "SIGINT" | "SIGTERM") {
  if (interrupted) return;
  interrupted = signal;
  requests.abort();
  if (activeCompose && !cleaningUp) {
    try {
      // Docker launches the Compose plugin: stop the command group before teardown.
      if (process.platform === "win32") activeCompose.kill("SIGTERM");
      else process.kill(-activeCompose.pid, "SIGTERM");
    } catch (error) { console.error("Could not interrupt Compose:", error); }
  }
}
const onInterrupt = () => interrupt("SIGINT");
const onTerminate = () => interrupt("SIGTERM");
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onTerminate);

try {
  await compose("config", "--quiet");
  mayHaveResources = true;
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

  const streamAbort = new AbortController();
  const openingTimer = setTimeout(() => streamAbort.abort(), 10_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const stream = await fetch(`${base}/v1/snapshot/stream`, {
      headers: { Authorization: `Bearer ${peerToken}` },
      signal: AbortSignal.any([requests.signal, streamAbort.signal]),
    });
    assert.equal(stream.status, 200);
    assert.equal(stream.headers.get("x-accel-buffering"), "no");
    assert.ok(stream.body);
    reader = stream.body.getReader();
    assert.equal((await reader.read()).done, false);
    clearTimeout(openingTimer);
    await admin("revoke", peerId);
    assert.equal(await waitForServerEOF(reader), true);
  } finally {
    clearTimeout(openingTimer);
    streamAbort.abort();
    await reader?.cancel().catch(() => {});
  }
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
  failed = true;
  failure = error;
  if (mayHaveResources && !interrupted) {
    try { console.error(await compose("logs", "--no-color", "--tail", "100")); } catch { /* Preserve the original failure. */ }
  }
} finally {
  cleaningUp = true;
  try {
    if (mayHaveResources) await compose("down", "--volumes", "--remove-orphans", ...(!pull ? ["--rmi", "all"] : []));
  } catch (error) {
    console.error("Smoke cleanup failed:", error);
    if (!failed) { failed = true; failure = error; }
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}
if (interrupted) process.exitCode = interrupted === "SIGINT" ? 130 : 143;
else if (failed) throw failure;
