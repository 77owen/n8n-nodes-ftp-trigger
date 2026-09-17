# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-09-16

### Added

- **Include File Content** option: optionally download each emitted file and attach
  it as binary data (property `data`) on the item, so the trigger can feed file
  contents directly into downstream nodes. Not available for folder events or
  file deletions.
- **Ignore Files Modified Within Last** option (stability window): defer triggering
  for files modified within the last N seconds so files that are still being
  uploaded are not picked up too early. Deferred events are emitted automatically
  on a later poll once the file has been stable. The window is bypassed during
  manual test runs ("Fetch Test Event").
- Unit test suite (vitest, 38 tests) covering key normalization, path handling,
  connect options and the full diff engine.
- Integration test harness (41 checks) running against a real local FTP server
  (`ftp-srv`) and an in-process SFTP server (`ssh2`). Runs via
  `RUN_INTEGRATION=1 npm test` and in CI.
- GitHub Actions CI (lint + build + unit/integration tests on Node 20 and 22)
  and a release workflow that publishes to npm with provenance when a `v*` tag
  is pushed.
- Dependabot configuration for npm and GitHub Actions.

### Changed

- Package renamed to `n8n-nodes-ftp-trigger-owen` and republished as a
  community fork — the original `n8n-nodes-ftp-trigger` npm name is held by the
  upstream author. Repository/homepage URLs now point to
  `77owen/n8n-nodes-ftp-trigger`.
- File modification detection now also compares the file **size** in addition to
  `mtime`, catching updates within the same second (FTP `LIST` timestamps have
  minute/second granularity depending on the server).
- FTP/SFTP connections now use explicit timeouts (`connTimeout`/`pasvTimeout`/
  `keepalive` for FTP, `readyTimeout`/`keepaliveInterval` for SFTP) so a
  half-dead server cannot hang a poll indefinitely.
- MIME type of included files is detected via `mime-types` (new runtime
  dependency); unknown extensions fall back to `application/octet-stream`.
- Per-poll download errors are reported in the item's `downloadError` field
  instead of failing the whole execution.

### Fixed

- Delete detection used a loose `startsWith(watchedPath)` prefix check that could
  match sibling folders such as `/data-backup` when watching `/data`; it now uses
  a strict directory-containment check.
- The tracked-state file map is capped at 10,000 entries (oldest pruned first) so
  very large folders cannot grow the workflow static data without bound.
- Removed dead `lastTimeChecked` state that was written on every poll but never read.

## [1.1.0] - 2026-09-16

### Added

- Compatibility with current n8n versions (verified against `n8n-workflow` 2.16 /
  n8n 2.x).
- SFTP **private key authentication**, including single-line `\n`-escaped keys
  pasted into n8n ([issue #1]).
- **Changes to a Specific File** trigger mode with a searchable file picker
  (`methods.listSearch`) and mtime-based `File Updated` detection.
- `Watch Folder Updated` event now actually fires (it previously could never
  trigger) by tracking the watched folder itself.
- Credential health checks (`methods.credentialTest`) for both FTP and SFTP.
- First poll after activation only records state, preventing a flood of false
  `fileCreated` events for pre-existing files. Manual test runs still return data.
- Tracked state resets when the watched path changes.
- Filename glob filter (e.g. `HR_Feed*.csv`) via [PR #5] (`picomatch`).
- Connections are always closed, including on listing errors (previously leaked).

### Changed

- Removed the undeclared `moment` dependency (used only accidentally through
  n8n's own `NODE_PATH` injection); native `Date` is used instead.
- Modernized toolchain: TypeScript 5.9, `eslint-plugin-n8n-nodes-base` 2.0,
  `ssh2-sftp-client` 12, Node 22 (`.nvmrc`).
- Icon now uses `file:ftpTrigger.svg` + `iconColor` (replacing the deprecated
  `fa:` icon and `defaults.color`).
- Fixed the broken `prepublishOnly` script.

### Removed

- Dead `tslint.json`.

## [1.0.1] - 2023-07-25

### Initial public release

- FTP/SFTP polling trigger with created/deleted/updated events for files and
  folders.

[issue #1]: https://github.com/drudge/n8n-nodes-ftp-trigger/issues/1
[PR #5]: https://github.com/drudge/n8n-nodes-ftp-trigger/pull/5
