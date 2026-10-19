import type { Server } from "bun";
import { afterEach, describe, expect, test } from "bun:test";
import { proxyBroker } from "../src/broker";

const MASTER_TOKEN = "owner-master-token-never-return";
const servers: Server<undefined>[] = [];

function upstream(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: handler });
  servers.push(server);
  return server;
}

function config(server: Server<undefined>) {
  return { brokerUrl: server.url.origin, brokerToken: MASTER_TOKEN };
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

describe("broker proxy", () => {
  test("device credentials cannot forge upstream identity or receive internal response headers", async () => {
    let boundaryFailure: string | undefined;
    const broker = upstream(async request => {
      const url = new URL(request.url);
      if (request.headers.get("authorization") !== `Bearer ${MASTER_TOKEN}`) return new Response(null, { status: 401 });
      const forbidden = ["cookie", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "x-device-id", "x-unapproved"];
      if (forbidden.some(name => request.headers.has(name))) boundaryFailure = "Caller identity crossed broker boundary";
      if (request.headers.get("host") !== broker.url.host) boundaryFailure = "Caller controlled upstream Host";
      if (request.headers.get("omp-auth-broker-capabilities") !== "codex-meter-block-scopes") {
        return new Response(null, { status: 400 });
      }
      if (request.method === "POST" && url.pathname === "/v1/credential") {
        if (request.headers.get("content-type") !== "application/json" || request.headers.get("accept") !== "application/json") {
          return new Response(null, { status: 415 });
        }
        await request.json();
        return new Response(null, { status: 204, headers: { "Set-Cookie": "owner=secret", "X-Internal": "private" } });
      }
      return new Response(null, { status: 404 });
    });
    const headers = {
      Authorization: "Bearer device-token",
      "Content-Type": "application/json",
      Accept: "application/json",
      "OMP-Auth-Broker-Capabilities": "codex-meter-block-scopes",
      Host: "attacker.invalid",
      Cookie: "session=private",
      Forwarded: "host=attacker.invalid;for=203.0.113.4",
      "X-Forwarded-For": "203.0.113.4",
      "X-Forwarded-Host": "attacker.invalid",
      "X-Forwarded-Proto": "https",
      "X-Real-IP": "203.0.113.4",
      "X-Device-Id": "forged-owner",
      "X-Unapproved": "private",
    };
    const credential = { provider: "test", credential: { type: "api_key", key: "vault-value" } };
    const response = await proxyBroker(new Request("http://attacker.invalid/v1/credential", {
      method: "POST", headers, body: JSON.stringify(credential),
    }), config(broker), new AbortController().signal);
    expect(response.status).toBe(204);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("x-internal")).toBe(false);
    expect(boundaryFailure).toBeUndefined();
  });

  test("refuses unknown paths and wrong methods before contacting the broker", async () => {
    let hits = 0;
    const broker = upstream(() => {
      hits++;
      return new Response("Should never be reached", { status: 500 });
    });
    const refused = [
      ["GET", "/v1/admin", 404],
      ["GET", "/v1/snapshot/stream/", 404],
      ["POST", "/v1/credential/not-numeric/refresh", 404],
      ["POST", "/v1/credential/1%2f2/block", 404],
      ["POST", "/v1/credential/1/blocks", 405],
      ["DELETE", "/v1/credential/1/refresh", 405],
      ["POST", "/v1/snapshot", 405],
      ["HEAD", "/v1/healthz", 405],
      ["OPTIONS", "/v1/credential", 405],
      ["GET", "/v1/credential", 405],
    ] as const;
    for (const [method, path, status] of refused) {
      await expect(proxyBroker(new Request(`http://sync.invalid${path}`, { method }), config(broker), new AbortController().signal))
        .rejects.toMatchObject({ status });
    }
    expect(hits).toBe(0);
  });


  test("never follows or relays redirects, including redirect credentials and bodies", async () => {
    let destinationHits = 0;
    const destination = upstream(() => {
      destinationHits++;
      return new Response("Compromised");
    });
    const broker = upstream(() => new Response(MASTER_TOKEN, {
      status: 307,
      headers: { Location: `${destination.url}steal?token=${MASTER_TOKEN}` },
    }));
    const operation = proxyBroker(new Request("http://sync.invalid/v1/snapshot"), config(broker), new AbortController().signal);
    await expect(operation).rejects.toMatchObject({ status: 502, code: "broker_unavailable" });
    await expect(operation).rejects.not.toThrow(MASTER_TOKEN);
    expect(destinationHits).toBe(0);
  });

  test("removes compressed wire metadata while preserving decoded response bytes", async () => {
    const text = JSON.stringify({ credentials: ["payload".repeat(100)] });
    const compressed = Bun.gzipSync(text);
    const broker = upstream(() => new Response(compressed, {
      headers: {
        "Content-Type": "application/json", "Content-Encoding": "gzip",
        "Content-Length": String(compressed.byteLength), ETag: '"compressed"',
      },
    }));
    const response = await proxyBroker(new Request("http://sync.invalid/v1/snapshot"), config(broker), new AbortController().signal);
    expect(response.headers.has("content-encoding")).toBe(false);
    expect(response.headers.has("content-length")).toBe(false);
    expect(response.headers.get("etag")).toBe('"compressed"');
    expect(await response.text()).toBe(text);
  });

  for (const source of ["device revocation", "request disconnect"] as const) {
    test(`${source} terminates an already established stream and its upstream connection`, async () => {
      const cancelled = Promise.withResolvers<void>();
      const broker = upstream(() => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("event: snapshot\ndata: {\"generation\":1}\n\n"));
        },
        cancel() {
          cancelled.resolve();
        },
      }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } }));
      const device = new AbortController();
      const client = new AbortController();
      const response = await proxyBroker(new Request("http://sync.invalid/v1/snapshot/stream", {
        signal: client.signal,
      }), config(broker), device.signal);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("event: snapshot");
      const pending = reader.read();
      (source === "device revocation" ? device : client).abort(new Error(MASTER_TOKEN));
      await expect(pending).rejects.toThrow("Auth broker request aborted.");
      await cancelled.promise;
    });
  }

  test("downstream cancellation closes the upstream stream", async () => {
    const cancelled = Promise.withResolvers<void>();
    const broker = upstream(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(": connected\n\n")); },
      cancel() { cancelled.resolve(); },
    }), { headers: { "Content-Type": "text/event-stream" } }));
    const response = await proxyBroker(new Request("http://sync.invalid/v1/snapshot/stream"), config(broker), new AbortController().signal);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await cancelled.promise;
  });

  test("longpoll headers and established SSE survive the normal 15-second header deadline", async () => {
    let events!: ReadableStreamDefaultController<Uint8Array>;
    const broker = upstream(async request => {
      const url = new URL(request.url);
      if (url.pathname === "/v1/snapshot/stream") {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            events = controller;
            controller.enqueue(new TextEncoder().encode(": connected\n\n"));
          },
        }), { headers: { "Content-Type": "text/event-stream" } });
      }
      if (url.searchParams.get("wait") !== "30000") return new Response(null, { status: 400 });
      // Deliberately use the platform clock: this integration checks native
      // fetch/socket header delivery against the proxy's real header deadline.
      await Bun.sleep(16_000);
      return new Response(null, { status: 304, headers: { ETag: '"7"' } });
    });
    const stream = await proxyBroker(new Request("http://sync.invalid/v1/snapshot/stream"), config(broker), new AbortController().signal);
    const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(": connected\n\n");
    const nextEvent = reader.read().then(
      chunk => ({ chunk, error: undefined }),
      error => ({ chunk: undefined, error }),
    );
    const response = await proxyBroker(new Request("http://sync.invalid/v1/snapshot?wait=30000", {
      headers: { "If-None-Match": '"7"' },
    }), config(broker), new AbortController().signal);
    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe('"7"');
    events.enqueue(new TextEncoder().encode("event: entry\ndata: {\"id\":42}\n\n"));
    const next = await nextEvent;
    expect(next.error).toBeUndefined();
    expect(new TextDecoder().decode(next.chunk?.value)).toContain("event: entry");
    await reader.cancel();
  }, 20_000);

  test("unconfigured brokers and connection failures are sanitized", async () => {
    const request = new Request("http://sync.invalid/v1/snapshot");
    await expect(proxyBroker(request, {}, new AbortController().signal))
      .rejects.toMatchObject({ status: 503, code: "broker_unavailable" });
    const broker = upstream(() => Response.json({ ok: true }));
    const unavailable = config(broker);
    await broker.stop(true);
    const operation = proxyBroker(request, unavailable, new AbortController().signal);
    await expect(operation).rejects.toMatchObject({ status: 502, message: "Auth broker request failed." });
    await expect(operation).rejects.not.toThrow(MASTER_TOKEN);
  });
});
