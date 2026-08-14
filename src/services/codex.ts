import { constants } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { PluginInventory } from "../domain/inventory.js";
import { normalizeInventory } from "../domain/inventory.js";
import type { CodexKeepPaths } from "./paths.js";
import { pathExists } from "./files.js";
import { runProcess } from "./process.js";

const BUILT_IN_MARKETPLACES = new Set([
  "openai-bundled",
  "openai-primary-runtime",
  "openai-curated",
  "openai-templates",
]);

interface CodexOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly paths: CodexKeepPaths;
}

export async function findCodexCommand(
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (env.CODEX_CLI_PATH && (await isExecutable(env.CODEX_CLI_PATH))) {
    return env.CODEX_CLI_PATH;
  }
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "codex");
    if (await isExecutable(candidate)) return candidate;
  }
  const appCommand = "/Applications/ChatGPT.app/Contents/Resources/codex";
  return (await isExecutable(appCommand)) ? appCommand : undefined;
}

export async function collectCodexInventory(
  options: CodexOptions,
): Promise<PluginInventory> {
  const command = await findCodexCommand(options.env);
  if (!command) throw new Error("Codex CLI was not found.");

  const [pluginResult, marketplaceResult, accountPlugins] = await Promise.all([
    runProcess(command, ["plugin", "list", "--json"], {
      env: options.env,
      signal: options.signal,
      timeoutMs: 60_000,
    }),
    runProcess(command, ["plugin", "marketplace", "list", "--json"], {
      env: options.env,
      signal: options.signal,
      timeoutMs: 60_000,
    }),
    collectAccountPlugins(options.paths),
  ]);

  const pluginJson = parseRecord(pluginResult.stdout, "Codex plugin list");
  const marketplaceJson = parseRecord(
    marketplaceResult.stdout,
    "Codex marketplace list",
  );

  const marketplaces = arrayOfRecords(marketplaceJson.marketplaces)
    .map((entry) => {
      const name = typeof entry.name === "string" ? entry.name : "";
      const sourceRecord = isRecord(entry.marketplaceSource)
        ? entry.marketplaceSource
        : undefined;
      const sourceType =
        sourceRecord && typeof sourceRecord.sourceType === "string"
          ? sourceRecord.sourceType
          : "";
      const source =
        sourceRecord && typeof sourceRecord.source === "string"
          ? sourceRecord.source
          : "";
      return { name, sourceType, source };
    })
    .filter(
      (entry) =>
        entry.name &&
        entry.source &&
        entry.sourceType === "git" &&
        !BUILT_IN_MARKETPLACES.has(entry.name),
    )
    .map(({ name, source }) => ({ name, source }));

  const plugins = arrayOfRecords(pluginJson.installed)
    .filter((entry) => entry.installed !== false)
    .map((entry) => ({
      pluginId: typeof entry.pluginId === "string" ? entry.pluginId : "",
      marketplace:
        typeof entry.marketplaceName === "string" ? entry.marketplaceName : "",
    }))
    .filter(
      (entry) =>
        entry.pluginId.includes("@") &&
        entry.marketplace &&
        !BUILT_IN_MARKETPLACES.has(entry.marketplace),
    )
    .map((entry) => entry.pluginId);

  return normalizeInventory({
    version: 1,
    marketplaces,
    plugins,
    accountPlugins,
  });
}

export async function addMarketplace(
  source: string,
  options: CodexOptions,
): Promise<void> {
  await runCodex(["plugin", "marketplace", "add", "--json", "--", source], options);
}

export async function addPlugin(
  plugin: string,
  options: CodexOptions,
): Promise<void> {
  await runCodex(["plugin", "add", "--json", "--", plugin], options);
}

export async function removeMarketplace(
  marketplace: string,
  options: CodexOptions,
): Promise<void> {
  await runCodex(
    ["plugin", "marketplace", "remove", "--json", "--", marketplace],
    options,
  );
}

export async function removePlugin(
  plugin: string,
  options: CodexOptions,
): Promise<void> {
  await runCodex(["plugin", "remove", "--json", "--", plugin], options);
}

export async function upgradeMarketplaces(
  options: CodexOptions,
): Promise<void> {
  await runCodex(["plugin", "marketplace", "upgrade"], {
    ...options,
    timeoutMs: 180_000,
  });
}

export async function updateGlobalSkills(
  options: CodexOptions,
): Promise<void> {
  await runProcess("npx", ["--yes", "skills", "update", "-g"], {
    env: options.env,
    signal: options.signal,
    timeoutMs: 300_000,
  });
}

async function runCodex(
  args: readonly string[],
  options: CodexOptions & { readonly timeoutMs?: number },
): Promise<void> {
  const command = await findCodexCommand(options.env);
  if (!command) throw new Error("Codex CLI was not found.");
  await runProcess(command, args, {
    env: options.env,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 120_000,
  });
}

async function collectAccountPlugins(
  paths: CodexKeepPaths,
): Promise<{ id: string; name: string }[]> {
  const root = join(
    paths.codexHome,
    "plugins",
    "cache",
    "openai-curated-remote",
  );
  if (!(await pathExists(root))) return [];

  const result: { id: string; name: string }[] = [];
  for (const accountId of await safeDirectories(root)) {
    if (BUILT_IN_MARKETPLACES.has(accountId)) continue;
    const accountRoot = join(root, accountId);
    const marker = join(accountRoot, ".codex-remote-plugin-install.json");
    if (!(await pathExists(marker))) continue;
    const name = await findAccountDisplayName(accountRoot, accountId);
    result.push({ id: accountId, name });
  }
  return result;
}

async function findAccountDisplayName(
  accountRoot: string,
  fallback: string,
): Promise<string> {
  for (const version of await safeDirectories(accountRoot)) {
    const manifest = join(
      accountRoot,
      version,
      ".codex-plugin",
      "plugin.json",
    );
    try {
      const parsed = JSON.parse(await readFile(manifest, "utf8")) as unknown;
      if (
        isRecord(parsed) &&
        isRecord(parsed.interface) &&
        typeof parsed.interface.displayName === "string"
      ) {
        return parsed.interface.displayName;
      }
    } catch {
      // A missing or changing cache manifest should not break inventory discovery.
    }
  }
  return fallback;
}

async function safeDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function parseRecord(raw: string, label: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    if (isRecord(value)) return value;
  } catch {
    // Fall through to a stable error.
  }
  throw new Error(`${label} returned an unsupported response.`);
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
