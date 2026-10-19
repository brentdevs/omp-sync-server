# OMP sync server

Self-hosted settings/provider sync for oh-my-pi, with SQLite persistence and a device-authenticated front door to OMP's existing auth broker. No GitHub storage or external database.

This repository implements the **server**, not the OMP client extension. The HTTP protocol below is ready for that extension. It does not watch or modify an operator's local OMP configuration.

## Run with Docker Compose

Requirements: Docker Engine and Docker Compose.

```sh
docker compose up --build --wait
docker compose exec sync bun /app/src/main.ts pair --name laptop --profile work
```

The second command prints a single-use pairing code, valid for ten minutes. Exchange it at `POST /sync/v1/pair`. The returned device token is shown only at enrollment; store it securely on the device.

Compose starts two non-root, health-checked services:

- `sync`: this server, published at `127.0.0.1:8787` by default.
- `broker`: upstream OMP **18.12.2**, with its private SQLite vault and background OAuth refresher. No published port.

Named volumes `sync-data`, private `broker-data`, and token-only `broker-token` survive container recreation. Sync mounts only `broker-token` read-only, not the credential vault. `.env.example` documents host/port overrides. Do not run `docker compose down --volumes` unless deliberately discarding both databases and all credentials.

Use a TLS reverse proxy or private VPN before accessing this from another device. Configure the proxy with streaming/unbuffered SSE, a sufficiently long read timeout, and a 1 MiB request-body limit. Do not expose plaintext HTTP on an untrusted network. Browser origins/CORS are intentionally unsupported.

### Upgrading the broker token layout

If upgrading from the original shared-vault mount, keep the same Compose project and existing volumes:

```sh
docker compose stop sync broker
docker compose up -d --build --wait
```

The vault remains at `/data/.omp/agent/agent.db` in `broker-data`. The broker creates its internal bearer at `/tokens/.omp/auth-broker.token` in `broker-token`; sync reads it at `/broker-token/.omp/auth-broker.token`. Existing device tokens remain valid because sync substitutes the new internal bearer. An old `/data/.omp/auth-broker.token` may remain unused in the private vault volume; do not remove the vault or its volume when retiring that legacy token file.

### Broker login and migration

```sh
# Run an upstream interactive login on the broker host.
docker compose exec broker bun /app/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js auth-broker login
```

Browser/loopback callback flows may require SSH forwarding or a temporary, loopback-only callback-port mapping; port 8765 is only the broker API, not a login callback. OMP also supports `auth-broker login <provider> --via=user@host` for a native broker on an SSH-accessible host. See upstream's [broker documentation](https://github.com/can1357/oh-my-pi/blob/9d5d4ac5b50ac2bb5866e4202efc0cf785dfc57a/docs/auth-broker-gateway.md).

Existing credentials can be explicitly migrated from each client using OMP's `auth-broker migrate --from-local` (OAuth requires `--include-oauth`; environment keys require `--include-env`). Configure the client with this server's URL and its enrolled device token first. Do not repeatedly upload stale credential snapshots or keep using copied OAuth refresh tokens independently after migration.

## Run with Nix

```sh
nix develop
bun install --frozen-lockfile
bun run typecheck
bun test

# Or run the immutable packaged server without installing npm dependencies:
nix run . -- serve
nix run . -- pair --name laptop --profile work
nix build .
```

The locked flake provides a package, runnable app and development shell. The native server defaults to `.data/sync.db`, `127.0.0.1:8787`. Set `OMP_SYNC_DATA_DIR` to an absolute persistent directory in a supervised deployment. The package does not install or start the broker for you.

To run the pinned upstream broker natively, install its locked dependencies and start it separately:

```sh
bun install --cwd broker --frozen-lockfile
HOME="$PWD/state/broker" PI_CODING_AGENT_DIR="$PWD/state/broker/.omp/agent" \
  bun broker/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js \
  auth-broker serve --bind=127.0.0.1:8765
```

Then run the sync service with:

```sh
export OMP_SYNC_BROKER_URL=http://127.0.0.1:8765
export OMP_SYNC_BROKER_TOKEN_FILE="$PWD/state/broker/.omp/auth-broker.token"
nix run . -- serve
```

Without a configured broker, settings sync still works; broker routes return `503 broker_unavailable`. Never publish the underlying broker directly.

## Operator commands

All commands accept `--data-dir PATH`; otherwise `OMP_SYNC_DATA_DIR` or `.data` is used. Administrator access is local filesystem access, not a remotely exposed admin API. Only `serve` loads broker/network configuration: local administration works when the broker is stopped, its token file is absent, or serve-only settings are invalid.

```sh
bun src/main.ts pair --name desktop --profile work
bun src/main.ts devices
bun src/main.ts revoke DEVICE_ID
bun src/main.ts backup /secure-backups/sync.db
bun src/main.ts rotate-epoch
```

For a running Compose service, use `docker compose exec sync bun /app/src/main.ts ...` instead. For a stopped service, use `docker compose run --rm --no-deps sync COMMAND...`. Backup destinations must be inside a writable mount (for example `/data/sync-backup.db`); copy backups out with `docker compose cp`.

