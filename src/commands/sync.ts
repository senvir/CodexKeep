import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { AppContext } from "../app.js";
import type { PluginInventory } from "../domain/inventory.js";
import {
  emptyInventory,
  inventoryOperations,
  inventoryEquals,
  mergeInventoryChanges,
  missingInventory,
  parseInventory,
  readInventory,
  reconcileInventory,
  writeInventory,
} from "../domain/inventory.js";
import {
  addMarketplace,
  addPlugin,
  collectCodexInventory,
  removeMarketplace,
  removePlugin,
} from "../services/codex.js";
import {
  applyPortableConfig,
  extractPortableConfig,
} from "../services/config.js";
import {
  atomicWrite,
  readTextIfPresent,
} from "../services/files.js";
import {
  aheadBehind,
  commit,
  commitMessage,
  conflictedFiles,
  fetchOrigin,
  git,
  hasOrigin,
  isGitRepository,
  mergeBase,
  operationInProgress,
  push,
  readFileAtReference,
  rebaseOnto,
  stageAll,
  stagedFiles,
  unstagePath,
  upstreamReference,
  workingChanges,
} from "../services/git.js";
import {
  inspectLinks,
  validateConfigRepository,
} from "../services/links.js";
import { linkSpecs } from "../services/paths.js";

export interface SyncOptions {
  readonly confirmationAlreadySatisfied?: boolean;
  readonly restoreRepositoryInventory?: boolean;
  readonly showTitle?: boolean;
}

interface PendingPluginSync {
  readonly version: 1;
  readonly base: PluginInventory;
  readonly desired: PluginInventory;
}

