<p align="center">
  <a href="safety-and-recovery.md">简体中文</a>
  ·
  <strong>English</strong>
</p>

# CodexKeep safety and recovery

CodexKeep synchronizes only explicitly supported personal Codex configuration.
It never copies the whole `~/.codex` directory into Git, and automatic
confirmation never bypasses conflict handling or safety checks.

Start with the [project README](../README.en.md) if this is your first setup.
See the [command guide](commands.en.md) for command-specific behavior.

## Safety boundary

| Synchronized | Always local |
| --- | --- |
| Personal skills under `~/.agents/skills` | Authentication, tokens, connector credentials, MCP headers |
| Skill source records in `.skill-lock.json` | Sessions, history, logs, SQLite databases, caches, desktop state |
| Global `~/.codex/AGENTS.md` | Project trust and machine-specific absolute paths |
| Custom agents under `~/.codex/agents` | Codex built-in skills, plugin bundles, cache snapshots |
| Allowlisted portable preferences | Project-level instructions, skills, configuration |
| Validated third-party marketplace and plugin inventory | Account-plugin credentials and sign-in state |

Even without credentials, the repository contains personal instructions,
skills, agents, and preferences. Use a private repository for cross-device
synchronization.

## Portable preference allowlist

CodexKeep currently allows these top-level scalar settings:

- `model`
- `model_reasoning_effort`
- `approval_policy`
- `approvals_reviewer`
- `sandbox_mode`

It can also synchronize:

- boolean values under `features` whose keys do not look secret;
- sanitized entries under `skills.config`;
- custom agents that use safe relative `config_file` paths.

The following content is excluded:

- keys containing token, secret, password, credential, authorization, API key,
  header, or env;
- absolute paths and paths beginning with `~`;
- custom-agent paths that traverse to a parent directory;
- machine-specific sections outside the allowlist.

## Data directory and symlinks

Portable content lives in the user's own Git repository:

```text
~/.codexkeep/
├── skills/
├── skill-lock.json
├── plugins.json
└── codex/
    ├── AGENTS.md
    ├── codexkeep.config.toml
    └── agents/
```

Five supported official paths point to that content:

```text
~/.agents/skills                    → ~/.codexkeep/skills
~/.agents/.skill-lock.json          → ~/.codexkeep/skill-lock.json
~/.codex/AGENTS.md                  → ~/.codexkeep/codex/AGENTS.md
~/.codex/agents                     → ~/.codexkeep/codex/agents
~/.codex/codexkeep.config.toml      → ~/.codexkeep/codex/codexkeep.config.toml
```

CodexKeep never takes over `~/.codex/skills`; Codex built-ins remain where
Codex installed them.

Current Codex versions load a named profile only when
`--profile codexkeep` is supplied and cannot persist a default profile. To make
portable preferences work directly in the Codex app, CLI, and IDE, CodexKeep
merges the portable allowlist into the real `~/.codex/config.toml`. Unmanaged
sections remain intact, and the original content is backed up before every
actual change.

## What happens before managed content changes

### Initialization

`codexkeep init` creates or clones the repository in a temporary directory,
discovers local configuration, validates the complete structure, and then
shows one plan. An unreachable, invalid, or non-CodexKeep remote causes no
official-path changes.

### Synchronization

`codexkeep sync` validates the repository, all five links, Git state, plugin
inventory, and portable preferences first. When a remote exists, it fetches to
compare additions and deletions from the common Git base, then renders a plan
with green `+` and red `-` markers. Plugin installation or removal,
configuration writes, commits, and push happen only after the plan is
accepted. An ambiguous locally missing plugin always requires an explicit
restore-or-delete choice.

### Link recovery

`codexkeep link` checks every link first. If any target already contains
different content, it creates no links and directs the user to `init` for a
safe merge. A failure during creation rolls back links created by that run.

## Backups and state

Machine-specific backups and technical error records live under:

```text
~/.local/state/codexkeep/
```

They can include:

- `pending-plugins.json` for resuming interrupted plugin operations;
- timestamped backups made before changing the real
  `~/.codex/config.toml`;
- original content retained when initialization adopts existing official
  paths;
- recoverable repository data retained when a later initialization step
  fails;
- technical details for the latest unhandled error.

The state directory is never committed to Git.

## Failure and recovery

### The remote is unreachable during `init`

Existing official paths remain unchanged. Verify the repository URL, access,
and network, then rerun `init`.

### A populated remote is not a valid CodexKeep repository

Local configuration remains unchanged. Use the correct private repository;
never force an unrelated populated repository into the configuration flow.

### `sync` encounters a Git conflict

Both sides remain, and CodexKeep never force-pushes or automatically
overwrites. Resolve the current Git state, then run:

```bash
codexkeep check
codexkeep sync
```

### Push fails

The local commit and selected `origin` remain. Rerun `codexkeep sync` when the
remote is available.

### Applying links fails

Links created by that run are rolled back. Run `codexkeep check`, address the
reported path, and then run `codexkeep link`.

### A plugin operation fails

File and Git synchronization may still complete. Account-bound plugins require
manual installation or sign-in on the current device; ordinary plugins can be
retried after repairing the Codex or marketplace state.

### The operation is interrupted

Completed local work remains, and steps that had not started do not run. Run
`codexkeep check`, then retry the original command according to the reported
state.

## Troubleshooting order

1. Run `codexkeep check` to inspect local links, configuration, plugin
   inventory, and Git state.
2. Address the first actionable warning.
3. If technical evidence is needed, inspect
   `~/.local/state/codexkeep/last-error.log`.
4. Retry the original command after local status is healthy.

`check` never contacts the Git remote. To verify the selected URL, run
`codexkeep remote` without an argument to view `origin`, then use
`codexkeep sync` to connect.

## Frequently asked questions

### Must the Git repository be private?

Local-only use needs no remote. Cross-device synchronization should use a
private repository because it still contains personal instructions, skills,
agents, and preferences.

### Should a new device use `init` or `link`?

Use `codexkeep init <git-url>` on a new device. Use `codexkeep link` only when
`~/.codexkeep` already exists locally and its official-path symlinks need to be
restored.

### Can npm installation replace local symlinks?

No. `npm install -g codexkeep` installs the CLI; symlinks connect official
Codex and agents paths to the configuration under `~/.codexkeep`.

### What happens when two devices change the same preference?

CodexKeep compares the common, local, and remote versions. A genuine two-sided
change requires an explicit local/remote choice; `--yes` cancels instead of
guessing.

### Does CodexKeep copy installed plugins?

It synchronizes validated third-party marketplace and plugin IDs and can ask
Codex to install missing ordinary plugins. Bundles, caches, credentials, and
account sign-in state always remain local.

## Further reading

- [Complete command guide](commands.en.md)
- [Project README](../README.en.md)
- [Implementation notes](IMPLEMENTATION.md)
