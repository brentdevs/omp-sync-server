import type { Server } from "bun";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { waitForServerEOF } from "../scripts/smoke-stream";

interface EventFixture {
  server: Server<undefined>;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  controller: ReadableStreamDefaultController<Uint8Array>;
  abort: AbortController;
}
const streams: EventFixture[] = [];
async function eventFixture() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return new Response(new ReadableStream<Uint8Array>({ start(source) {
      controller = source;
      source.enqueue(new TextEncoder().encode(": connected\n\n"));
    } }), { headers: { "Content-Type": "text/event-stream" } });
  } });
  const abort = new AbortController();
  const response = await fetch(server.url, { signal: abort.signal });
  const reader = response.body!.getReader();
  await reader.read();
  const fixture = { server, reader, controller, abort };
  streams.push(fixture);
  return fixture;
}
afterEach(async () => {
  for (const fixture of streams.splice(0)) {
    fixture.abort.abort();
    await fixture.reader.cancel().catch(() => {});
    await fixture.server.stop(true);
  }
});

test("revocation accepts clean server EOF after any queued events", async () => {
  const fixture = await eventFixture();
  fixture.controller.enqueue(new TextEncoder().encode(": queued\n\n"));
  fixture.controller.close();
  expect(await waitForServerEOF(fixture.reader, 1000)).toBe(true);
});

test("a stream kept open by the server fails the revocation deadline", async () => {
  const fixture = await eventFixture();
  // Exercise the native watchdog against a live HTTP body; fake time cannot drive network I/O.
  await expect(waitForServerEOF(fixture.reader, 200)).rejects.toBeInstanceOf(Error);
});

test("client-side abort is not successful server revocation", async () => {
  const fixture = await eventFixture();
  const result = waitForServerEOF(fixture.reader, 1000);
  fixture.abort.abort(new DOMException("simulated client deadline", "TimeoutError"));
  await expect(result).rejects.toBeInstanceOf(Error);
});

function dockerFixture(directory: string) {
  // A process-level Docker fault adapter: models a partially-created resource,
  // command failure and cleanup. It never starts a daemon or reads real secrets.
  writeFileSync(join(directory, "docker"), `#!${process.execPath}
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
const command = process.argv[5];
const resource = process.env.SMOKE_TEST_RESOURCE;
if (command === 'config') process.exit(0);
if (command === 'up') {
  writeFileSync(resource, 'created');
  if (process.env.SMOKE_TEST_MODE === 'fail') { console.error('PRIMARY_UP_FAILURE'); process.exit(61); }
  Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return new Response('waiting'); } });
} else if (command === 'logs') {
  console.log('diagnostic log');
} else if (command === 'down') {
  if (process.env.SMOKE_TEST_MODE === 'fail') { console.error('SECONDARY_DOWN_FAILURE'); process.exit(62); }
  if (existsSync(resource)) unlinkSync(resource);
  writeFileSync(process.env.SMOKE_TEST_CLEANED, 'cleaned');
} else process.exit(63);
`, { mode: 0o755 });
}

function launchSmoke(directory: string, mode: string) {
  return Bun.spawn([process.execPath, join(import.meta.dir, "../scripts/smoke-compose.ts")], {
    env: {
      ...process.env,
      PATH: `${directory}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      OMP_SYNC_SMOKE_PULL: "0",
      SMOKE_TEST_RESOURCE: join(directory, "resource"),
      SMOKE_TEST_CLEANED: join(directory, "cleaned"),
      SMOKE_TEST_MODE: mode,
    },
    stdout: "pipe", stderr: "pipe",
  });
}

test("cleanup failure preserves the original actionable command failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omp-smoke-failure-"));
  dockerFixture(directory);
  const child = launchSmoke(directory, "fail");
  try {
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("PRIMARY_UP_FAILURE");
    expect(stderr).toContain("SECONDARY_DOWN_FAILURE");
  } finally {
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);

for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  test(`${signal} cancels the active command and cleans partial resources`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "omp-smoke-signal-"));
    dockerFixture(directory);
    const ready = Promise.withResolvers<void>();
    const watcher = watch(directory, () => {
      if (existsSync(join(directory, "resource"))) ready.resolve();
    });
    // Native subprocess/filesystem readiness cannot be advanced by fake timers.
    const deadline = setTimeout(() => ready.reject(new Error("Smoke process did not create its fixture resource")), 5000);
    const child = launchSmoke(directory, "signal");
    try {
      await ready.promise;
      child.kill(signal);
      const [code] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code).toBe(exitCode);
      expect(existsSync(join(directory, "resource"))).toBe(false);
      expect(existsSync(join(directory, "cleaned"))).toBe(true);
    } finally {
      clearTimeout(deadline);
      watcher.close();
      if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);
}
