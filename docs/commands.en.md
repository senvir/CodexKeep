<p align="center">
  <a href="commands.md">简体中文</a>
  ·
  <strong>English</strong>
</p>

# CodexKeep command guide

This guide explains when to use each public command, whether it accesses the
network, what it can change, and what remains recoverable after a failure.
Start with the [project README](../README.en.md) if this is your first setup.

## Global options

| Option | Effect |
| --- | --- |
| `--yes` | Accept routine confirmations; never bypass validation or resolve a content conflict |
| `--help`, `-h` | Show help |
| `--version` | Show the version |

`--yes` can appear with a command, for example `codexkeep sync --yes`. The
sections below describe its effect on each workflow.

## `codexkeep`

```bash
codexkeep
```

- **Use it when:** you want to choose an action from the arrow-key menu.
- **Network:** opening the menu itself is local; the selected command determines
  later network access.
- **Changes:** none until you select an action and accept its plan.
- **Confirmation and recovery:** identical to the selected command.

The current menu is in Chinese and includes sync, update, diagnostics, remote,
device linking, and initialization. In a non-interactive environment, running
`codexkeep` without a command prints help.

## `codexkeep init [git-url]`

```bash
codexkeep init
codexkeep init git@github.com:your-name/codexkeep-config.git
```

- **Use it when:** setting up the first Mac, joining an existing CodexKeep
  repository on another Mac, or safely merging supported local configuration.
- **Network:** a supplied Git URL is probed first. An empty repository becomes
  the first publication target; a populated repository must already be a valid
  CodexKeep repository.
- **Changes:** CodexKeep builds the result in a temporary directory first.
  After confirmation, it installs `~/.codexkeep`, imports or merges supported
  configuration, applies portable preferences, creates five official-path
  symlinks, commits, and synchronizes when a remote exists.
- **Confirmation:** interactive mode shows one complete plan. `--yes` accepts
  routine confirmation; without a URL, non-interactive initialization remains
  local-only.
- **Conflicts:** a populated invalid repository is rejected. Differences in
  same-name skills, agents, global instructions, source records, plugin
  inventory, or portable preferences require an explicit repository/local
  choice. `--yes` never chooses a side.
- **Failure and recovery:** unreachable or invalid remotes cause no
  official-path changes. If installation fails after confirmation, the
  original base config is restored and recoverable new repository data remains
  under the CodexKeep state directory.

Use `init <git-url>`, not `link`, to join an existing repository on another Mac.

## `codexkeep sync`

```bash
codexkeep sync
codexkeep sync --yes
```

- **Use it when:** saving local changes, receiving another device's changes, or
  applying shared configuration to the current Mac.
- **Network:** reads local Codex plugin inventory and fetches `origin` when
  configured. Fetching builds an accurate plan; plugin installation and push
  happen only after the plan is accepted.
- **Changes:** can install or remove third-party marketplaces and plugins,
  update `plugins.json`, reconcile the portable `config.toml` allowlist, back
  up and update the real Codex config, commit local files, rebase remote
  updates, and push.
- **Confirmation:** shows the complete sync plan with `+` and `-` markers;
  interactive terminals render them in green and red. `--yes` accepts the
  routine plan but never decides whether a locally missing plugin should be
  restored or treated as an intentional deletion.
- **Conflicts:** incompatible marketplace sources stop before managed content
  changes. Concurrent local and remote edits to a portable setting require an
  explicit side. A plugin that remains shared but is missing locally also
  requires choosing either the shared copy or the local deletion. Unresolved
  Git conflicts stop synchronization without force-overwriting either side.
- **Failure and recovery:** an offline remote does not prevent local commits.
  A failed push keeps local changes so a later `codexkeep sync` can retry.
  Failed plugin operations leave the target inventory locally recoverable for
  a retry. Account-bound plugins are reported for manual installation or
  sign-in rather than copying credentials.

Without a configured remote, `sync` still saves supported local changes and
reports that the configuration is local-only.

## `codexkeep update`

```bash
codexkeep update
codexkeep update --yes
```

- **Use it when:** sourced global skills and Git-backed plugin marketplaces
  should be upgraded before synchronization.
- **Network:** runs the global skills updater through `npx`, asks Codex to
  upgrade marketplaces, then performs the same remote access as `sync`.
- **Changes:** third-party sources may be updated before the normal sync plan
  appears; the complete `sync` workflow follows.
- **Confirmation:** the upgrade phase has no separate confirmation. The normal
  sync still shows its plan unless `--yes` is supplied.
- **Failure and recovery:** a skills or marketplace upgrade failure preserves
  existing content and does not prevent the remaining update and sync steps
  from being attempted. Any partial failure returns a non-zero status. Run
  `codexkeep check`, fix the source or network issue, then retry `update`; use
  `sync` if another upgrade is unnecessary.

## `codexkeep check`

```bash
codexkeep check
```

- **Use it when:** verifying a new device, diagnosing a failed command, or
  checking for local changes that need synchronization.
- **Network:** never contacts the Git remote. It may invoke the installed Codex
  CLI to read local plugin and marketplace inventory.
- **Changes:** none. This is a read-only diagnostic command.
- **Checks:** official-path links, accidental non-built-in skills under
  `~/.codex/skills`, plugin inventory, portable preferences, Git repository and
  worktree state, configured `origin`, and the latest technical error record.
- **Failure and recovery:** follow the actionable warning. Technical details
  remain under `~/.local/state/codexkeep` rather than printing subprocess
  output that might contain sensitive information.

`check` does not fetch, so a healthy status describes the local device rather
than proving that the remote is currently reachable.

## `codexkeep remote [git-url]`

```bash
codexkeep remote
codexkeep remote git@github.com:your-name/codexkeep-config.git
```

- **Use it when:** viewing the current `origin`, connecting the first remote to
  an initialized local repository, or replacing it with an empty remote.
- **Network:** no argument reads local Git configuration only. A supplied URL
  is probed before `origin` changes.
- **Changes:** after confirmation, adds or replaces `origin` and enters the
  existing sync flow without a second routine confirmation.
- **Confirmation:** a new URL shows the remote change and initial publication
  plan; `--yes` can accept it.
- **Conflicts:** the target must be empty. Use `init <git-url>` on a new device
  for an existing populated CodexKeep repository. In-progress Git operations
  or incomplete links stop the command.
- **Failure and recovery:** if publication fails, the selected `origin` and
  local commits remain so `codexkeep sync` can retry.

## `codexkeep link`

```bash
codexkeep link
codexkeep link --yes
```

- **Use it when:** `~/.codexkeep` already exists locally but one or more
  supported official-path symlinks are missing.
- **Network:** never.
- **Changes:** validates the complete local repository, lists missing links,
  and creates them after confirmation.
- **Confirmation:** `--yes` accepts creation of non-conflicting missing links.
- **Conflicts:** if an official path already contains different content, the
  command changes nothing and directs you to `codexkeep init` for a safe merge.
- **Failure and recovery:** if link creation fails, links created by that run
  are rolled back. Repeated runs are idempotent.

`link` never clones a remote and cannot replace `init <git-url>` on a new
device.

## Further reading

- [Safety and recovery](safety-and-recovery.en.md)
- [Project README](../README.en.md)
- [Implementation notes](IMPLEMENTATION.md)
