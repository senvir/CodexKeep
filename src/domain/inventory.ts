import { readFile } from "node:fs/promises";
import { atomicWrite, readTextIfPresent } from "../services/files.js";

export const INVENTORY_VERSION = 1 as const;

export interface Marketplace {
  readonly name: string;
  readonly source: string;
}

export interface AccountPlugin {
  readonly id: string;
  readonly name: string;
}

export interface PluginInventory {
  readonly version: typeof INVENTORY_VERSION;
  readonly marketplaces: readonly Marketplace[];
  readonly plugins: readonly string[];
  readonly accountPlugins: readonly AccountPlugin[];
}

export interface InventoryReconciliation {
  readonly desired: PluginInventory;
  readonly ambiguous: PluginInventory;
  readonly install: PluginInventory;
  readonly remove: PluginInventory;
}

export interface InventoryOperations {
  readonly install: PluginInventory;
  readonly remove: PluginInventory;
}

export function emptyInventory(): PluginInventory {
  return {
    version: INVENTORY_VERSION,
    marketplaces: [],
    plugins: [],
    accountPlugins: [],
  };
}

export function parseInventory(raw: string): PluginInventory {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `plugins.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(value) || value.version !== INVENTORY_VERSION) {
    throw new Error("plugins.json uses an unsupported schema version.");
  }

  const marketplaces = arrayOfRecords(value.marketplaces, "marketplaces").map(
    (entry) => {
      const name = requiredString(entry.name, "marketplace name");
      const source = requiredString(entry.source, "marketplace source");
      if (!isSafeGitSource(source)) {
        throw new Error(`Marketplace ${name} has an unsafe or unsupported source.`);
      }
      return { name, source };
    },
  );
  const plugins = arrayOfStrings(value.plugins, "plugins").map((plugin) => {
    if (!/^[^\s@]+@[^\s@]+$/.test(plugin)) {
      throw new Error(`Invalid plugin identifier: ${plugin}`);
    }
    return plugin;
  });
  const accountPlugins = arrayOfRecords(
    value.accountPlugins,
    "accountPlugins",
  ).map((entry) => ({
    id: requiredString(entry.id, "account plugin id"),
    name: requiredString(entry.name, "account plugin name"),
  }));

  return normalizeInventory({
    version: INVENTORY_VERSION,
    marketplaces,
    plugins,
    accountPlugins,
  });
}

export function normalizeInventory(
  inventory: PluginInventory,
): PluginInventory {
  const marketplaces = deduplicateBy(
    inventory.marketplaces,
    (entry) => entry.name,
  ).sort((a, b) => a.name.localeCompare(b.name, "en"));
  const plugins = [...new Set(inventory.plugins)].sort((a, b) =>
    a.localeCompare(b, "en"),
  );
  const accountPlugins = deduplicateBy(
    inventory.accountPlugins,
    (entry) => entry.id,
  ).sort((a, b) => a.id.localeCompare(b.id, "en"));

  return {
    version: INVENTORY_VERSION,
    marketplaces,
    plugins,
    accountPlugins,
  };
}

export function mergeInventories(
  ...inventories: readonly PluginInventory[]
): PluginInventory {
  return normalizeInventory({
    version: INVENTORY_VERSION,
    marketplaces: inventories.flatMap((inventory) => inventory.marketplaces),
    plugins: inventories.flatMap((inventory) => inventory.plugins),
    accountPlugins: inventories.flatMap(
      (inventory) => inventory.accountPlugins,
    ),
  });
}

export function mergeInventoryChanges(
  base: PluginInventory,
  local: PluginInventory,
  remote: PluginInventory,
): PluginInventory {
  const marketplaceByName = mergeEntryChanges(
    base.marketplaces,
    local.marketplaces,
    remote.marketplaces,
    (entry) => entry.name,
  );
  const pluginNames = new Set(
    [base, local, remote].flatMap((inventory) => inventory.plugins),
  );

  return normalizeInventory({
    version: INVENTORY_VERSION,
    marketplaces: [...marketplaceByName.values()],
    plugins: [...pluginNames].filter((plugin) =>
      mergeChange(
        base.plugins.includes(plugin),
        local.plugins.includes(plugin),
        remote.plugins.includes(plugin),
        plugin,
      ),
    ),
    accountPlugins: [base, local, remote].flatMap(
      (inventory) => inventory.accountPlugins,
    ),
  });
}

export function reconcileInventory(
  common: PluginInventory,
  shared: PluginInventory,
  local: PluginInventory,
  resolution?: "shared" | "local",
): InventoryReconciliation {
  const commonMarketplaces = new Map(
    common.marketplaces.map((entry) => [entry.name, entry]),
  );
  const sharedMarketplaces = new Map(
    shared.marketplaces.map((entry) => [entry.name, entry]),
  );
  const localMarketplaces = new Map(
    local.marketplaces.map((entry) => [entry.name, entry]),
  );
  for (const [name, installed] of localMarketplaces) {
    const expected = sharedMarketplaces.get(name);
    if (expected && expected.source !== installed.source) {
      throw new Error(`Conflicting inventory entries: ${name}`);
    }
  }

  const localAdditions = normalizeInventory({
    version: INVENTORY_VERSION,
    marketplaces: local.marketplaces.filter(
      (entry) => !commonMarketplaces.has(entry.name),
    ),
    plugins: local.plugins.filter((plugin) => !common.plugins.includes(plugin)),
    accountPlugins: local.accountPlugins,
  });
  const marketplaceCandidates = [
    ...shared.marketplaces,
    ...local.marketplaces,
  ];
  let desired = withReferencedMarketplaces(
    mergeInventories(shared, localAdditions),
    marketplaceCandidates,
  );
  const localPlugins = new Set(local.plugins);
  const ambiguous = normalizeInventory({
    version: INVENTORY_VERSION,
    marketplaces: shared.marketplaces.filter((entry) => {
      const previous = commonMarketplaces.get(entry.name);
      return (
        previous?.source === entry.source && !localMarketplaces.has(entry.name)
      );
    }),
    plugins: shared.plugins.filter(
      (plugin) => common.plugins.includes(plugin) && !localPlugins.has(plugin),
    ),
    accountPlugins: [],
  });

  if (resolution === "local") {
    desired = withReferencedMarketplaces(
      subtractInventory(desired, ambiguous),
      marketplaceCandidates,
    );
  }

  const { install, remove } = inventoryOperations(desired, local);

  return { desired, ambiguous, install, remove };
}

export function inventoryOperations(
  desired: PluginInventory,
  local: PluginInventory,
): InventoryOperations {
  const install = missingInventory(desired, local);
  const rawRemove = missingInventory(local, desired);
  const referencedMarketplaces = new Set(desired.plugins.map(pluginMarketplace));
  const remove = normalizeInventory({
    ...rawRemove,
    marketplaces: rawRemove.marketplaces.filter(
      (entry) => !referencedMarketplaces.has(entry.name),
    ),
    accountPlugins: [],
  });
  return { install, remove };
}

export async function readInventory(path: string): Promise<PluginInventory> {
  return parseInventory(await readFile(path, "utf8"));
}

export async function readInventoryIfPresent(
  path: string,
): Promise<PluginInventory> {
  const raw = await readTextIfPresent(path);
  return raw === undefined ? emptyInventory() : parseInventory(raw);
}

export async function writeInventory(
  path: string,
  inventory: PluginInventory,
): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(normalizeInventory(inventory), null, 2)}\n`);
}

