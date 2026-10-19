import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface Config {
  dataDir: string;
  host: string;
  port: number;
  brokerUrl?: string;
  brokerToken?: string;
}

export function loadConfig(dataDir?: string): Config {
  const port = Number(process.env.OMP_SYNC_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("OMP_SYNC_PORT must be between 1 and 65535");
  const url = process.env.OMP_SYNC_BROKER_URL;
  const tokenFile = process.env.OMP_SYNC_BROKER_TOKEN_FILE;
  if (tokenFile && process.env.OMP_SYNC_BROKER_TOKEN) throw new Error("Set only one broker token source");
  const token = tokenFile ? readFileSync(tokenFile, "utf8").trim() : process.env.OMP_SYNC_BROKER_TOKEN;
  if (url) {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || !["", "/"].includes(parsed.pathname)) {
      throw new Error("OMP_SYNC_BROKER_URL must be an HTTP(S) origin without credentials, query, or path");
    }
    if (!token?.trim()) throw new Error("A broker URL requires a broker token");
  } else if (token) throw new Error("A broker token requires OMP_SYNC_BROKER_URL");
  return {
    dataDir: resolve(dataDir ?? process.env.OMP_SYNC_DATA_DIR ?? ".data"),
    host: process.env.OMP_SYNC_HOST ?? "127.0.0.1",
    port,
    brokerUrl: url?.replace(/\/$/, ""),
    brokerToken: token?.trim(),
  };
}
