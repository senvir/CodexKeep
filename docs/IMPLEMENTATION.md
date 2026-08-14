# CodexKeep implementation plan

## Milestone 1: executable foundation

- Publishable Node.js 22 ESM package with the `codexkeep` binary.
- Small command router and Clack-based interactive menu.
- Shared paths, process execution, Git, Codex CLI, TOML, inventory, link, and output services.

## Milestone 2: safe local ownership

- Create or clone `~/.codexkeep` through a temporary directory.
- Discover supported official paths, including content exposed through symlinks.
- Store plugin and marketplace inventory as validated `plugins.json`.
- Extract only portable configuration into the `codexkeep` profile.
- Reconcile that portable allowlist into the base Codex config because current
  Codex releases do not support a persistent default-profile selector.
- Preflight all official paths, confirm once, back up adopted content, and create symlinks with rollback.

## Milestone 3: explicit synchronization

- Discover third-party marketplaces, plugins, and account plugin names.
- Probe, show, add, or replace an empty private Git remote through
  `codexkeep remote` without requiring raw Git commands.
- Let `codexkeep init <git-url>` publish to an empty remote or safely join a
  populated valid CodexKeep repository.
- Fetch and compare the configured Git remote only after `codexkeep sync`.
- Reconcile marketplace and plugin additions or deletions from their common Git
  base, apply the confirmed local operations, commit, rebase, and push.
- Keep local commits when the remote is offline and preserve both sides when Git reports a conflict.

## Milestone 4: update and diagnostics

- Upgrade sourced global skills and Git marketplaces before running the shared sync flow.
- Provide a read-only `check` command with actionable status and opt-in technical evidence.
- Keep interactive spinners out of redirected or test output.

## Verification

- Unit tests for normalized plugin inventory and portable TOML filtering.
- Filesystem tests for complete link preflight, idempotency, and rollback.
- CLI smoke tests for empty, populated, invalid, unreachable, and replaced
  remotes using an isolated HOME and fake Codex executable.
- Package smoke test against the packed npm tarball.
