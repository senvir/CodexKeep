import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Ui } from "../src/ui/index.js";

test("renders colored inventory diffs only for interactive TTY output", () => {
  const terminal = new PassThrough() as PassThrough & {
    isTTY: boolean;
    getColorDepth: () => number;
    hasColors: () => boolean;
  };
  terminal.isTTY = true;
  terminal.getColorDepth = () => 8;
  terminal.hasColors = () => true;
  const interactive = new Ui({ interactive: true, assumeYes: false, stdout: terminal });

  interactive.diff([
    { type: "add", text: "安装 plugin：demo@custom" },
    { type: "remove", text: "卸载 plugin：old@custom" },
  ]);
  const colored = terminal.read().toString();
  assert.match(colored, /\u001b\[32m\+\u001b\[39m/u);
  assert.match(colored, /\u001b\[31m-\u001b\[39m/u);
  assert.equal(
    stripVTControlCharacters(colored),
    "  + 安装 plugin：demo@custom\n  - 卸载 plugin：old@custom\n",
  );

  const pipe = new PassThrough();
  const noninteractive = new Ui({ interactive: false, assumeYes: true, stdout: pipe });
  noninteractive.diff([{ type: "remove", text: "移除 marketplace：custom" }]);
  const plain = pipe.read().toString();
  assert.equal(plain, "  - 移除 marketplace：custom\n");
  assert.doesNotMatch(plain, /\u001b\[/u);
});