export function inventoryEquals(
  left: PluginInventory,
  right: PluginInventory,
): boolean {
  return JSON.stringify(normalizeInventory(left)) === JSON.stringify(normalizeInventory(right));
}

export function missingInventory(
  expected: PluginInventory,
  current: PluginInventory,
): PluginInventory {
  const currentMarketplaces = new Set(
    current.marketplaces.map((entry) => entry.name),
  );
  const currentPlugins = new Set(current.plugins);
  const currentAccounts = new Set(
    current.accountPlugins.map((entry) => entry.id),
  );

  return normalizeInventory({
    version: INVENTORY_VERSION,
    marketplaces: expected.marketplaces.filter(
      (entry) => !currentMarketplaces.has(entry.name),
    ),
    plugins: expected.plugins.filter((entry) => !currentPlugins.has(entry)),
    accountPlugins: expected.accountPlugins.filter(
      (entry) => !currentAccounts.has(entry.id),
    ),
  });
}

function subtractInventory(
  inventory: PluginInventory,
  removed: PluginInventory,
): PluginInventory {
  const marketplaces = new Set(removed.marketplaces.map((entry) => entry.name));
  const plugins = new Set(removed.plugins);
  const accounts = new Set(removed.accountPlugins.map((entry) => entry.id));
  return normalizeInventory({
    version: INVENTORY_VERSION,
    marketplaces: inventory.marketplaces.filter(
      (entry) => !marketplaces.has(entry.name),
    ),
    plugins: inventory.plugins.filter((entry) => !plugins.has(entry)),
    accountPlugins: inventory.accountPlugins.filter(
      (entry) => !accounts.has(entry.id),
    ),
  });
}

