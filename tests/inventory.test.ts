import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyInventory,
  mergeInventoryChanges,
  mergeInventories,
  missingInventory,
  parseInventory,
  reconcileInventory,
} from "../src/domain/inventory.js";

test("normalizes merged inventories and reports missing local items", () => {
  const repository = parseInventory(`{
    "version": 1,
    "marketplaces": [{"name":"custom","source":"https://example.com/custom.git"}],
    "plugins": ["demo@custom"],
    "accountPlugins": []
  }`);
  const remote = parseInventory(`{
    "version": 1,
    "marketplaces": [{"name":"other","source":"git@github.com:example/other.git"}],
    "plugins": ["other@other"],
    "accountPlugins": [{"id":"github","name":"GitHub"}]
  }`);
  const merged = mergeInventories(repository, remote);
  const missing = missingInventory(merged, repository);

  assert.deepEqual(missing.marketplaces, [
    { name: "other", source: "git@github.com:example/other.git" },
  ]);
  assert.deepEqual(missing.plugins, ["other@other"]);
  assert.deepEqual(missing.accountPlugins, [{ id: "github", name: "GitHub" }]);
});

test("rejects credentials and query strings in marketplace sources", () => {
  assert.throws(
    () =>
      parseInventory(`{
        "version": 1,
        "marketplaces": [{"name":"bad","source":"https://user:token@example.com/repo.git?key=x"}],
        "plugins": [],
        "accountPlugins": []
      }`),
    /unsafe or unsupported source/u,
  );
});

test("rejects conflicting marketplace names", () => {
  const left = {
    ...emptyInventory(),
    marketplaces: [
      { name: "custom", source: "https://example.com/one.git" },
    ],
  };
  const right = {
    ...emptyInventory(),
    marketplaces: [
      { name: "custom", source: "https://example.com/two.git" },
    ],
  };
  assert.throws(() => mergeInventories(left, right), /Conflicting inventory/u);
});

test("propagates remote inventory deletions with a three-way merge", () => {
  const base = parseInventory(`{
    "version": 1,
    "marketplaces": [{"name":"custom","source":"https://example.com/custom.git"}],
    "plugins": ["demo@custom"],
    "accountPlugins": []
  }`);

  assert.deepEqual(
    mergeInventoryChanges(base, base, emptyInventory()),
    emptyInventory(),
  );
});

test("combines an independent local deletion and remote addition", () => {
  const base = parseInventory(`{
    "version": 1,
    "marketplaces": [{"name":"custom","source":"https://example.com/custom.git"}],
    "plugins": ["old@custom"],
    "accountPlugins": []
  }`);
  const local = parseInventory(`{
    "version": 1,
    "marketplaces": [{"name":"custom","source":"https://example.com/custom.git"}],
    "plugins": [],
    "accountPlugins": []
  }`);
  const remote = parseInventory(`{
    "version": 1,
    "marketplaces": [{"name":"custom","source":"https://example.com/custom.git"}],
    "plugins": ["old@custom", "new@custom"],
    "accountPlugins": []
  }`);

  assert.deepEqual(mergeInventoryChanges(base, local, remote).plugins, [
    "new@custom",
  ]);
});

test("treats a missing stable local plugin as an explicit deletion choice", () => {
  const shared = parseInventory(`{
    "version": 1,
    "marketplaces": [{"name":"stitch-skills","source":"https://example.com/stitch.git"}],
    "plugins": ["stitch-build@stitch-skills"],
    "accountPlugins": []
  }`);

  const unresolved = reconcileInventory(shared, shared, emptyInventory());
  assert.deepEqual(unresolved.ambiguous, shared);

  const adopted = reconcileInventory(
    shared,
    shared,
    emptyInventory(),
    "local",
  );
  assert.deepEqual(adopted.desired, emptyInventory());
  assert.deepEqual(adopted.install, emptyInventory());

  const restored = reconcileInventory(
    shared,
    shared,
    emptyInventory(),
    "shared",
  );
  assert.deepEqual(restored.install, shared);
});

test("keeps a marketplace required by a concurrent local plugin addition", () => {
  const common = parseInventory(`{
    "version": 1,
    "marketplaces": [{"name":"custom","source":"https://example.com/custom.git"}],
    "plugins": ["old@custom"],
    "accountPlugins": []
  }`);
  const local = parseInventory(`{
    "version": 1,
    "marketplaces": [{"name":"custom","source":"https://example.com/custom.git"}],
    "plugins": ["new@custom"],
    "accountPlugins": []
  }`);

  const reconciled = reconcileInventory(common, emptyInventory(), local);
  assert.deepEqual(reconciled.desired, local);
});
