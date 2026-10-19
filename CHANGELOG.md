# Changelog

## Unreleased

- Reject malformed UTF-16 identifiers before SQLite persistence while preserving valid supplementary characters.
- Separate the broker's token-only volume from its private credential vault and exclude nested secrets/state from Docker contexts.
- Keep local administration independent of broker configuration and document stopped-service Compose restore and epoch rotation.
- Restore public OMP broker health checks, accept case-insensitive bearer schemes, and return `Allow` on broker 405 responses.
- Preserve broker SSE anti-buffering headers, honor aggregate usage request budgets, and cancel stalled non-SSE response bodies.
- Classify oversized-body read failures without internal-error logging; document transport-generated HTTP 413 responses.
- Close authorized streams if revocation checks fail and ensure shutdown errors still release SQLite resources.
- Add HTTP authorization/revocation, Unicode, body-limit, pairing, reconnect, offline-admin, and transport deadline regressions.

## 0.1.0

- Add a persistent Bun/SQLite settings, provider and secret-record sync API.
- Add profile-bound device pairing, hashed tokens and operator-controlled revocation.
- Add atomic revision checks, deletion tombstones, durable change cursors and idempotent mutation receipts.
- Add SSE notifications with reconnect support and active-stream revocation.
- Proxy supported OMP auth-broker routes using a private server-side bearer; pin the Compose broker to OMP 18.12.2.
- Add local device administration, consistent SQLite backups and post-restore epoch rotation.
- Add locked Nix packaging and a non-root, persistent Docker Compose deployment.
