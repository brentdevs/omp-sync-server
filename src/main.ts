import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config";
import { startServer } from "./server";
import { Store } from "./store";

process.umask(0o077);

const help = `omp-sync-server

  serve                         Start the HTTP API (default command)
  pair --name NAME [--profile P] Issue a single-use pairing code, valid 10 minutes
  devices                       List enrolled devices (never tokens)
  revoke DEVICE_ID              Revoke a device; streams close within one second
  backup DESTINATION            Create a consistent SQLite backup; refuses overwrite
  rotate-epoch                  Invalidate cursors after restoring a backup

All commands accept --data-dir PATH (default: OMP_SYNC_DATA_DIR or .data).
Serve: OMP_SYNC_HOST=127.0.0.1, OMP_SYNC_PORT=8787.
Optional broker: OMP_SYNC_BROKER_URL plus OMP_SYNC_BROKER_TOKEN or
OMP_SYNC_BROKER_TOKEN_FILE. Terminate HTTPS at a reverse proxy or use a VPN.
`;

try {
  const args = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      "data-dir": { type: "string" },
      name: { type: "string" },
      profile: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (args.values.help) { console.log(help); }
  else {
    const [command = "serve", ...rest] = args.positionals;
    if (!["serve", "pair", "devices", "revoke", "backup", "rotate-epoch"].includes(command)) throw new Error(`Unknown command: ${command}`);
    if ((["revoke", "backup"].includes(command) ? rest.length !== 1 : rest.length !== 0)) throw new Error("Unexpected arguments; use --help");
    if (command !== "pair" && (args.values.name || args.values.profile)) throw new Error("--name and --profile apply only to pair");
    if (command === "pair" && !args.values.name) throw new Error("pair requires --name NAME");
    if (command === "serve") {
      const config = loadConfig(args.values["data-dir"]);
      const app = startServer(config);
      console.log(`omp-sync-server listening on ${app.server.url.origin}`);
      let shuttingDown = false;
      const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        try { await app.stop(); }
        catch { console.error("Server shutdown failed"); process.exitCode = 1; }
      };
      process.on("SIGINT", () => { void shutdown(); });
      process.on("SIGTERM", () => { void shutdown(); });
    } else {
      const store = new Store(resolve(args.values["data-dir"] ?? process.env.OMP_SYNC_DATA_DIR ?? ".data"));
      try {
        switch (command) {
          case "pair": console.log(JSON.stringify(store.issuePairing(args.values.name!, args.values.profile ?? "default"), null, 2)); break;
          case "devices": console.log(JSON.stringify(store.devices(), null, 2)); break;
          case "revoke": store.revoke(rest[0]!); console.log(JSON.stringify({ revoked: rest[0] })); break;
          case "backup": store.backup(rest[0]!); console.log(JSON.stringify({ backup: rest[0] })); break;
          case "rotate-epoch": console.log(JSON.stringify({ epoch: store.rotateEpoch() })); break;
        }
      } finally { store.close(); }
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Command failed");
  process.exitCode = 1;
}
