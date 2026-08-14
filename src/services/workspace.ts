import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AppContext } from "../app.js";
import type {
  Marketplace,
  PluginInventory,
} from "../domain/inventory.js";
import {
  emptyInventory,
  missingInventory,
  normalizeInventory,
  readInventoryIfPresent,
  writeInventory,
} from "../domain/inventory.js";
import {
  atomicWrite,
  copyPath,
  fingerprint,
  pathExists,
  readTextIfPresent,
  resolveContentPath,
} from "./files.js";
import { readPortableBaseConfig } from "./config.js";
import { collectCodexInventory } from "./codex.js";

export interface ImportResult {
  readonly actions: readonly string[];
  readonly addToShared: PluginInventory;
  readonly install: PluginInventory;
  readonly warnings: readonly string[];
}

export async function ensureWorkspaceDirectories(root: string): Promise<void> {
  await mkdir(join(root, "skills"), { recursive: true });
  await mkdir(join(root, "codex", "agents"), { recursive: true });
}

export async function createWorkspaceSkeleton(root: string): Promise<void> {
  await ensureWorkspaceDirectories(root);
  await atomicWrite(
    join(root, "skill-lock.json"),
    `${JSON.stringify({ version: 3, skills: {} }, null, 2)}\n`,
  );
  await writeInventory(join(root, "plugins.json"), emptyInventory());
  await atomicWrite(
    join(root, "codex", "AGENTS.md"),
    "# Global Codex instructions\n",
  );
  await atomicWrite(
    join(root, "codex", "codexkeep.config.toml"),
    "# Portable Codex preferences managed by CodexKeep.\n",
  );
  await atomicWrite(join(root, ".gitignore"), ".DS_Store\n");
}

export async function importLocalConfiguration(
  root: string,
  context: AppContext,
  remoteMode: boolean,
): Promise<ImportResult> {
  const actions: string[] = [];
  const warnings: string[] = [];
  const { paths } = context;

  const sources = {
    skills: await installedSource(join(paths.agentsHome, "skills")),
    skillLock: await installedSource(
      join(paths.agentsHome, ".skill-lock.json"),
    ),
    agents: await installedSource(join(paths.codexHome, "agents")),
    agentsMd: await installedSource(join(paths.codexHome, "AGENTS.md")),
  };

  if (sources.skills) {
    actions.push(
      ...(await mergeNamedDirectory(
        sources.skills,
        join(root, "skills"),
        "skill",
        context,
        remoteMode,
      )),
    );
  }
  if (sources.agents) {
    actions.push(
      ...(await mergeNamedDirectory(
        sources.agents,
        join(root, "codex", "agents"),
        "agent",
        context,
        remoteMode,
      )),
    );
  }
  if (sources.agentsMd) {
    const imported = await mergeTextFile(
      sources.agentsMd,
      join(root, "codex", "AGENTS.md"),
      "全局 AGENTS.md",
      context,
      remoteMode,
      (raw) => raw.trim() === "# Global Codex instructions",
    );
    if (imported) actions.push("导入全局 AGENTS.md");
  }

  const portableSource = (await pathExists(paths.baseConfig))
    ? paths.baseConfig
    : undefined;
  if (portableSource) {
    const portable = await readPortableBaseConfig(portableSource);
    if (portable.trim()) {
      const imported = await mergeTextContent(
        portable,
        join(root, "codex", "codexkeep.config.toml"),
        "CodexKeep profile",
        context,
        remoteMode,
        (raw) =>
          !raw.trim() ||
          raw.trim() === "# Portable Codex preferences managed by CodexKeep.",
      );
      if (imported) actions.push("导入可移植 Codex 设置");
    }
  }

  if (sources.skillLock) {
    if (
      await mergeSkillLock(
        sources.skillLock,
        join(root, "skill-lock.json"),
        context,
        remoteMode,
      )
    ) {
      actions.push("合并 skills 来源记录");
    }
  }

  const previousInventory = await readInventoryIfPresent(
    join(root, "plugins.json"),
  );
  const inventories: PluginInventory[] = [previousInventory];
  let localInventory: PluginInventory | undefined;
  try {
    localInventory = await collectCodexInventory({
      env: context.env,
      signal: context.signal,
      paths,
    });
    inventories.push(localInventory);
  } catch (error) {
    warnings.push("暂时无法读取 Codex 插件；初始化会保留已有插件清单。");
  }

  const mergedInventory = await mergeInventoryWithChoices(
    inventories,
    context,
    remoteMode,
  );
  if (JSON.stringify(previousInventory) !== JSON.stringify(mergedInventory)) {
    await writeInventory(join(root, "plugins.json"), mergedInventory);
    actions.push("合并 marketplace 与 plugin 清单");
  }

  return {
    actions,
    addToShared: missingInventory(mergedInventory, previousInventory),
    install: localInventory
      ? missingInventory(mergedInventory, localInventory)
      : emptyInventory(),
    warnings,
  };
}

async function installedSource(path: string): Promise<string | undefined> {
  if (await pathExists(path)) return await resolveContentPath(path);
  return undefined;
}