- Pairings are bound to the operator-selected name/profile. Codes and device tokens are stored as SHA-256 hashes, not plaintext.
- Revocation refuses new authenticated requests immediately. Existing sync and broker streams are cancelled on the next server tick, normally within one second. It cannot revoke upstream credentials already received by a device.
- `backup` uses SQLite's online backup via `VACUUM INTO`, creates a mode-0600 file, and refuses an existing destination. Encrypt exported backups.
- Back up the broker vault separately using a consistent SQLite backup or stop the broker before copying its volume. Do not copy only a live WAL database's main file.
- **After restoring a sync backup**, stop the server, restore the database without stale WAL/SHM files, run `rotate-epoch`, then restart. Epoch rotation invalidates old cursors and mutations so clients must reconcile a fresh snapshot. Ordinary restarts retain the epoch, revisions and retry history. A server cannot automatically detect every rollback of its own database.

### Restore a sync backup under Compose

Use a consistent backup exported to the host, not a main database file copied while WAL writes were active. Stop every process that can open the sync database. Preserve the current database and sidecars separately if you need a rollback copy.

```sh
(
  set -eu
  docker compose stop sync
  docker compose run --rm --no-deps -T --entrypoint sh sync -ec '
    umask 077
    test ! -e /data/sync-restore.db
    cat > /data/sync-restore.db
    test -s /data/sync-restore.db
    rm -f /data/sync.db-wal /data/sync.db-shm
    mv -f /data/sync-restore.db /data/sync.db
    bun /app/src/main.ts rotate-epoch
  ' < /secure-backups/sync.db
  docker compose up -d --wait sync
)
```

Restore and epoch rotation happen in one-off containers before the listener restarts, including when the broker token file is missing. Any failure leaves sync stopped; inspect a leftover `/data/sync-restore.db` before retrying. Do not restart until restore and rotation both succeed.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `OMP_SYNC_DATA_DIR` | `.data` | Persistent database directory |
| `OMP_SYNC_HOST` | `127.0.0.1` | HTTP bind address |
| `OMP_SYNC_PORT` | `8787` | HTTP port |
| `OMP_SYNC_BROKER_URL` | unset | Private HTTP(S) broker origin, without a path/query |
| `OMP_SYNC_BROKER_TOKEN_FILE` | unset | File containing the underlying broker's bearer |
| `OMP_SYNC_BROKER_TOKEN` | unset | Alternative broker bearer; mutually exclusive with token file |

The broker token is loaded at startup. Restart sync after changing it. Upstream broker-token rotation also requires restarting the broker. Compose pins its own internal addresses; host publish overrides are separate `OMP_SYNC_PUBLISH_HOST` / `OMP_SYNC_PUBLISH_PORT` variables.

## Client protocol

All JSON responses use `Cache-Control: no-store`. Except GET `/healthz`, GET `/v1/healthz`, and pairing, requests require `Authorization: Bearer <device-token>`. The scheme is case-insensitive; token bytes are not. Tokens never belong in URLs. Maximum request size is 1 MiB. Application errors have the form `{ "error": { "code": "...", "message": "...", "details": {} } }`; `details` is optional. Bun or a reverse proxy may reject an oversized body directly with HTTP 413 without that JSON envelope.

| Method | Endpoint | Behavior |
| --- | --- | --- |
| GET | `/healthz` | Process liveness, not broker readiness |
| GET | `/v1/healthz` | Public upstream broker health, compatible with `omp auth-broker status`; 503 if unconfigured |
| POST | `/sync/v1/pair` | Exchange `{ "code": "..." }` for `{ device, token }`; 201 |
| GET | `/sync/v1/snapshot` | Consistent `{ epoch, profile, cursor, records }` |
| POST | `/sync/v1/mutations` | Atomic revision-checked transaction |
| GET | `/sync/v1/changes?epoch=E&cursor=N` | Up to 100 ordered changes, next `cursor`, `hasMore` |
| GET | `/sync/v1/events?epoch=E&cursor=N` | SSE change notifications |

A device can access only its enrolled sync profile; request parameters cannot change that scope. Every enrolled device can, however, access the **same broker vault**. Profiles are not credential-isolation boundaries.

### Records and writes

Records have `kind`, `key`, `revision`, `deleted`, `deviceId`, `updatedAt` (Unix milliseconds), and `value` for non-deleted records. Kinds:

- `setting`: one explicit global OMP setting, typically keyed by its registered setting ID.
- `provider`: one `models.yml` provider entry, keyed by provider ID; non-deleted values must be JSON objects.
- `secret`: a separate sensitive configuration value, keyed by a client-defined reference.

Values are JSON, not YAML documents. This server validates the sync envelope, not the complete version-specific OMP schema. Clients must validate settings/provider contents against their OMP version before applying them. Do not publish environment, project, runtime or default layers as global settings. Clients also own device-local exclusions and approval for executable or credential-routing changes.