export async function syncCommand(
  context: AppContext,
  options: SyncOptions = {},
): Promise<number> {
  const { ui, paths } = context;
  if (options.showTitle !== false) {
    ui.title("CodexKeep Sync", "同步个人 Codex 配置");
  }

  const specs = linkSpecs(paths);
  try {
    await validateConfigRepository(specs);
  } catch {
    ui.error("私人配置仓库不完整，未开始同步");
    return 1;
  }
  const links = await inspectLinks(specs);
  if (links.some((entry) => entry.state !== "ready")) {
    ui.error("当前设备尚未完整连接，未开始同步");
    ui.info("运行 codexkeep link 可安全恢复连接");
    return 1;
  }

  const gitOptions = {
    cwd: paths.repo,
    env: context.env,
    signal: context.signal,
  };
  if (!(await isGitRepository(gitOptions))) {
    ui.error("私人配置目录不是 Git 仓库，未开始同步");
    return 1;
  }
  if (
    (await operationInProgress(gitOptions)) ||
    (await conflictedFiles(gitOptions)).length > 0
  ) {
    ui.error("Git 中有尚未完成的冲突，CodexKeep 没有覆盖任何内容");
    return 1;
  }

  const repositoryInventory = await readInventory(
    join(paths.repo, "plugins.json"),
  );
  const headInventoryRaw = await readFileAtReference(
    "HEAD",
    "plugins.json",
    gitOptions,
  );
  const headInventory = headInventoryRaw
    ? parseInventory(headInventoryRaw)
    : repositoryInventory;
  const pendingInventoryPath = join(paths.state, "pending-plugins.json");
  let pendingSync: PendingPluginSync | undefined;
  const pendingInventoryRaw = await readTextIfPresent(pendingInventoryPath);
  try {
    pendingSync = pendingInventoryRaw
      ? parsePendingPluginSync(pendingInventoryRaw)
      : undefined;
  } catch {
    ui.error("上次未完成的插件同步状态无法读取，未开始同步");
    ui.info(`请检查 ${pendingInventoryPath}`);
    return 1;
  }
  const profilePath = join(
    paths.repo,
    "codex",
    "codexkeep.config.toml",
  );
  const repositoryPortable = extractPortableConfig(
    (await readTextIfPresent(profilePath)) ?? "",
  );
  const basePortable = extractPortableConfig(
    (await readTextIfPresent(paths.baseConfig)) ?? "",
  );
  let localInventory = emptyInventory();
  let pluginCheckOk = true;
  try {
    localInventory = await ui.spin("正在读取本机插件", async () =>
      await collectCodexInventory({
        env: context.env,
        signal: context.signal,
        paths,
      }),
    );
  } catch {
    pluginCheckOk = false;
    ui.warn("Codex CLI 暂时无法读取插件；文件与 Git 仍会继续同步");
  }

  const remoteConfigured = await hasOrigin(gitOptions);
  let remoteAvailable = false;
  let remoteReference: string | undefined;
  let remoteInventory = headInventory;
  let commonInventory = headInventory;
  let remotePortable: string | undefined;
  let commonPortable = repositoryPortable;

  if (remoteConfigured) {
    try {
      await ui.spin("正在连接 Git 远程仓库", async () => {
        await fetchOrigin(gitOptions);
      });
      remoteAvailable = true;
      const reference = await upstreamReference(gitOptions);
      remoteReference = reference
        ? await git(["rev-parse", reference], gitOptions)
        : undefined;
      if (remoteReference) {
        const raw = await readFileAtReference(
          remoteReference,
          "plugins.json",
          gitOptions,
        );
        if (raw) remoteInventory = parseInventory(raw);
        const remoteProfile = await readFileAtReference(
          remoteReference,
          "codex/codexkeep.config.toml",
          gitOptions,
        );
        if (remoteProfile !== undefined) {
          remotePortable = extractPortableConfig(remoteProfile);
        }
        const baseReference = await mergeBase(remoteReference, gitOptions);
        const baseInventory = await readFileAtReference(
          baseReference,
          "plugins.json",
          gitOptions,
        );
        if (baseInventory !== undefined) {
          commonInventory = parseInventory(baseInventory);
        }
        const baseProfile = await readFileAtReference(
          baseReference,
          "codex/codexkeep.config.toml",
          gitOptions,
        );
        if (baseProfile !== undefined) {
          commonPortable = extractPortableConfig(baseProfile);
        }
      }
    } catch {
      remoteAvailable = false;
      remoteReference = undefined;
      remoteInventory = headInventory;
      commonInventory = headInventory;
      remotePortable = undefined;
      ui.warn("暂时无法连接远程仓库；本地修改仍可安全保存");
    }
  } else {
    ui.warn("尚未配置远程仓库；本次只保存本地修改");
  }

  let sharedInventory;
  try {
    sharedInventory = pendingSync
      ? mergeInventoryChanges(
          pendingSync.base,
          pendingSync.desired,
          remoteInventory,
        )
      : mergeInventoryChanges(
          commonInventory,
          repositoryInventory,
          remoteInventory,
        );
  } catch {
    ui.error("插件清单在本机和远端存在冲突，未修改任何内容");
    ui.info("请检查 plugins.json 中对应 marketplace 或 plugin");
    return 1;
  }

  let desiredInventory = sharedInventory;
  let installInventory = emptyInventory();
  let removeInventory = emptyInventory();
  if (pluginCheckOk) {
    if (pendingSync) {
      const operations = inventoryOperations(desiredInventory, localInventory);
      installInventory = operations.install;
      removeInventory = operations.remove;
    } else {
      let reconciliation;
      try {
        reconciliation = reconcileInventory(
          commonInventory,
          sharedInventory,
          localInventory,
        );
      } catch {
        ui.error("同名 marketplace 的来源不一致，未修改任何内容");
        ui.info("请检查 plugins.json 中对应 marketplace 的 source");
        return 1;
      }

      if (hasInventoryEntries(reconciliation.ambiguous)) {
        let resolution: "shared" | "local" | "cancel";
        if (options.restoreRepositoryInventory) {
          resolution = "shared";
        } else {
          ui.line("本机缺少已同步清单中的以下项目：");
          for (const marketplace of reconciliation.ambiguous.marketplaces) {
            ui.line(`  • marketplace：${marketplace.name}`);
          }
          for (const plugin of reconciliation.ambiguous.plugins) {
            ui.line(`  • plugin：${plugin}`);
          }
          if (!ui.interactive) {
            ui.error("无法判断是恢复共享插件还是同步本机删除");
            ui.info("请在交互终端重新运行 codexkeep sync 并明确选择");
            return 1;
          }
          resolution = await ui.choose(
            "如何处理本机缺少的插件？",
            [
              {
                value: "shared",
                label: "恢复共享插件",
                hint: "在本机重新安装这些项目",
              },
              {
                value: "local",
                label: "采用本机删除",
                hint: "从共享清单移除并传播到其他设备",
              },
              { value: "cancel", label: "取消同步" },
            ] as const,
            "cancel",
          );
        }
        if (resolution === "cancel") {
          ui.cancelled();
          return 0;
        }
        reconciliation = reconcileInventory(
          commonInventory,
          sharedInventory,
          localInventory,
          resolution,
        );
      }

      desiredInventory = reconciliation.desired;
      installInventory = reconciliation.install;
      removeInventory = reconciliation.remove;
    }
  }
  const desiredPortable = await resolvePortableConfig(
    context,
    commonPortable,
    repositoryPortable,
    basePortable,
    remotePortable,
  );
  if (desiredPortable === undefined) {
    ui.cancelled();
    return 0;
  }

  const changes = await workingChanges(gitOptions);
  const counts = remoteReference
    ? await aheadBehind(remoteReference, gitOptions)
    : { ahead: 0, behind: 0 };
  const needsInitialPush =
    remoteConfigured && remoteAvailable && remoteReference === undefined;
  const inventoryChanged = !inventoryEquals(
    desiredInventory,
    repositoryInventory,
  );
  const sharedAdditions = missingInventory(
    desiredInventory,
    repositoryInventory,
  );
  const sharedRemovals = missingInventory(
    repositoryInventory,
    desiredInventory,
  );
  const locallyInstalledPlugins = new Set(installInventory.plugins);
  const locallyAddedMarketplaces = new Set(
    installInventory.marketplaces.map((entry) => entry.name),
  );
  const locallyRemovedPlugins = new Set(removeInventory.plugins);
  const locallyRemovedMarketplaces = new Set(
    removeInventory.marketplaces.map((entry) => entry.name),
  );
  const sharedAddedPlugins = new Set(sharedAdditions.plugins);
  const sharedAddedMarketplaces = new Set(
    sharedAdditions.marketplaces.map((entry) => entry.name),
  );
  const sharedRemovedPlugins = new Set(sharedRemovals.plugins);
  const sharedRemovedMarketplaces = new Set(
    sharedRemovals.marketplaces.map((entry) => entry.name),
  );
  const hasVisibleSharedInventoryChanges =
    sharedAdditions.marketplaces.length > 0 ||
    sharedAdditions.plugins.length > 0 ||
    sharedAdditions.accountPlugins.length > 0 ||
    sharedRemovals.marketplaces.length > 0 ||
    sharedRemovals.plugins.length > 0;
  const repositoryConfigChanged = desiredPortable !== repositoryPortable;
  const baseConfigChanged = desiredPortable !== basePortable;
  const plan: { type: "add" | "remove"; text: string }[] = [
    ...removeInventory.plugins.map((entry) => ({
      type: "remove" as const,
      text: sharedRemovedPlugins.has(entry)
        ? `卸载并从共享清单移除 plugin：${entry}`
        : `卸载 plugin：${entry}`,
    })),
    ...removeInventory.marketplaces.map((entry) => ({
      type: "remove" as const,
      text: sharedRemovedMarketplaces.has(entry.name)
        ? `移除并从共享清单删除 marketplace：${entry.name}`
        : `移除 marketplace：${entry.name}`,
    })),
    ...sharedRemovals.plugins
      .filter((entry) => !locallyRemovedPlugins.has(entry))
      .map((entry) => ({
        type: "remove" as const,
        text: `从共享清单移除 plugin：${entry}`,
      })),
    ...sharedRemovals.marketplaces
      .filter((entry) => !locallyRemovedMarketplaces.has(entry.name))
      .map((entry) => ({
        type: "remove" as const,
        text: `从共享清单移除 marketplace：${entry.name}`,
      })),
    ...installInventory.marketplaces.map((entry) => ({
      type: "add" as const,
      text: sharedAddedMarketplaces.has(entry.name)
        ? `添加并加入共享清单 marketplace：${entry.name}`
        : `添加 marketplace：${entry.name}`,
    })),
    ...installInventory.plugins.map((entry) => ({
      type: "add" as const,
      text: sharedAddedPlugins.has(entry)
        ? `安装并加入共享清单 plugin：${entry}`
        : `安装 plugin：${entry}`,
    })),
    ...sharedAdditions.marketplaces
      .filter((entry) => !locallyAddedMarketplaces.has(entry.name))
      .map((entry) => ({
        type: "add" as const,
        text: `加入共享清单 marketplace：${entry.name}`,
      })),
    ...sharedAdditions.plugins
      .filter((entry) => !locallyInstalledPlugins.has(entry))
      .map((entry) => ({
        type: "add" as const,
        text: `加入共享清单 plugin：${entry}`,
      })),
    ...sharedAdditions.accountPlugins.map((entry) => ({
      type: "add" as const,
      text: `记录 account plugin：${entry.name}（其他设备需手动安装或登录）`,
    })),
    ...(inventoryChanged && !hasVisibleSharedInventoryChanges
      ? [{ type: "add" as const, text: "更新插件清单" }]
      : []),
    ...(repositoryConfigChanged
      ? [{ type: "add" as const, text: "更新可移植 Codex 设置" }]
      : []),
    ...(baseConfigChanged
      ? [{ type: "add" as const, text: "将可移植设置应用到本机 Codex" }]
      : []),
    ...(changes.length > 0
      ? [{ type: "add" as const, text: `保存 ${changes.length} 项本地修改` }]
      : []),
    ...(counts.behind > 0
      ? [{ type: "add" as const, text: `接收 ${counts.behind} 个远程更新` }]
      : []),
    ...(counts.ahead > 0
      ? [{ type: "add" as const, text: `上传 ${counts.ahead} 个本地更新` }]
      : []),
    ...(needsInitialPush
      ? [{ type: "add" as const, text: "首次发布私人配置仓库" }]
      : []),
  ];

  if (plan.length === 0) {
    if (pendingSync && pluginCheckOk) {
      await rm(pendingInventoryPath, { force: true });
    }
    if (!pluginCheckOk) {
      ui.done("文件和 Git 已同步；本次未能核对插件");
      return 1;
    }
    if (remoteConfigured && !remoteAvailable) {
      ui.done("本地没有待保存内容；远程连接尚未确认");
      return 1;
    }
    if (!remoteConfigured) {
      ui.done("本地没有待保存内容；尚未配置远程仓库");
      return 1;
    }
    for (const account of installInventory.accountPlugins) {
      ui.warn(`${account.name} 需要在插件市场安装或登录`);
    }
    ui.done("已经同步，无需修改");
    return installInventory.accountPlugins.length > 0 ? 1 : 0;
  }

  ui.line("将进行以下同步：");
  ui.diff(plan);
  for (const account of installInventory.accountPlugins) {
    ui.warn(`${account.name} 需要在插件市场安装或登录`);
  }
  if (
    !options.confirmationAlreadySatisfied &&
    !(await ui.confirm("开始同步？"))
  ) {
    ui.cancelled();
    return 0;
  }
  await atomicWrite(
    pendingInventoryPath,
    serializePendingPluginSync(
      pendingSync?.base ?? commonInventory,
      desiredInventory,
    ),
  );

  const originalInventoryRaw = `${JSON.stringify(repositoryInventory, null, 2)}\n`;
  const originalProfileRaw =
    (await readTextIfPresent(profilePath)) ??
    "# Portable Codex preferences managed by CodexKeep.\n";
  await stageAll(gitOptions);
  await unstagePath("plugins.json", gitOptions);
  await unstagePath("codex/codexkeep.config.toml", gitOptions);
  const committedInventoryRaw = await readFileAtReference(
    "HEAD",
    "plugins.json",
    gitOptions,
  );
  const headProfile = await readFileAtReference(
    "HEAD",
    "codex/codexkeep.config.toml",
    gitOptions,
  );
  if (committedInventoryRaw === undefined) {
    await rm(join(paths.repo, "plugins.json"), { force: true });
  } else {
    await atomicWrite(join(paths.repo, "plugins.json"), committedInventoryRaw);
  }
  if (headProfile === undefined) {
    await rm(profilePath, { force: true });
  } else {
    await atomicWrite(profilePath, headProfile);
  }

  const firstCommitFiles = await stagedFiles(gitOptions);
  if (firstCommitFiles.length > 0) {
    await commit(commitMessage(firstCommitFiles), gitOptions);
    ui.success("本地配置已保存");
  }

  if (remoteAvailable && remoteReference) {
    try {
      await ui.spin("正在接收远程更新", async () => {
        await rebaseOnto(remoteReference, gitOptions);
      });
    } catch {
      await atomicWrite(
        join(paths.repo, "plugins.json"),
        originalInventoryRaw,
      );
      await atomicWrite(profilePath, originalProfileRaw);
      await rm(pendingInventoryPath, { force: true });
      ui.error("远程更新存在冲突，双方内容都已保留");
      ui.info("CodexKeep 已停止同步，没有强制覆盖任何一方");
      return 1;
    }
  }

  await writeInventory(join(paths.repo, "plugins.json"), desiredInventory);
  await atomicWrite(
    profilePath,
    desiredPortable ||
      "# Portable Codex preferences managed by CodexKeep.\n",
  );

  let pluginFailures = 0;
  if (pluginCheckOk) {
    const codexOptions = {
      env: context.env,
      signal: context.signal,
      paths,
    };
    const pluginActions: {
      progress: string;
      success: string;
      failure: string;
      blocked?: string;
      run: () => Promise<void>;
    }[] = [
      ...removeInventory.plugins.map((plugin) => ({
        progress: `正在卸载 plugin ${plugin}`,
        success: `plugin ${plugin} 已卸载`,
        failure: `plugin ${plugin} 卸载失败`,
        run: async () => await removePlugin(plugin, codexOptions),
      })),
      ...removeInventory.marketplaces.map((marketplace) => ({
        progress: `正在移除 marketplace ${marketplace.name}`,
        success: `marketplace ${marketplace.name} 已移除`,
        failure: `marketplace ${marketplace.name} 移除失败`,
        blocked: `marketplace ${marketplace.name} 暂未移除；仍有 plugin 未能卸载`,
        run: async () => await removeMarketplace(marketplace.name, codexOptions),
      })),
      ...installInventory.marketplaces.map((marketplace) => ({
        progress: `正在添加 marketplace ${marketplace.name}`,
        success: `marketplace ${marketplace.name} 已连接`,
        failure: `marketplace ${marketplace.name} 添加失败`,
        run: async () => await addMarketplace(marketplace.source, codexOptions),
      })),
      ...installInventory.plugins.map((plugin) => ({
        progress: `正在安装 plugin ${plugin}`,
        success: `plugin ${plugin} 已安装`,
        failure: `plugin ${plugin} 安装失败`,
        run: async () => await addPlugin(plugin, codexOptions),
      })),
    ];
    for (const action of pluginActions) {
      if (action.blocked && pluginFailures > 0) {
        ui.warn(action.blocked);
        continue;
      }
      try {
        await ui.spin(action.progress, action.run);
        ui.success(action.success);
      } catch {
        ui.warn(action.failure);
        pluginFailures += 1;
      }
    }
  }

  if (pluginFailures > 0) {
    ui.done("目标插件清单已保留；修复失败项后重新运行 sync 即可继续");
    return 1;
  }

  await stageAll(gitOptions);
  const finalFiles = await stagedFiles(gitOptions);
  if (finalFiles.length > 0) {
    await commit(commitMessage(finalFiles), gitOptions);
    ui.success("同步清单已保存");
  }

  const configBackup = await applyPortableConfig(
    paths.baseConfig,
    paths.state,
    basePortable,
    desiredPortable,
  );
  if (configBackup) {
    ui.success("可移植设置已应用到本机 Codex");
  }
  if (pluginCheckOk) {
    await rm(pendingInventoryPath, { force: true });
  }

  if (remoteConfigured && remoteAvailable) {
    try {
      await ui.spin("正在上传 Git 更新", async () => {
        await push(gitOptions);
      });
      ui.success("远程仓库已更新");
    } catch {
      ui.error("本地修改已经保存，但暂时无法上传");
      ui.info("没有数据丢失，稍后重新运行 codexkeep sync 即可");
      return 1;
    }
  }

  for (const account of installInventory.accountPlugins) {
    ui.warn(`${account.name} 需要在插件市场安装或登录`);
  }
  if (!pluginCheckOk) {
    ui.done("文件同步完成，但部分插件操作未完成");
    return 1;
  }
  if (!remoteConfigured || !remoteAvailable) {
    ui.done(
      remoteConfigured
        ? "本地配置已保存；远程尚未上传，稍后重新同步即可"
        : "本地配置已保存；连接远程仓库后即可跨设备同步",
    );
    return 1;
  }
  ui.done("同步完成；所有设备可以使用同一份配置");
  return installInventory.accountPlugins.length > 0 ? 1 : 0;
}

