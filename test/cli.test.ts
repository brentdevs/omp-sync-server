import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { object, text } from "../src/validation";

test("local administration works with missing broker secrets and invalid serve-only settings", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "omp-sync-cli-"));
  const store = new Store(dataDir);
  const environment = {
    ...process.env,
    OMP_SYNC_BROKER_URL: "http://127.0.0.1:1",
    OMP_SYNC_BROKER_TOKEN_FILE: join(dataDir, "missing-broker.token"),
    OMP_SYNC_BROKER_TOKEN: "also-conflicting",
    OMP_SYNC_PORT: "not-a-port",
  };
  function command(...args: string[]) {
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/main.ts"), ...args, "--data-dir", dataDir], { env: environment });
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString());
  }
  try {
    const issued = object(command("pair", "--name", "Recovery laptop", "--profile", "work"));
    const paired = store.pair(text(issued.code, "code"));
    expect(command("devices")).toEqual([expect.objectContaining({ id: paired.device.id, revokedAt: null })]);
    command("revoke", paired.device.id);
    expect(store.isActive(paired.device.id)).toBe(false);
    const before = store.epoch;
    command("rotate-epoch");
    expect(store.epoch).not.toBe(before);
    const path = join(dataDir, "backup.db");
    command("backup", path);
    const backup = new Database(path, { readonly: true });
    try {
      expect(backup.query<{ value: string }, []>("SELECT value FROM metadata WHERE key='epoch'").get()!.value).toBe(store.epoch);
      expect(backup.query<{ revoked_at: number | null }, [string]>("SELECT revoked_at FROM devices WHERE id=?").get(paired.device.id)!.revoked_at).not.toBeNull();
    } finally { backup.close(); }
  } finally { store.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
