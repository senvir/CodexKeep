import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const exec = promisify(execFile);
const roots: string[] = [];
const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

after(async () => {
  await Promise.all(
    roots.map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

test("initializes an isolated home and synchronizes local and remote changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "codexkeep-cli-"));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  const remote = join(root, "remote.git");
  const other = join(root, "other");
  const codexLog = join(root, "codex.log");
  const gitLog = join(root, "git.log");
  const inventoryFailure = join(root, "fail-inventory");
  const removeFailure = join(root, "fail-remove");
  const pluginsJson = join(root, "plugins.json");
  const marketplacesJson = join(root, "marketplaces.json");
  await mkdir(bin, { recursive: true });
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(join(home, ".agents"), { recursive: true });
  await writeFile(
    join(home, ".agents", ".skill-lock.json"),
    `${JSON.stringify(
      {
        version: 3,
        skills: {},
        dismissed: { findSkillsPrompt: true },
        lastSelectedAgents: ["codex"],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(home, ".codex", "config.toml"),
    `model = "gpt-5"
api_key = "local-secret"

[mcp_servers.private]
url = "https://example.com"
http_headers = { Authorization = "secret" }
`,
  );
  await writeFile(pluginsJson, '{"installed":[],"available":[]}\n');
  await writeFile(marketplacesJson, '{"marketplaces":[]}\n');
  await writeFile(codexLog, "");
  await writeFile(gitLog, "");

  const fakeCodex = join(bin, "codex");
  await writeFile(
    fakeCodex,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >>"$CODEXKEEP_TEST_CODEX_LOG"
case "$*" in
  "plugin list --json")
    if [ -f "$CODEXKEEP_TEST_FAIL_INVENTORY" ]; then exit 1; fi
    cat "$CODEXKEEP_TEST_PLUGINS"
    ;;
  "plugin marketplace list --json") cat "$CODEXKEEP_TEST_MARKETPLACES" ;;
  "plugin marketplace add --json -- "*) exit 0 ;;
  "plugin marketplace remove --json -- "*)
    printf '%s\n' '{"marketplaces":[]}' >"$CODEXKEEP_TEST_MARKETPLACES"
    ;;
  "plugin add --json -- "*) exit 0 ;;
  "plugin remove --json -- "*)
    if [ -f "$CODEXKEEP_TEST_FAIL_REMOVE" ]; then exit 1; fi
    printf '%s\n' '{"installed":[]}' >"$CODEXKEEP_TEST_PLUGINS"
    ;;
  "plugin marketplace upgrade") exit 0 ;;
  *) exit 1 ;;
esac
`,
  );
  await chmod(fakeCodex, 0o755);
  const fakeGit = join(bin, "git");
  await writeFile(
    fakeGit,
    `#!/bin/sh
set -eu
printf '%s\n' "$*" >>"$CODEXKEEP_TEST_GIT_LOG"
exec /usr/bin/git "$@"
`,
  );
  await chmod(fakeGit, 0o755);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CODEX_CLI_PATH: fakeCodex,
    CODEXKEEP_TEST_CODEX_LOG: codexLog,
    CODEXKEEP_TEST_GIT_LOG: gitLog,
    CODEXKEEP_TEST_FAIL_INVENTORY: inventoryFailure,
    CODEXKEEP_TEST_FAIL_REMOVE: removeFailure,
    CODEXKEEP_TEST_PLUGINS: pluginsJson,
    CODEXKEEP_TEST_MARKETPLACES: marketplacesJson,
    XDG_STATE_HOME: join(home, ".local", "state"),
    GIT_CONFIG_GLOBAL: join(root, "global-gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "CodexKeep Test",
    GIT_AUTHOR_EMAIL: "codexkeep@example.invalid",
    GIT_COMMITTER_NAME: "CodexKeep Test",
    GIT_COMMITTER_EMAIL: "codexkeep@example.invalid",
    PATH: `${bin}:/usr/bin:/bin`,
  };

  const initialized = await exec(process.execPath, [cli, "init", "--yes"], {
    env,
  });
  assert.match(initialized.stdout, /初始化完成/u);
  assert.equal(
    await readlink(join(home, ".agents", "skills")),
    join(home, ".codexkeep", "skills"),
  );
  const initializedBaseConfig = await readFile(
    join(home, ".codex", "config.toml"),
    "utf8",
  );
  assert.match(initializedBaseConfig, /model = "gpt-5"/u);
  assert.match(initializedBaseConfig, /local-secret/u);
  assert.doesNotMatch(initializedBaseConfig, /^profile\s*=/mu);
  assert.match(
    await readFile(
      join(home, ".codexkeep", "codex", "codexkeep.config.toml"),
      "utf8",
    ),
    /model = "gpt-5"/u,
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(join(home, ".codexkeep", "skill-lock.json"), "utf8"),
    ),
    {
      version: 3,
      skills: {},
      dismissed: { findSkillsPrompt: true },
      lastSelectedAgents: ["codex"],
    },
  );

  const checked = await exec(process.execPath, [cli, "check"], { env });
  assert.match(checked.stdout, /当前设备状态正常/u);

  const localOnly = await exec(process.execPath, [cli, "remote"], { env });
  assert.match(localOnly.stdout, /当前仅保存在本机/u);

  await git(["init", "--bare", remote], root, env);
  const firstPublish = await exec(
    process.execPath,
    [cli, "remote", remote, "--yes"],
    { env },
  );
  assert.match(firstPublish.stdout, /远程仓库已连接/u);
  assert.match(firstPublish.stdout, /首次发布私人配置仓库/u);
  await git(["--git-dir", remote, "rev-parse", "refs/heads/main"], root, env);
  await git(["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"], root, env);

  const unchangedRemote = await exec(
    process.execPath,
    [cli, "remote", remote, "--yes"],
    { env },
  );
  assert.match(unchangedRemote.stdout, /已经连接，无需修改/u);

  await writeFile(
    join(home, ".codexkeep", "skills", "local.md"),
    "# Local skill\n",
  );
  const synced = await exec(
    process.execPath,
    [cli, "sync", "--yes"],
    { env },
  );
  assert.match(synced.stdout, /同步完成/u);

  await git(["clone", remote, other], root, env);
  await git(["config", "user.name", "Other Test"], other, env);
  await git(["config", "user.email", "other@example.invalid"], other, env);
  await writeFile(
    join(other, "plugins.json"),
    `${JSON.stringify(
      {
        version: 1,
        marketplaces: [
          {
            name: "custom",
            source: "https://example.com/custom.git",
          },
        ],
        plugins: ["demo@custom"],
        accountPlugins: [],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(other, "codex", "codexkeep.config.toml"),
    'model = "gpt-5.5"\n',
  );
  await git(
    ["add", "plugins.json", "codex/codexkeep.config.toml"],
    other,
    env,
  );
  await git(["commit", "-m", "test: add plugin"], other, env);
  await git(["push"], other, env);

  const received = await exec(
    process.execPath,
    [cli, "sync", "--yes"],
    { env },
  );
  assert.match(received.stdout, /plugin demo@custom 已安装/u);
  const codexCalls = await readFile(codexLog, "utf8");
  assert.match(
    codexCalls,
    /plugin marketplace add --json -- https:\/\/example\.com\/custom\.git/u,
  );
  assert.match(codexCalls, /plugin add --json -- demo@custom/u);
  const updatedBaseConfig = await readFile(
    join(home, ".codex", "config.toml"),
    "utf8",
  );
  assert.match(updatedBaseConfig, /model = "gpt-5.5"/u);
  assert.match(updatedBaseConfig, /local-secret/u);

  const ambiguousRemoval = await exec(
    process.execPath,
    [cli, "sync", "--yes"],
    { env },
  ).then(
    () => undefined,
    (error: unknown) => error as { stdout: string; stderr: string },
  );
  assert.match(
    ambiguousRemoval?.stdout ?? "",
    /本机缺少已同步清单中的以下项目/u,
  );
  assert.match(
    ambiguousRemoval?.stderr ?? "",
    /无法判断是恢复共享插件还是同步本机删除/u,
  );

  const secondHome = join(root, "second-home");
  await mkdir(join(secondHome, ".codex"), { recursive: true });
  const secondEnv = {
    ...env,
    HOME: secondHome,
    XDG_STATE_HOME: join(secondHome, ".local", "state"),
  };
  const joinedExisting = await exec(
    process.execPath,
    [cli, "init", remote, "--yes"],
    { env: secondEnv },
  );
  assert.match(joinedExisting.stdout, /本机初始化完成/u);
  assert.match(joinedExisting.stdout, /\+ 安装 plugin：demo@custom/u);
  assert.ok(
    joinedExisting.stdout.indexOf("+ 安装 plugin：demo@custom") <
      joinedExisting.stdout.indexOf("本机初始化完成"),
  );
  assert.equal(
    await readlink(join(secondHome, ".agents", "skills")),
    join(secondHome, ".codexkeep", "skills"),
  );

  await writeFile(
    pluginsJson,
    `${JSON.stringify({
      installed: [
        {
          pluginId: "demo@custom",
          marketplaceName: "custom",
          installed: true,
        },
      ],
    })}\n`,
  );
  await writeFile(
    marketplacesJson,
    `${JSON.stringify({
      marketplaces: [
        {
          name: "custom",
          marketplaceSource: {
            sourceType: "git",
            source: "https://example.com/custom.git",
          },
        },
      ],
    })}\n`,
  );
  await git(["pull", "--rebase"], other, env);
  await writeFile(
    join(other, "plugins.json"),
    `${JSON.stringify(
      {
        version: 1,
        marketplaces: [],
        plugins: [],
        accountPlugins: [],
      },
      null,
      2,
    )}\n`,
  );
  await git(["add", "plugins.json"], other, env);
  await git(["commit", "-m", "test: remove plugin"], other, env);
  await git(["push"], other, env);

  await writeFile(gitLog, "");
  await writeFile(inventoryFailure, "fail\n");
  const failedInventoryRead = await exec(
    process.execPath,
    [cli, "sync", "--yes"],
    { env },
  ).then(
    () => undefined,
    (error: unknown) => error as { stdout: string },
  );
  assert.match(
    failedInventoryRead?.stdout ?? "",
    /Codex CLI 暂时无法读取插件/u,
  );
  assert.match(
    failedInventoryRead?.stdout ?? "",
    /- 从共享清单移除 plugin：demo@custom/u,
  );
  assert.match(
    failedInventoryRead?.stdout ?? "",
    /- 从共享清单移除 marketplace：custom/u,
  );
  assert.doesNotMatch(
    failedInventoryRead?.stdout ?? "",
    /\+ 更新插件清单/u,
  );
  const plannedGitCalls = await readFile(gitLog, "utf8");
  assert.match(plannedGitCalls, /rebase [0-9a-f]{40}/u);
  assert.doesNotMatch(plannedGitCalls, /^pull\b/mu);
  await access(
    join(home, ".local", "state", "codexkeep", "pending-plugins.json"),
  );
  const pendingAfterReadFailure = JSON.parse(
    await readFile(
      join(home, ".local", "state", "codexkeep", "pending-plugins.json"),
      "utf8",
    ),
  ) as { base: { plugins: string[] }; desired: { plugins: string[] } };
  assert.deepEqual(pendingAfterReadFailure.base.plugins, ["demo@custom"]);
  assert.deepEqual(pendingAfterReadFailure.desired.plugins, []);
  await rm(inventoryFailure, { force: true });

  await writeFile(removeFailure, "fail\n");
  const failedRemoval = await exec(
    process.execPath,
    [cli, "sync", "--yes"],
    { env },
  ).then(
    () => undefined,
    (error: unknown) => error as { stdout: string },
  );
  assert.match(failedRemoval?.stdout ?? "", /plugin demo@custom 卸载失败/u);
  await access(
    join(home, ".local", "state", "codexkeep", "pending-plugins.json"),
  );
  await rm(removeFailure, { force: true });

  const removed = await exec(
    process.execPath,
    [cli, "sync", "--yes"],
    { env },
  );
  assert.match(removed.stdout, /- 卸载 plugin：demo@custom/u);
  assert.match(removed.stdout, /- 移除 marketplace：custom/u);
  const removalCalls = await readFile(codexLog, "utf8");
  assert.match(removalCalls, /plugin remove --json -- demo@custom/u);
  assert.match(removalCalls, /plugin marketplace remove --json -- custom/u);
  assert.deepEqual(JSON.parse(await readFile(pluginsJson, "utf8")), {
    installed: [],
  });
  assert.deepEqual(JSON.parse(await readFile(marketplacesJson, "utf8")), {
    marketplaces: [],
  });
  await assert.rejects(async () =>
    await access(
      join(home, ".local", "state", "codexkeep", "pending-plugins.json"),
    ),
  );

  const emptyRemote = join(root, "empty-init.git");
  const thirdHome = join(root, "third-home");
  await git(["init", "--bare", emptyRemote], root, env);
  await mkdir(join(thirdHome, ".codex"), { recursive: true });
  const thirdEnv = {
    ...env,
    HOME: thirdHome,
    XDG_STATE_HOME: join(thirdHome, ".local", "state"),
  };
  const initializedWithEmptyRemote = await exec(
    process.execPath,
    [cli, "init", emptyRemote, "--yes"],
    { env: thirdEnv },
  );
  assert.match(initializedWithEmptyRemote.stdout, /首次发布私人配置仓库/u);
  await git(
    ["--git-dir", emptyRemote, "rev-parse", "refs/heads/main"],
    root,
    env,
  );

  await writeFile(
    pluginsJson,
    `${JSON.stringify({
      installed: [
        {
          pluginId: "local@custom",
          marketplaceName: "custom",
          installed: true,
        },
      ],
    })}\n`,
  );
  await writeFile(
    marketplacesJson,
    `${JSON.stringify({
      marketplaces: [
        {
          name: "custom",
          marketplaceSource: {
            sourceType: "git",
            source: "https://example.com/custom.git",
          },
        },
      ],
    })}\n`,
  );
  const fourthHome = join(root, "fourth-home");
  await mkdir(join(fourthHome, ".codex"), { recursive: true });
  const accountPluginRoot = join(
    fourthHome,
    ".codex",
    "plugins",
    "cache",
    "openai-curated-remote",
    "github",
  );
  await mkdir(join(accountPluginRoot, "1.0.0", ".codex-plugin"), {
    recursive: true,
  });
  await writeFile(
    join(accountPluginRoot, ".codex-remote-plugin-install.json"),
    "{}\n",
  );
  await writeFile(
    join(accountPluginRoot, "1.0.0", ".codex-plugin", "plugin.json"),
    `${JSON.stringify({ interface: { displayName: "GitHub" } })}\n`,
  );
  const fourthEnv = {
    ...env,
    HOME: fourthHome,
    XDG_STATE_HOME: join(fourthHome, ".local", "state"),
  };
  const initializedWithLocalPlugin = await exec(
    process.execPath,
    [cli, "init", remote, "--yes"],
    { env: fourthEnv },
  );
  assert.match(
    initializedWithLocalPlugin.stdout,
    /\+ 加入共享清单 plugin：local@custom/u,
  );
  assert.match(
    initializedWithLocalPlugin.stdout,
    /\+ 记录 account plugin：GitHub（其他设备需手动安装或登录）/u,
  );
  await writeFile(pluginsJson, '{"installed":[]}\n');
  await writeFile(marketplacesJson, '{"marketplaces":[]}\n');

  const invalidWork = join(root, "invalid-work");
  const invalidRemote = join(root, "invalid.git");
  await git(["init", "-b", "main", invalidWork], root, env);
  await git(["config", "user.name", "Invalid Test"], invalidWork, env);
  await git(
    ["config", "user.email", "invalid@example.invalid"],
    invalidWork,
    env,
  );
  await writeFile(join(invalidWork, "README.md"), "not CodexKeep\n");
  await git(["add", "README.md"], invalidWork, env);
  await git(["commit", "-m", "test: invalid repository"], invalidWork, env);
  await git(["init", "--bare", invalidRemote], root, env);
  await git(["remote", "add", "origin", invalidRemote], invalidWork, env);
  await git(["push", "-u", "origin", "main"], invalidWork, env);

  const rejectedRemote = await exec(
    process.execPath,
    [cli, "remote", invalidRemote, "--yes"],
    { env },
  ).then(
    () => undefined,
    (error: unknown) => error as { stderr: string },
  );
  assert.match(rejectedRemote?.stderr ?? "", /已有内容/u);
  assert.equal(
    await gitOutput(
      ["remote", "get-url", "origin"],
      join(home, ".codexkeep"),
      env,
    ),
    remote,
  );

  const invalidHome = join(root, "invalid-home");
  await mkdir(join(invalidHome, ".codex"), { recursive: true });
  const invalidEnv = {
    ...env,
    HOME: invalidHome,
    XDG_STATE_HOME: join(invalidHome, ".local", "state"),
  };
  const rejectedInit = await exec(
    process.execPath,
    [cli, "init", invalidRemote, "--yes"],
    { env: invalidEnv },
  ).then(
    () => undefined,
    (error: unknown) => error as { stderr: string },
  );
  assert.match(rejectedInit?.stderr ?? "", /不是有效的 CodexKeep/u);
  await assert.rejects(async () => await access(join(invalidHome, ".codexkeep")));

  const unreachableHome = join(root, "unreachable-home");
  await mkdir(join(unreachableHome, ".codex"), { recursive: true });
  const unreachableEnv = {
    ...env,
    HOME: unreachableHome,
    XDG_STATE_HOME: join(unreachableHome, ".local", "state"),
  };
  const rejectedUnreachable = await exec(
    process.execPath,
    [cli, "init", join(root, "does-not-exist.git"), "--yes"],
    { env: unreachableEnv },
  ).then(
    () => undefined,
    (error: unknown) => error as { stderr: string },
  );
  assert.match(rejectedUnreachable?.stderr ?? "", /无法连接/u);
  await assert.rejects(
    async () => await access(join(unreachableHome, ".codexkeep")),
  );

  const replacement = join(root, "replacement.git");
  await git(["init", "--bare", replacement], root, env);
  const replaced = await exec(
    process.execPath,
    [cli, "remote", replacement, "--yes"],
    { env },
  );
  assert.match(replaced.stdout, /更换私人 Git 仓库/u);
  await git(
    ["--git-dir", replacement, "rev-parse", "refs/heads/main"],
    root,
    env,
  );
});

async function git(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await exec("git", [...args], { cwd, env });
}

async function gitOutput(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return (await exec("git", [...args], { cwd, env })).stdout.trim();
}
