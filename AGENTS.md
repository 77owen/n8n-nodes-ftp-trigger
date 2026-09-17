# AGENTS.md

Guidance for AI agents working in this repository.

## What this is

An n8n **community node package** (`n8n-nodes-ftp-trigger-owen`, a renamed fork
of `drudge/n8n-nodes-ftp-trigger`): a single polling
trigger node that starts n8n workflows on FTP/SFTP filesystem changes
(file/folder created, updated, deleted; watch-folder modified). TypeScript,
compiled to CommonJS into `dist/`. n8n loads the compiled node from the `n8n`
field in `package.json` (`dist/nodes/FtpTrigger/FtpTrigger.node.js`); the
published npm tarball contains only `dist/` (`files` field). `index.js` at the
repo root is an empty placeholder for `main` — the real entry point is the
`n8n` field, not `main`.

## Commands

```bash
npm ci                       # install (see gotcha below if it fails)
npm run build                # tsc + gulp copies icons -> dist/  (required before integration tests)
npm run dev                  # tsc --watch
npm run lint                 # ESLint incl. n8n node-linter rules on nodes/ + package.json
npm run lintfix
npm run format               # Prettier on nodes/ ONLY (tests are not covered)
npm test                     # vitest unit tests (fast, no network)
RUN_INTEGRATION=1 npm test   # unit + integration tests (requires npm run build first)
node tests/integration/harness.cjs   # integration harness standalone (needs dist/ built)
npm pack --dry-run           # verify package contents
```

CI (`.github/workflows/ci.yml`) runs lint, build, unit tests,
`RUN_INTEGRATION=1 npm test`, and the prepublish lint on Node 22 only
(current upstream `n8n-core` dev dependencies, e.g. `isolated-vm`, no longer
install on Node 20; the compiled node itself still declares `engines` >=20.19).
`.nvmrc` pins Node 22.

### Release process

Tag-driven, never publish manually: update `CHANGELOG.md`, bump `version` in
`package.json`, run `npm install` (refresh lockfile), verify with
`npm run lint && npm run build && RUN_INTEGRATION=1 npm test && npm pack --dry-run`,
commit, then `git tag vX.Y.Z && git push origin main vX.Y.Z`. The release
workflow publishes to npm with provenance and creates the GitHub release.

## Architecture

Deliberately two files under `nodes/FtpTrigger/`:

- **`FtpTrigger.node.ts`** — everything n8n-facing: the `INodeTypeDescription`
  (parameters, `displayOptions` show/hide wiring, credentials `ftp`/`sftp`),
  credential connection tests (`methods.credentialTest`), the file picker
  (`methods.listSearch.fileSearch`), and `poll()` orchestration (connect,
  list/stat, filter, emit, optional binary download, always disconnect in
  `finally`).
- **`lib.ts`** — pure, unit-testable logic with no n8n runtime dependency:
  connect options, listing normalization, path helpers, and the diff engine
  `selectEventFiles`. **Keep business logic here** so it stays testable;
  `poll()` should stay a thin orchestrator.

### Control/data flow of a poll

1. n8n calls `poll()` on the trigger interval. Read params and credentials.
2. State lives in `getWorkflowStaticData('node')` (persisted by n8n): a
   `watchedPath` and a `fileMap` of `path -> { mtime, size, type, pending?, isNew? }`.
   Changing the watched path resets the map. The map is capped at
   `MAX_TRACKED_ENTRIES` (10 000, oldest mtime pruned first) so static data
   stored in n8n's DB cannot grow unbounded.
3. Folder events do a directory listing (`normalizeFtpItem` /
   `normalizeSftpItem` unify the two client libs into `ReturnFtpItem`);
   `specificFile` mode and `watchFolderUpdated` track a single path via
   `statWatchedPath` instead (FTP has no stat, so it looks the entry up in the
   parent listing).
4. `selectEventFiles()` (pure) diffs `previousMap` vs the current listing and
   returns `{ emit, nextMap }`. Updates are detected by **mtime AND size**
   (FTP `LIST` timestamps have coarse granularity; size catches same-second
   writes). Delete detection uses `isWithinWatchDir`, a strict
   directory-containment check — a plain `startsWith` prefix match was a real
   bug (`/data` matched `/data-backup/...`); there are regression tests.
5. First poll after activation records the baseline and emits nothing
   (prevents a flood of false `fileCreated`). Manual mode skips the baseline.
6. Optional extras: glob filter (`picomatch`, applies to files only, not
   folders), stability window, `includeFileContent` (download → binary
   property `data`; failures are reported per-item in `downloadError`, not by
   failing the execution).
