import { HttpError } from "./errors";

const REQUEST_HEADERS = ["Content-Type", "If-None-Match", "OMP-Auth-Broker-Capabilities", "Accept"];
const RESPONSE_HEADERS = ["ETag", "Vary", "Content-Type", "Cache-Control"];
const GET = ["GET"];
const POST = ["POST"];
const DELETE = ["DELETE"];
const POST_DELETE = ["POST", "DELETE"];
const STATIC_ROUTES: Record<string, readonly string[]> = {
  "/v1/healthz": GET,
  "/v1/snapshot": GET,
  "/v1/snapshot/stream": GET,
  "/v1/credentials/disabled": GET,
  "/v1/usage": GET,
  "/v1/usage/history": GET,
  "/v1/usage/clients": GET,
  "/v1/credential": POST,
  "/v1/usage/observed": POST,
  "/v1/usage/stale": POST,
};

// OMP 18.12.2 uses decimal SQLite credential IDs for all dynamic routes.
const CREDENTIAL_ROUTE = /^\/v1\/credential\/\d+\/(refresh|disable|block|blocks)$/;

function routeMethods(pathname: string): readonly string[] | undefined {
  if (Object.hasOwn(STATIC_ROUTES, pathname)) return STATIC_ROUTES[pathname];
  const operation = CREDENTIAL_ROUTE.exec(pathname)?.[1];
  if (operation === "block") return POST_DELETE;
  if (operation === "blocks") return DELETE;
  if (operation === "refresh" || operation === "disable") return POST;
}

function selectedHeaders(source: Headers, names: readonly string[]): Headers {
  const headers = new Headers();
  const connectionHeaders = new Set(source.get("connection")?.toLowerCase().split(",").map(name => name.trim()));
  for (const name of names) {
    const value = source.get(name);
    if (value !== null && !connectionHeaders.has(name.toLowerCase())) headers.set(name, value);
  }
  return headers;
}

/** Authenticated-device access to the owner's shared OMP broker credential pool. */
export async function proxyBroker(
  request: Request,
  config: { brokerUrl?: string; brokerToken?: string },
  signal: AbortSignal,
): Promise<Response> {
  if (!config.brokerUrl || !config.brokerToken) {
    throw new HttpError(503, "broker_unavailable", "Auth broker is not configured.");
  }
  const incoming = new URL(request.url);
  const methods = routeMethods(incoming.pathname);
  if (!methods) throw new HttpError(404, "not_found", "Unknown auth broker route.");
  if (!methods.includes(request.method)) {
    throw new HttpError(405, "method_not_allowed", "Method is not supported for this auth broker route.");
  }

  let upstreamUrl: URL;
  const headers = selectedHeaders(request.headers, REQUEST_HEADERS);
  try {
    const configured = new URL(config.brokerUrl);
    if (!["http:", "https:"].includes(configured.protocol) || configured.username || configured.password) {
      throw new Error("Invalid broker origin");
    }
    upstreamUrl = new URL(incoming.pathname + incoming.search, configured.origin);
    headers.set("Authorization", `Bearer ${config.brokerToken}`);
  } catch {
    throw new HttpError(503, "broker_unavailable", "Auth broker configuration is invalid.");
  }

  // Keep both abort sources attached through the entire response, not just headers.
  const upstreamAbort = new AbortController();
  const abort = () => upstreamAbort.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted || signal.aborted) abort();
  const cleanup = () => {
    request.signal.removeEventListener("abort", abort);
    signal.removeEventListener("abort", abort);
  };
  // Snapshot longpoll may intentionally withhold headers for up to 30 seconds.
  const headerTimer = setTimeout(abort, incoming.pathname === "/v1/snapshot" ? 35_000 : 15_000);
  headerTimer.unref();
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: request.method === "GET" ? undefined : request.body,
      redirect: "manual",
      signal: upstreamAbort.signal,
    });
  } catch {
    cleanup();
    throw new HttpError(502, "broker_unavailable", "Auth broker request failed.");
  } finally {
    clearTimeout(headerTimer);
  }

  // 304 is a cache validator response, not a redirect. Never expose Location or
  // a redirect body (which could contain broker credentials) to the device.
  if (upstream.status >= 300 && upstream.status < 400 && upstream.status !== 304) {
    cleanup();
    upstreamAbort.abort();
    void upstream.body?.cancel().catch(() => {});
    throw new HttpError(502, "broker_unavailable", "Auth broker returned an unsupported redirect.");
  }
  // fetch transparently decompresses. Never copy Content-Encoding or the wire
  // Content-Length onto that decoded body, nor cookies or hop-by-hop headers.
  const responseHeaders = selectedHeaders(upstream.headers, RESPONSE_HEADERS);
  if (!upstream.body) {
    cleanup();
    return new Response(null, { status: upstream.status, headers: responseHeaders });
  }

  const reader = upstream.body.getReader();
  let finished = false;
  let downstream: ReadableStreamDefaultController<Uint8Array>;
  const finish = () => {
    finished = true;
    upstreamAbort.signal.removeEventListener("abort", onAbort);
    cleanup();
  };
  const onAbort = () => {
    if (finished) return;
    finish();
    downstream.error(new DOMException("Auth broker request aborted.", "AbortError"));
    void reader.cancel().catch(() => {});
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      downstream = controller;
      upstreamAbort.signal.addEventListener("abort", onAbort, { once: true });
      if (upstreamAbort.signal.aborted) onAbort();
    },
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (finished) return;
        if (chunk.done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch {
        if (finished) return;
        finish();
        controller.error(new Error("Auth broker response interrupted."));
      }
    },
    cancel() {
      finish();
      upstreamAbort.abort();
      return reader.cancel().catch(() => {});
    },
  }, { highWaterMark: 0 });
  return new Response(body, { status: upstream.status, headers: responseHeaders });
}
