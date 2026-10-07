# Contributing to Patchkite

Thanks for helping! This repository holds the server and dashboard. The CLI and SDKs live in their own repositories: [cli](https://github.com/patchkite/cli), [react-native](https://github.com/patchkite/react-native), and [flutter](https://github.com/patchkite/flutter).

## Getting started

```bash
pnpm install
docker compose -f docker/docker-compose.yml up -d postgres s3
pnpm --filter @patchkite/server dev
pnpm --filter @patchkite/dashboard dev
```

Before opening a pull request, make sure this passes:

```bash
pnpm turbo run typecheck test build
```

## Guidelines

- Open an issue first for larger changes, so we can agree on the approach.
- Keep pull requests focused, and add tests for behavior changes.
- Match the style of the surrounding code.
- Database changes need a Drizzle migration in `apps/server/drizzle`. Prefer additive migrations: existing servers upgrade in place and may roll back.

## Protocol changes

The package hash, signature, diff, and bsdiff formats are shared with the CLI and SDKs and are specified in the [package format reference](https://patchkite.github.io/docs/reference/package-format/). If you change them:

1. Update `packages/shared` and the specification.
2. Regenerate the fixtures with `pnpm fixtures` and commit them.
3. After the release, the CLI and SDK repositories pick up the new `fixtures-vX.Y.Z.tar.gz` release asset and must pass against it.

## Releases

Maintainers tag `vX.Y.Z` on `main`. CI publishes `ghcr.io/patchkite/server` and attaches the fixtures archive to the GitHub release. Add an entry to [CHANGELOG.md](CHANGELOG.md) first.