7. Return `[[items]]` when events fired, `null` otherwise.

### Manual mode ("Fetch Test Event") semantics

`this.getMode() === 'manual'` changes behavior in two places: the first-run
baseline is skipped so the current listing is returned as test data, and the
stability window is bypassed (otherwise a just-uploaded file could never be
fetched). When nothing matches in manual mode, `poll()` throws a
`NodeApiError` ("No data with the current filter could be found") — that is
intentional n8n UX, don't "fix" it.

### Cross-protocol gotchas (lib.ts)

- Connections always get explicit timeouts (`CONNECT_TIMEOUT_MS` /
  `KEEPALIVE_INTERVAL_MS`) and are always closed in `finally` — polls run
  forever, a leaked connection or hang compounds.
- SFTP: if a `privateKey` is present it is used (password kept as fallback);
  for password-only auth the key field must be omitted entirely, otherwise
  ssh2 tries to parse an empty string. `formatPrivateKey` expands keys pasted
  as single-line strings with literal `\n` sequences.
- Stream chunks from both client libs arrive as Buffers, numbers, Uint8Arrays
  or strings — `streamToBuffer` handles all of them.

## Testing

- **Unit** (`tests/lib.test.ts`): covers `lib.ts` only — key normalization,
  path helpers, connect options, the full diff engine (all events), stability
  window, state cap. Milliseconds fast, no network. Prefer extending these for
  logic changes; build fixtures with the local `file(path, mtime, size, type)`
  helper.
- **Integration** (`tests/integration/`): `harness.cjs` is a standalone CJS
  script (~41 `check()` assertions) that starts a real `ftp-srv` server (port
  2121, root `/tmp/ftp-root`) and an in-process `ssh2` SFTP server (port 2222,
  root `/tmp/sftp-root`), drives `FtpTrigger.poll()` through a mock context
  (`makeContext` mirrors `IPollFunctions`), and exits non-zero on any failed
  check. The vitest wrapper `run.test.ts` just spawns it and asserts exit code
  0 (dumping stdout/stderr on failure), and is skipped unless
  `RUN_INTEGRATION=1`. **It imports the compiled `dist/`, so `npm run build`
  must run before it** — stale `dist/` gives stale test results.

## Conventions

- n8n node idioms: parameter visibility via `displayOptions.show/hide`, new
  user options go into the existing `options` collections (one per
  `triggerOn` value) rather than new top-level params, credentials referenced
  by name `'ftp'`/`'sftp'`, resource locators for file/folder picking. The
  n8n node-linter (`npm run lint`) enforces UX guidelines — run it, and use
  `nodelinter-ignore-next-line` comments where already present rather than
  restructuring.
- Prettier config says tabs (`useTabs: true`), but the repo is inconsistent:
  `FtpTrigger.node.ts` uses tabs while `lib.ts` and `tests/lib.test.ts` are
  indented with spaces. **Match the file you are editing.** Note that
  `npm run format` would convert `lib.ts` to tabs, and it doesn't touch
  `tests/` at all.
- `n8n-workflow` and `n8n-core` are devDependencies pinned to `*` — types come
  from whatever n8n publishes; builds can break when n8n changes types.
- User-visible changes require updates to `README.md` and `CHANGELOG.md`
  (Keep a Changelog format, semver).

## Gotchas

- On macOS (observed on this machine), plain `npm ci` can fail building a
  native dependency pulled in via `n8n-core` (node-gyp/`make` error).
  Workaround: `npm ci --ignore-scripts && npm rebuild esbuild`, then
  `npm test`.
- Integration tests bind fixed ports 2121/2222 and write to `/tmp/ftp-root`
  and `/tmp/sftp-root` by default; override with `FTP_PORT`, `SFTP_PORT`,
  `FTP_ROOT`, `SFTP_ROOT` (CI and the release workflow set distinct values so
  parallel runs cannot collide). They also require `TZ=UTC`: `ftp-srv` prints
  local-time LIST dates while `promise-ftp` parses them as UTC, so on a
  non-UTC machine parsed mtimes are shifted and the stability-window checks
  fail (files appear "in the future" and never settle).
- `useUnknownInCatchVariables` is disabled in tsconfig (catch is `unknown` by
  default rules otherwise); use the `getErrorMessage()` helper instead of
  casting.
- The `prepublishOnly` script runs a second ESLint config
  (`.eslintrc.prepublish.js`) that re-enables the
  `community-package-json-name-still-default` rule as an error — don't rename
  the package to a `n8n-nodes-` default-style name.
