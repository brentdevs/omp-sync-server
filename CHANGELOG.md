# Changelog

## 0.1.0

- Add a persistent Bun/SQLite settings, provider and secret-record sync API.
- Add profile-bound device pairing, hashed tokens and operator-controlled revocation.
- Add atomic revision checks, deletion tombstones, durable change cursors and idempotent mutation receipts.
- Add SSE notifications with reconnect support and active-stream revocation.
- Proxy supported OMP auth-broker routes using a private server-side bearer; pin the Compose broker to OMP 18.12.2.
- Add local device administration, consistent SQLite backups and post-restore epoch rotation.
- Add locked Nix packaging and a non-root, persistent Docker Compose deployment.