function parsePendingPluginSync(raw: string): PendingPluginSync {
  const value = JSON.parse(raw) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("version" in value) ||
    value.version !== 1 ||
    !("base" in value) ||
    !("desired" in value)
  ) {
    throw new Error("pending-plugins.json has an unsupported structure.");
  }
  return {
    version: 1,
    base: parseInventory(JSON.stringify(value.base)),
    desired: parseInventory(JSON.stringify(value.desired)),
  };
}

function serializePendingPluginSync(
  base: PluginInventory,
  desired: PluginInventory,
): string {
  return `${JSON.stringify({ version: 1, base, desired }, null, 2)}\n`;
}

function hasInventoryEntries(inventory: {
  readonly marketplaces: readonly unknown[];
  readonly plugins: readonly unknown[];
  readonly accountPlugins: readonly unknown[];
}): boolean {
  return (
    inventory.marketplaces.length > 0 ||
    inventory.plugins.length > 0 ||
    inventory.accountPlugins.length > 0
  );
}

async function resolvePortableConfig(
  context: AppContext,
  common: string,
  repository: string,
  base: string,
  remote: string | undefined,
): Promise<string | undefined> {
  const repositoryChanged = repository !== common;
  const baseChanged = base !== common;
  let local: string;

  if (repositoryChanged && baseChanged && repository !== base) {
    const choice = await context.ui.choose(
      "可移植设置在仓库文件和本机 Codex 中都被修改过",
      [
        { value: "repository", label: "使用仓库文件" },
        { value: "base", label: "使用本机 Codex 设置" },
        { value: "cancel", label: "取消同步" },
      ],
      "cancel",
    );
    if (choice === "cancel") return undefined;
    local = choice === "repository" ? repository : base;
  } else if (repositoryChanged) {
    local = repository;
  } else if (baseChanged) {
    local = base;
  } else {
    local = repository;
  }

  if (remote === undefined || remote === common || remote === local) {
    return local;
  }
  if (local === common) return remote;

  const choice = await context.ui.choose(
    "可移植设置在本机和远程仓库中都被修改过",
    [
      { value: "local", label: "使用本机设置" },
      { value: "remote", label: "使用远程设置" },
      { value: "cancel", label: "取消同步" },
    ],
    "cancel",
  );
  if (choice === "cancel") return undefined;
  return choice === "local" ? local : remote;
}
