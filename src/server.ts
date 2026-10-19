import type { Server } from "bun";
import { proxyBroker } from "./broker";
import type { Config } from "./config";
import { HttpError } from "./errors";
import { Store, type Device } from "./store";
import { integer, object, parseMutations, text } from "./validation";

const MAX_BODY = 1_048_576;
const encoder = new TextEncoder();
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
async function body(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new HttpError(415, "unsupported_media_type", "Use application/json");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY) throw new HttpError(413, "body_too_large", "Maximum body size is 1 MiB");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new HttpError(400, "invalid_json", "Invalid JSON body"); }
}
function cursorInput(url: URL, request?: Request): { epoch: string; cursor: number } {
  const lastId = request?.headers.get("last-event-id");
  const split = lastId?.lastIndexOf(":") ?? -1;
  const epoch = split > 0 ? lastId!.slice(0, split) : url.searchParams.get("epoch");
  const raw = split > 0 ? lastId!.slice(split + 1) : url.searchParams.get("cursor") ?? "0";
  if (!epoch || !/^\d+$/.test(raw)) throw new HttpError(400, "invalid_cursor", "Supply epoch and non-negative cursor from a snapshot");
  return { epoch, cursor: integer(Number(raw), "cursor") };
}

type Connection = { deviceId: string; abort: AbortController; cleanup: () => void };
type Events = { device: Device; epoch: string; cursor: number; controller: ReadableStreamDefaultController<Uint8Array>; lastSent: number; cleanup: () => void };

export interface SyncServer {
  server: Server<undefined>;
  store: Store;
  stop(): Promise<void>;
}