Record keys, operation IDs, and pairing metadata must be well-formed Unicode strings. Unpaired UTF-16 surrogates are rejected rather than normalized into ambiguous identities. Valid supplementary characters round-trip; JSON values are serialized separately and are not subject to identifier normalization.

Example write (substitute the snapshot's epoch):

```json
{
  "epoch": "snapshot-epoch",
  "operationId": "a-persistent-client-generated-uuid",
  "mutations": [
    {
      "kind": "setting",
      "key": "theme.dark",
      "expectedRevision": 0,
      "value": "titanium"
    }
  ]
}
```

- `expectedRevision: 0` creates an absent record. Updating/deleting requires its current revision.
- Delete with `deleted: true` and **no value**. Tombstones remain, so disconnected clients cannot recreate deleted values with revision zero.
- A batch contains 1–100 distinct record identities and commits entirely or not at all. Arrays/provider entries are atomic values, not CRDTs.
- `409 conflict` returns conflicting keys and revisions, **not values**. Fetch a snapshot and resolve; never silently overwrite newer data.
- Retry an uncertain successful request with the **same operation ID and payload**; its original response is returned without new writes. Reusing the ID with another payload returns `409 operation_reused`.
- `409 resync_required` means the epoch changed or a cursor is invalid. Reconcile a fresh snapshot and rebase queued edits, preserving conflicts, before submitting new operation IDs. Unsent local values alone do not establish that an old server value is safe to overwrite; retain their base values/revisions too.

### Events and reconnects

Use streaming `fetch` so the bearer can be sent in a header. SSE starts with `ready`, emits `changes` with `{ epoch, cursor }`, and sends keepalive comments every 15 seconds. Event IDs are `epoch:cursor`. Reconnect with `Last-Event-ID` or the query parameters. Epoch rotation emits `resync` and closes existing streams.

**Notifications do not contain record values.** Fetch `/changes` from the last **durably applied** cursor, draining pages while `hasMore` is true. Never treat an SSE notification's cursor as an applied-data checkpoint. Save data and its applied cursor together. Slow consumers may be disconnected and must resume; disconnects do not lose durable change history.

Changes are observed on a one-second tick, including commits/revocations by operator commands or another process. Clients should reconnect with backoff and use `/changes` polling when SSE is unavailable. Public pairing is rate-limited to 30 attempts per socket peer/minute; forwarded identity headers are not trusted. Behind one reverse proxy this budget is shared across clients.

If a database error prevents checking revocation, the server closes existing authorized streams instead of leaving them open with unknown authorization state.

### Broker access

Use OMP's existing broker client without modifying its protocol:

```sh
export OMP_AUTH_BROKER_URL=https://sync.example.com
export OMP_AUTH_BROKER_TOKEN=YOUR_DEVICE_TOKEN
```

Known OMP `/v1/*` broker routes, except public GET `/v1/healthz`, are authenticated with the device token and forwarded to the private broker with its master bearer. Streaming snapshots, conditional polling, credential uploads, disable, refresh, block and usage operations are supported. Unknown routes, redirects and caller-supplied forwarded identity/cookies are refused or stripped. Unsupported broker methods return 405 with `Allow`. Broker SSE preserves `X-Accel-Buffering: no`.

Ordinary broker requests have a 15-second response-header deadline; snapshot long polling gets 35 seconds. Aggregate `/v1/usage` waits use the OMP client's account-scaled timeout, caller cancellation, and the upstream broker's own request bound rather than a shorter proxy deadline. After headers, non-SSE responses have a 60-second idle watchdog reset by body progress. Snapshot SSE has no proxy lifetime/body-idle cap and retains caller/device cancellation.

The broker owns OAuth refresh tokens. Snapshots contain usable API keys/access tokens but replace refresh tokens with OMP's remote sentinel. Environment/config API-key overrides still participate in OMP's ordinary precedence; broker mode does not automatically upload them. Expired OAuth access tokens require a reachable broker; settings offline support does not imply independent offline OAuth refresh.

## Security and storage limits

This is a **single-owner trusted-device** service, not multi-tenant authorization. An enrolled device can read/mutate the owner's shared broker credentials. Use separate deployments for separate credential trust domains.

Databases/backups contain plaintext configuration secrets and broker credentials. File permissions and transport authentication do not provide encryption at rest or end-to-end encryption from the server. Use encrypted disks/backups and protect server administration. Secret records use the same authenticated transport/storage as other records; the separate kind is classification, not a second ACL.

The server does not log request URLs, payloads, tokens or upstream error text. Device names/profiles are operator metadata. Conflict errors omit values, but snapshots/change history intentionally expose values to authorized devices. Deletion is not secure erasure: historical values, retry receipts and backups remain. Change/tombstone/idempotency history is retained indefinitely; monitor disk usage and snapshot sizes. There is no automatic destructive pruning.

No client code or shell commands are executed by the sync service. Native clients must still treat synchronized configuration as privileged input. The bundled broker has its own documented credential/login semantics and operational logs.