function withReferencedMarketplaces(
  inventory: PluginInventory,
  candidates: readonly Marketplace[],
): PluginInventory {
  const marketplaces = new Map(
    inventory.marketplaces.map((entry) => [entry.name, entry]),
  );
  const available = new Map(candidates.map((entry) => [entry.name, entry]));
  for (const plugin of inventory.plugins) {
    const name = pluginMarketplace(plugin);
    if (marketplaces.has(name)) continue;
    const marketplace = available.get(name);
    if (!marketplace) {
      throw new Error(`Missing marketplace for plugin: ${plugin}`);
    }
    marketplaces.set(name, marketplace);
  }
  return normalizeInventory({
    ...inventory,
    marketplaces: [...marketplaces.values()],
  });
}

function mergeEntryChanges<T>(
  base: readonly T[],
  local: readonly T[],
  remote: readonly T[],
  key: (entry: T) => string,
): Map<string, T> {
  const baseEntries = new Map(base.map((entry) => [key(entry), entry]));
  const localEntries = new Map(local.map((entry) => [key(entry), entry]));
  const remoteEntries = new Map(remote.map((entry) => [key(entry), entry]));
  const names = new Set([
    ...baseEntries.keys(),
    ...localEntries.keys(),
    ...remoteEntries.keys(),
  ]);
  const result = new Map<string, T>();
  for (const name of names) {
    const merged = mergeChange(
      baseEntries.get(name),
      localEntries.get(name),
      remoteEntries.get(name),
      name,
    );
    if (merged !== undefined) result.set(name, merged);
  }
  return result;
}

function mergeChange<T>(base: T, local: T, remote: T, label: string): T {
  if (sameValue(local, remote)) return local;
  if (sameValue(local, base)) return remote;
  if (sameValue(remote, base)) return local;
  throw new Error(`Conflicting inventory changes: ${label}`);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pluginMarketplace(plugin: string): string {
  return plugin.slice(plugin.lastIndexOf("@") + 1);
}

function isSafeGitSource(source: string): boolean {
  if (source.startsWith("-") || /[\r\n\0]/u.test(source)) return false;
  if (/^[\w.-]+@[\w.-]+:[^\s]+$/u.test(source)) return true;
  try {
    const url = new URL(source);
    return (
      ["https:", "ssh:", "git:"].includes(url.protocol) &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return /^[\w.-]+\/[\w.-]+(?:@[\w./-]+)?$/u.test(source);
  }
}

function deduplicateBy<T>(
  values: readonly T[],
  key: (value: T) => string,
): T[] {
  const result = new Map<string, T>();
  for (const value of values) {
    const identifier = key(value);
    const existing = result.get(identifier);
    if (
      existing !== undefined &&
      JSON.stringify(existing) !== JSON.stringify(value)
    ) {
      throw new Error(`Conflicting inventory entries: ${identifier}`);
    }
    result.set(identifier, value);
  }
  return [...result.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayOfRecords(
  value: unknown,
  label: string,
): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error(`plugins.json ${label} must be an array of objects.`);
  }
  return value;
}

function arrayOfStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`plugins.json ${label} must be an array of strings.`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing ${label} in plugins.json.`);
  }
  return value.trim();
}
