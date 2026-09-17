# Contributing

Thanks for considering a contribution to `n8n-nodes-ftp-trigger-owen`!

## Development setup

Requirements: **Node.js >= 20.19** (see `.nvmrc`) and npm.

```bash
git clone https://github.com/77owen/n8n-nodes-ftp-trigger.git
cd n8n-nodes-ftp-trigger
npm install
npm run build       # tsc + gulp icons -> dist/
npm run dev         # tsc --watch
```

## Scripts

| Script                 | What it does                                                        |
| ---------------------- | ------------------------------------------------------------------- |
| `npm run build`        | Compile TypeScript and copy icons into `dist/`                       |
| `npm run lint`         | ESLint incl. the n8n node-linter rules (`nodes/` + `package.json`)   |
| `npm run lintfix`      | ESLint with `--fix`                                                  |
| `npm run format`       | Prettier on `nodes/`                                                 |
| `npm test`             | Unit tests (vitest)                                                  |
| `npm run test:watch`   | Unit tests in watch mode                                             |
| `npm run test:integration` | Unit **and** integration tests against real local FTP/SFTP servers |

The integration tests need `TZ=UTC`: `ftp-srv` prints local-time LIST dates while
`promise-ftp` parses them as UTC, so on a non-UTC machine the parsed mtimes are
shifted and the stability-window checks fail. Always run with `TZ=UTC` locally.

### Tests

- **Unit tests** (`tests/lib.test.ts`) cover the pure logic in
  `nodes/FtpTrigger/lib.ts`: key normalization, path handling, connect options,
  the file-map diff engine (created/updated/deleted events), the stability
  window and the state cap. They run in milliseconds and need no network.
- **Integration tests** (`tests/integration/`) exercise the full `poll()` flow
  against a real local FTP server (`ftp-srv`) and an in-process SFTP server
  (`ssh2`). They require a prior `npm run build` and are gated behind the
  `RUN_INTEGRATION=1` environment variable so plain `npm test` stays fast:

  ```bash
  npm run build
  TZ=UTC RUN_INTEGRATION=1 npm test
  ```

CI (`.github/workflows/ci.yml`) runs lint, build, unit tests, integration tests
and the n8n prepublish lint on Node 20 and 22 for every push and pull request.

## Architecture notes

- `nodes/FtpTrigger/FtpTrigger.node.ts` — node definition, credentials wiring,
  credential tests, the resource-locator search and the `poll()` orchestration.
- `nodes/FtpTrigger/lib.ts` — pure, unit-testable helpers: connect options,
  listing normalization, the diff engine (`selectEventFiles`), state capping,
  download/stream helpers. Keep business logic here so it stays testable.
- Workflow state (`getWorkflowStaticData('node')`) tracks `watchedPath` and a
  `fileMap` of `{ mtime, size, type, pending?, isNew? }` per path. The map is
  capped (`MAX_TRACKED_ENTRIES`) and reset when the watched path changes.

## Releasing

1. Update `CHANGELOG.md` (add a new version section).
2. Bump `version` in `package.json` and run `npm install` to refresh the lockfile.
3. Verify locally:
   ```bash
   npm run lint && npm run build && RUN_INTEGRATION=1 npm test
   npm pack --dry-run
   ```
4. Commit, tag and push:
   ```bash
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```
5. The [release workflow](.github/workflows/release.yml) publishes to npm with
   provenance and creates a GitHub release. It requires the `NPM_TOKEN` secret
   in the repository settings (an npm automation token with access to the
   package) and the `npm` environment configured for protection rules.
6. Submit/update the package in the [n8n community nodes directory]
   (https://docs.n8n.io/integrations/community-nodes/) if applicable — the
   `n8n-community-node-package` keyword in `package.json` is already set.

## Submitting changes

- Keep PRs focused; run `npm run lintfix` and the test suite before opening one.
- New options should live in the existing `options` collections and follow the
  n8n UX guidelines (the node-linter in `npm run lint` will tell you).
- Update `README.md` and `CHANGELOG.md` for user-visible changes.
