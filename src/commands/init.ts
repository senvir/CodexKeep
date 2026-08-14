import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../app.js";
import {
  applyPortableConfig,
  extractPortableConfig,
} from "../services/config.js";
import {
  atomicWrite,
  movePath,
  pathExists,
  readTextIfPresent,
} from "../services/files.js";
import {
  addOrigin,
  cloneRepository,
  commit,
  initializeRepository,
  probeRemote,
  stageAll,
  stagedFiles,
} from "../services/git.js";
import {
  applyLinks,
  inspectLinks,
  validateConfigRepository,
} from "../services/links.js";
import { linkSpecs } from "../services/paths.js";
import {
  createWorkspaceSkeleton,
  ensureWorkspaceDirectories,
  importLocalConfiguration,
} from "../services/workspace.js";
import { syncCommand } from "./sync.js";

export async function initCommand(
  context: AppContext,
  remote?: string,
): Promise<number> {
  const { ui, paths } = context;
  ui.title("CodexKeep Init", "初始化私人配置");

  if (await pathExists(paths.repo)) {
    ui.error(`${paths.repo} 已经存在`);
    ui.info("如需重新连接当前设备，请运行 codexkeep link");
    return 1;
  }

  let selectedRemote = remote;
  if (!selectedRemote && ui.interactive) {
    const mode = await ui.choose(
      "配置保存在哪里？",
      [
        {
          value: "remote",
          label: "连接私人 Git 仓库",
          hint: "推荐，可在设备间同步",
        },
        { value: "local", label: "暂时只保存在本机" },
      ],
      "local",
    );
    if (mode === "remote") {
      selectedRemote = await ui.input(
        "私人 Git 仓库地址",
        "git@github.com:your-name/codexkeep-config.git",
      );
      if (!selectedRemote) {
        ui.cancelled("未提供 Git 仓库地址，没有修改任何内容。");
        return 0;
      }
    }
  }

  let remoteState: "empty" | "populated" | undefined;
  if (selectedRemote) {
    try {
      remoteState = await ui.spin("正在检查远程仓库", async () =>
        await probeRemote(selectedRemote, context.env, context.signal),
      );
    } catch {
      ui.error("无法连接这个 Git 仓库，初始化未开始");
      ui.info("请确认地址、访问权限和网络连接");
      return 1;
    }
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "codexkeep-init-"));
  const workspace = join(temporaryRoot, "config");

  try {
    if (selectedRemote && remoteState === "populated") {
      await ui.spin("正在验证私人 Git 仓库", async () => {
        await cloneRepository(
          selectedRemote,
          workspace,
          context.env,
          context.signal,
        );
      });
      await ensureWorkspaceDirectories(workspace);
      try {
        await validateConfigRepository(linkSpecs({ ...paths, repo: workspace }));
      } catch {
        ui.error("这个仓库不是有效的 CodexKeep 配置仓库");
        ui.info("本机原配置没有变化");
        return 1;
      }
    } else {
      await createWorkspaceSkeleton(workspace);
      await initializeRepository(workspace, context.env, context.signal);
      if (selectedRemote) {
        await addOrigin(selectedRemote, {
          cwd: workspace,
          env: context.env,
          signal: context.signal,
        });
      }
    }

    const imported = await ui.spin("正在发现本机 Codex 配置", async () =>
      await importLocalConfiguration(
        workspace,
        context,
        remoteState === "populated",
      ),
    );

    const temporarySpecs = linkSpecs({ ...paths, repo: workspace });
    await validateConfigRepository(temporarySpecs);
    const finalSpecs = linkSpecs(paths);
    const linkStatus = await inspectLinks(temporarySpecs);
    const adopted = linkStatus.filter((entry) => entry.state === "conflict");
    const missing = linkStatus.filter((entry) => entry.state === "missing");

    const basePortable = extractPortableConfig(
      (await readTextIfPresent(paths.baseConfig)) ?? "",
    );
    const desiredPortable = extractPortableConfig(
      (await readTextIfPresent(
        join(workspace, "codex", "codexkeep.config.toml"),
      )) ?? "",
    );

    const plan = [
      ...(remoteState === "populated"
        ? ["使用已验证的 CodexKeep 私人仓库"]
        : selectedRemote
          ? ["创建配置仓库并连接私人 Git 仓库"]
          : ["创建本地私人 Git 仓库"]),
      ...imported.actions,
      ...(adopted.length > 0
        ? [`备份并接管 ${adopted.length} 项现有官方路径`]
        : []),
      ...(missing.length > 0
        ? [`建立 ${missing.length} 项官方路径连接`]
        : []),
      ...(basePortable === desiredPortable
        ? []
        : ["将仓库中的可移植设置应用到 Codex config.toml"]),
    ];

    ui.line("将进行以下初始化：");
    ui.list(plan);
    ui.diff([
      ...imported.addToShared.marketplaces.map((entry) => ({
        type: "add" as const,
        text: `${selectedRemote ? "加入共享清单" : "写入清单"} marketplace：${entry.name}`,
      })),
      ...imported.addToShared.plugins.map((entry) => ({
        type: "add" as const,
        text: `${selectedRemote ? "加入共享清单" : "写入清单"} plugin：${entry}`,
      })),
      ...imported.addToShared.accountPlugins.map((entry) => ({
        type: "add" as const,
        text: `记录 account plugin：${entry.name}（其他设备需手动安装或登录）`,
      })),
      ...imported.install.marketplaces.map((entry) => ({
        type: "add" as const,
        text: `添加 marketplace：${entry.name}`,
      })),
      ...imported.install.plugins.map((entry) => ({
        type: "add" as const,
        text: `安装 plugin：${entry}`,
      })),
    ]);
    for (const warning of imported.warnings) ui.warn(warning);
    if (!(await ui.confirm("开始初始化？"))) {
      ui.cancelled();
      return 0;
    }

    await stageAll({
      cwd: workspace,
      env: context.env,
      signal: context.signal,
    });
    const staged = await stagedFiles({
      cwd: workspace,
      env: context.env,
      signal: context.signal,
    });
    if (staged.length > 0) {
      try {
        await commit(
          remoteState === "populated"
            ? "chore: import local Codex config"
            : "chore: initialize CodexKeep",
          {
            cwd: workspace,
            env: context.env,
            signal: context.signal,
          },
        );
      } catch {
        ui.warn("Git 尚未提交；配置会保留，设置 Git 身份后运行 codexkeep sync");
      }
    }

    await movePath(workspace, paths.repo);
    let configBackup: string | undefined;
    const baseConfigExisted = await pathExists(paths.baseConfig);
    try {
      configBackup = await applyPortableConfig(
        paths.baseConfig,
        paths.state,
        basePortable,
        desiredPortable,
      );
      const linked = await applyLinks(finalSpecs, paths.state, true);
      for (const target of linked.created) ui.success(`已连接 ${target}`);
      if (linked.backupDir) {
        ui.info(`原配置已备份到 ${linked.backupDir}`);
      }
    } catch (error) {
      if (configBackup) {
        const original = await readFile(configBackup);
        if (baseConfigExisted) {
          await atomicWrite(paths.baseConfig, original);
        } else {
          await rm(paths.baseConfig, { force: true });
        }
      }
      const recovery = join(
        paths.state,
        `failed-init-${new Date().toISOString().replaceAll(":", "-")}`,
      );
      await movePath(paths.repo, recovery);
      ui.error("初始化未完成，原配置已经恢复");
      ui.info(`新仓库内容保存在 ${recovery}`);
      return 1;
    }

    if (selectedRemote) {
      ui.success("本机初始化完成");
      return await syncCommand(context, {
        confirmationAlreadySatisfied: true,
        restoreRepositoryInventory: remoteState === "populated",
        showTitle: false,
      });
    }
    ui.done("初始化完成；运行 codexkeep remote 可连接私人 Git 仓库");
    return 0;
  } catch (error) {
    if (error instanceof Error && /cancelled/iu.test(error.message)) {
      ui.cancelled();
      return 0;
    }
    ui.error("初始化未开始，本机原配置没有变化");
    ui.info("运行 codexkeep check 可查看本机状态");
    return 1;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
