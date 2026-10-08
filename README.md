<p align="center">
  <img src="apps/dashboard/public/patchkite-logo.svg" alt="Patchkite" height="56">
</p>

<p align="center">Self-hosted over-the-air updates for React Native and Flutter.</p>

<p align="center">
  <a href="https://docs.patchkite.com/">Documentation</a> ·
  <a href="https://github.com/patchkite/cli">CLI</a> ·
  <a href="https://github.com/patchkite/react-native">React Native SDK</a> ·
  <a href="https://github.com/patchkite/flutter">Flutter SDK</a>
</p>

---

Patchkite lets you ship JavaScript and Dart fixes to installed apps without a store release, from a server you run yourself. This repository contains the **server** and the **web dashboard**.

- Staging and Production deployments, staged rollouts, mandatory updates, promote, and rollback
- Diff updates and bsdiff binary patches, so small changes mean downloads of a few kilobytes
- Automatic rollback when an update crashes before `notifyAppReady()`
- Code signing with RSA keys, verified on the device
- Install metrics per release, collaborators, access keys for CI, and admin-managed accounts

## Quick start

```bash
git clone https://github.com/patchkite/patchkite.git
cd patchkite/docker
docker compose --profile full up -d --build
```

This runs PostgreSQL, RustFS (S3-compatible storage), and the server at `http://localhost:3000`, with the dashboard at `/web/`. Then install the CLI and create the first (admin) account:

```bash
npm install -g @patchkite/cli
patchkite register http://localhost:3000
```

Continue with the [quickstart](https://docs.patchkite.com/start/quickstart/). For a production setup with HTTPS and S3/R2, see [Deploy to production](https://docs.patchkite.com/self-hosting/production/). The server image is published as `ghcr.io/patchkite/server`.

## Repository layout

| Path | Description |
|---|---|
| [`apps/server`](apps/server) | Fastify API, PostgreSQL (Drizzle), S3-compatible storage |
| [`apps/dashboard`](apps/dashboard) | React + Vite dashboard, served by the server at `/web/` |
| [`packages/shared`](packages/shared) | Types, package hash, semver, and bsdiff shared by the server and dashboard |
| [`fixtures`](fixtures) | Reference test data (package hash, signatures, zips, bsdiff) for the CLI and SDKs |
| [`docker`](docker) | Dockerfile and Compose files for local, single-host, and production setups |

## Development

Requires Node.js 24, pnpm, and Docker.

```bash
pnpm install
docker compose -f docker/docker-compose.yml up -d postgres s3
pnpm --filter @patchkite/server dev        # API on :3000
pnpm --filter @patchkite/dashboard dev     # dashboard on :5173/web/
pnpm turbo run typecheck test build        # server tests use in-memory PGlite
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## License

[MIT](LICENSE)