export function startServer(config: Config, store = new Store(config.dataDir)): SyncServer {
  const connections = new Set<Connection>();
  const events = new Set<Events>();
  const pairingAttempts = new Map<string, { count: number; until: number }>();
  let stopped = false;

  function connect(device: Device, request: Request): Connection {
    if (connections.size >= 256 || [...connections].filter(item => item.deviceId === device.id).length >= 16) throw new HttpError(429, "connection_limit", "Too many open streams");
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    request.signal.addEventListener("abort", onAbort, { once: true });
    const connection: Connection = { deviceId: device.id, abort, cleanup: () => {
      connections.delete(connection);
      request.signal.removeEventListener("abort", onAbort);
    } };
    connections.add(connection);
    if (request.signal.aborted) abort.abort();
    return connection;
  }

  function streamEvents(device: Device, request: Request, url: URL): Response {
    const { epoch, cursor } = cursorInput(url, request);
    store.checkCursor(device.profile, epoch, cursor);
    const connection = connect(device, request);
    let entry: Events | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const cleanup = () => { if (entry) events.delete(entry); connection.cleanup(); };
        entry = { device, epoch, cursor, controller, lastSent: Date.now(), cleanup };
        events.add(entry);
        controller.enqueue(encoder.encode(`event: ready\nid: ${epoch}:${cursor}\ndata: ${JSON.stringify({ epoch, cursor })}\n\n`));
        connection.abort.signal.addEventListener("abort", () => {
          cleanup();
          try { controller.close(); } catch { /* Stream already cancelled by its reader. */ }
        }, { once: true });
        if (connection.abort.signal.aborted) { cleanup(); controller.close(); }
      },
      cancel() { entry?.cleanup(); connection.abort.abort(); },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" } });
  }

  async function broker(device: Device, request: Request): Promise<Response> {
    const connection = connect(device, request);
    try {
      const upstream = await proxyBroker(request, config, connection.abort.signal);
      if (!upstream.body) { connection.cleanup(); return upstream; }
      const reader = upstream.body.getReader();
      const cancel = () => { void reader.cancel().catch(() => {}); connection.cleanup(); };
      connection.abort.signal.addEventListener("abort", cancel, { once: true });
      if (connection.abort.signal.aborted) cancel();
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const result = await reader.read();
            if (result.done) { connection.abort.signal.removeEventListener("abort", cancel); connection.cleanup(); controller.close(); }
            else controller.enqueue(result.value);
          } catch {
            connection.abort.signal.removeEventListener("abort", cancel); connection.cleanup(); controller.error(new Error("Broker connection ended"));
          }
        },
        cancel() { connection.abort.abort(); cancel(); },
      });
      return new Response(stream, { status: upstream.status, headers: upstream.headers });
    } catch (error) { connection.cleanup(); throw error; }
  }

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 60,
    maxRequestBodySize: MAX_BODY,
    async fetch(request, server) {
      try {
        const url = new URL(request.url);
        if (request.headers.has("origin")) throw new HttpError(403, "browser_access_denied", "This API accepts native clients, not browser origins");
        if (url.pathname === "/healthz" && request.method === "GET") return json({ status: "ok", version: "0.1.0" });
        if (url.pathname === "/sync/v1/pair" && request.method === "POST") {
          const peer = server.requestIP(request)?.address ?? "unknown";
          const now = Date.now();
          for (const [key, value] of pairingAttempts) if (value.until <= now) pairingAttempts.delete(key);
          const attempts = pairingAttempts.get(peer) ?? { count: 0, until: now + 60_000 };
          if (attempts.count >= 30 || (!pairingAttempts.has(peer) && pairingAttempts.size >= 10_000)) throw new HttpError(429, "pairing_rate_limit", "Too many pairing attempts; wait one minute");
          attempts.count++; pairingAttempts.set(peer, attempts);
          const input = object(await body(request));
          return json(store.pair(text(input.code, "code")), 201);
        }
        const authorization = request.headers.get("authorization");
        if (!authorization?.startsWith("Bearer ") || authorization.length > 256) throw new HttpError(401, "unauthorized", "A device bearer token is required");
        const device = store.authenticate(authorization.slice(7));
        if (url.pathname.startsWith("/v1/")) {
          server.timeout(request, 0);
          return await broker(device, request);
        }
        switch (`${request.method} ${url.pathname}`) {
          case "GET /sync/v1/snapshot": return json(store.snapshot(device.profile));
          case "POST /sync/v1/mutations": return json(store.mutate(device, parseMutations(await body(request))));
          case "GET /sync/v1/changes": {
            const { epoch, cursor } = cursorInput(url);
            return json(store.changes(device.profile, epoch, cursor));
          }
          case "GET /sync/v1/events":
            server.timeout(request, 0);
            return streamEvents(device, request, url);
          default: throw new HttpError(404, "not_found", "Unknown endpoint or method");
        }
      } catch (error) {
        if (error instanceof HttpError) return json({ error: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) } }, error.status);
        // Do not log request URLs, bodies, tokens, or upstream exception text.
        console.error("Request failed with an internal error");
        return json({ error: { code: "internal_error", message: "Internal server error" } }, 500);
      }
    },
    error() { return json({ error: { code: "request_error", message: "Request could not be processed" } }, 400); },
  });

  const tick = setInterval(() => {
    for (const connection of connections) if (!store.isActive(connection.deviceId)) connection.abort.abort();
    for (const entry of events) {
      try {
        if (entry.epoch !== store.epoch) {
          entry.controller.enqueue(encoder.encode("event: resync\ndata: {}\n\n"));
          entry.cleanup(); entry.controller.close(); continue;
        }
        const cursor = store.cursor(entry.device.profile);
        const changed = cursor > entry.cursor;
        if (!changed && Date.now() - entry.lastSent < 15_000) continue;
        if ((entry.controller.desiredSize ?? 0) <= 0) { entry.cleanup(); entry.controller.close(); continue; }
        const message = changed
          ? `event: changes\nid: ${entry.epoch}:${cursor}\ndata: ${JSON.stringify({ epoch: entry.epoch, cursor })}\n\n`
          : ": keepalive\n\n";
        entry.controller.enqueue(encoder.encode(message));
        entry.cursor = cursor; entry.lastSent = Date.now();
      } catch { entry.cleanup(); try { entry.controller.close(); } catch {} }
    }
  }, 1000);
  tick.unref();

  return {
    server,
    store,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(tick);
      for (const connection of connections) { connection.abort.abort(); connection.cleanup(); }
      await server.stop(true);
      store.close();
    },
  };
}