async function mergeNamedDirectory(
  source: string,
  target: string,
  kind: string,
  context: AppContext,
  remoteMode: boolean,
): Promise<string[]> {
  const actions: string[] = [];
  await mkdir(target, { recursive: true });
  const entries = (await readdir(source)).filter((entry) => entry !== ".DS_Store");
  for (const name of entries.sort()) {
    const sourceEntry = join(source, name);
    const targetEntry = join(target, name);
    if (!(await pathExists(targetEntry))) {
      await copyPath(sourceEntry, targetEntry);
      actions.push(`导入 ${kind}：${name}`);
      continue;
    }
    if ((await fingerprint(sourceEntry)) === (await fingerprint(targetEntry))) {
      continue;
    }
    if (!remoteMode) {
      await rm(targetEntry, { recursive: true, force: true });
      await copyPath(sourceEntry, targetEntry);
      actions.push(`导入本机 ${kind}：${name}`);
      continue;
    }
    const choice = await context.ui.choose(
      `${kind} “${name}” 在本机和仓库中内容不同`,
      [
        { value: "repository", label: "使用仓库版本" },
        { value: "local", label: "保留本机版本" },
        { value: "cancel", label: "取消初始化" },
      ] as const,
      "cancel",
    );
    if (choice === "cancel") throw new Error("Initialization was cancelled.");
    if (choice === "local") {
      await rm(targetEntry, { recursive: true, force: true });
      await copyPath(sourceEntry, targetEntry);
      actions.push(`保留本机 ${kind}：${name}`);
    }
  }
  return actions;
}

async function mergeTextFile(
  source: string,
  target: string,
  label: string,
  context: AppContext,
  remoteMode: boolean,
  isTemplate: (raw: string) => boolean,
): Promise<boolean> {
  return await mergeTextContent(
    await readFile(source, "utf8"),
    target,
    label,
    context,
    remoteMode,
    isTemplate,
  );
}

async function mergeTextContent(
  source: string,
  target: string,
  label: string,
  context: AppContext,
  remoteMode: boolean,
  isTemplate: (raw: string) => boolean,
): Promise<boolean> {
  const existing = (await readTextIfPresent(target)) ?? "";
  if (source === existing) return false;
  if (!remoteMode || isTemplate(existing)) {
    await atomicWrite(target, source);
    return true;
  }
  const choice = await context.ui.choose(
    `${label} 在本机和仓库中内容不同`,
    [
      { value: "repository", label: "使用仓库版本" },
      { value: "local", label: "保留本机版本" },
      { value: "cancel", label: "取消初始化" },
    ] as const,
    "cancel",
  );
  if (choice === "cancel") throw new Error("Initialization was cancelled.");
  if (choice === "local") {
    await atomicWrite(target, source);
    return true;
  }
  return false;
}

async function mergeSkillLock(
  source: string,
  target: string,
  context: AppContext,
  remoteMode: boolean,
): Promise<boolean> {
  const local = parseSkillLock(await readFile(source, "utf8"));
  const repository = parseSkillLock(await readFile(target, "utf8"));
  const merged = { ...repository.skills };

  for (const [name, value] of Object.entries(local.skills)) {
    if (!(name in merged)) {
      merged[name] = value;
      continue;
    }
    if (JSON.stringify(merged[name]) === JSON.stringify(value)) continue;
    if (!remoteMode) {
      merged[name] = value;
      continue;
    }
    const choice = await context.ui.choose(
      `skill “${name}” 的来源记录不同`,
      [
        { value: "repository", label: "使用仓库记录" },
        { value: "local", label: "保留本机记录" },
        { value: "cancel", label: "取消初始化" },
      ] as const,
      "cancel",
    );
    if (choice === "cancel") throw new Error("Initialization was cancelled.");
    if (choice === "local") {
      merged[name] = value;
    }
  }

  const result = {
    ...(remoteMode ? repository : local),
    skills: merged,
  };
  const changed = JSON.stringify(result) !== JSON.stringify(repository);
  if (changed) {
    await atomicWrite(
      target,
      `${JSON.stringify(result, null, 2)}\n`,
    );
  }
  return changed;
}

async function mergeInventoryWithChoices(
  inventories: readonly PluginInventory[],
  context: AppContext,
  remoteMode: boolean,
): Promise<PluginInventory> {
  const marketplaceByName = new Map<string, Marketplace>();
  const plugins = new Set<string>();
  const accounts = new Map<string, { id: string; name: string }>();

  for (const inventory of inventories) {
    for (const marketplace of inventory.marketplaces) {
      const existing = marketplaceByName.get(marketplace.name);
      if (!existing || existing.source === marketplace.source) {
        marketplaceByName.set(marketplace.name, marketplace);
        continue;
      }
      if (!remoteMode) {
        marketplaceByName.set(marketplace.name, marketplace);
        continue;
      }
      const choice = await context.ui.choose(
        `marketplace “${marketplace.name}” 的来源不同`,
        [
          { value: "repository", label: "使用仓库来源" },
          { value: "local", label: "使用本机来源" },
          { value: "cancel", label: "取消初始化" },
        ] as const,
        "cancel",
      );
      if (choice === "cancel") throw new Error("Initialization was cancelled.");
      if (choice === "local") marketplaceByName.set(marketplace.name, marketplace);
    }
    for (const plugin of inventory.plugins) plugins.add(plugin);
    for (const account of inventory.accountPlugins) {
      accounts.set(account.id, account);
    }
  }

  return normalizeInventory({
    version: 1,
    marketplaces: [...marketplaceByName.values()],
    plugins: [...plugins],
    accountPlugins: [...accounts.values()],
  });
}

function parseSkillLock(raw: string): {
  version: number;
  skills: Record<string, unknown>;
  [key: string]: unknown;
} {
  const value = JSON.parse(raw) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("skills" in value) ||
    typeof value.skills !== "object" ||
    value.skills === null ||
    Array.isArray(value.skills)
  ) {
    throw new Error("skill-lock.json has an unsupported structure.");
  }
  return value as {
    version: number;
    skills: Record<string, unknown>;
    [key: string]: unknown;
  };
}
