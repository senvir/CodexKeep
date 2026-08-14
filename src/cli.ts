#!/usr/bin/env node

import { checkCommand } from "./commands/check.js";
import { initCommand } from "./commands/init.js";
import { linkCommand } from "./commands/link.js";
import { remoteCommand } from "./commands/remote.js";
import { syncCommand } from "./commands/sync.js";
import { updateCommand } from "./commands/update.js";
import type { AppContext } from "./app.js";
import { recordTechnicalError } from "./services/diagnostics.js";
import { createPaths } from "./services/paths.js";
import { Ui } from "./ui/index.js";

const VERSION = "0.1.4";

async function main(argv: readonly string[]): Promise<number> {
  const assumeYes = argv.includes("--yes");
  const args = argv.filter((argument) => argument !== "--yes");
  const paths = createPaths(process.env);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);

  const ui = new Ui({
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    assumeYes,
  });
  const context: AppContext = {
    paths,
    ui,
    assumeYes,
    signal: controller.signal,
    env: process.env,
  };

  try {
    if (args.includes("--version") || args[0] === "version") {
      ui.line(VERSION);
      return 0;
    }
    if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
      printHelp(ui);
      return 0;
    }

    let command = args[0];
    if (!command) {
      if (!ui.interactive) {
        printHelp(ui);
        return 0;
      }
      command = await ui.choose(
        "你想做什么？",
        [
          { value: "sync", label: "同步配置" },
          { value: "update", label: "升级并同步" },
          { value: "check", label: "查看状态" },
          { value: "remote", label: "连接或查看远程仓库" },
          { value: "link", label: "连接当前设备" },
          { value: "init", label: "初始化" },
          { value: "exit", label: "退出" },
        ],
        "exit",
      );
    }

    switch (command) {
      case "init":
        if (args.length > 2) return invalidArguments(ui);
        return await initCommand(context, args[1]);
      case "sync":
        if (args.length > 1) return invalidArguments(ui);
        return await syncCommand(context);
      case "remote":
        if (args.length > 2) return invalidArguments(ui);
        return await remoteCommand(context, args[1]);
      case "update":
        if (args.length > 1) return invalidArguments(ui);
        return await updateCommand(context);
      case "link":
        if (args.length > 1) return invalidArguments(ui);
        return await linkCommand(context);
      case "check":
        if (args.length > 1) return invalidArguments(ui);
        return await checkCommand(context);
      case "exit":
        return 0;
      default:
        ui.error(`未知操作：${command}`);
        printHelp(ui);
        return 2;
    }
  } catch (error) {
    await recordTechnicalError(paths.lastError, error).catch(() => undefined);
    if (controller.signal.aborted) {
      ui.error("操作已停止");
      ui.info("已完成的本地内容会保留；尚未开始的步骤不会执行");
      return 130;
    }
    ui.error("操作未完成");
    ui.info("本地内容没有被强制覆盖");
    ui.info("运行 codexkeep check 可查看技术详情");
    return 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

function invalidArguments(ui: Ui): number {
  ui.error("参数不正确");
  printHelp(ui);
  return 2;
}

function printHelp(ui: Ui): void {
  ui.line("CodexKeep");
  ui.line("");
  ui.line("  codexkeep                  打开方向键菜单");
  ui.line("  codexkeep init [git-url]   初始化或连接私人配置仓库");
  ui.line("  codexkeep remote [git-url] 查看或连接私人 Git 仓库");
  ui.line("  codexkeep sync             同步个人 Codex 配置");
  ui.line("  codexkeep update           升级第三方来源并同步");
  ui.line("  codexkeep link             连接当前设备");
  ui.line("  codexkeep check            查看本机状态");
  ui.line("");
  ui.line("Options:");
  ui.line("  --yes      自动确认常规操作，不替用户解决内容冲突");
  ui.line("  --help     显示帮助");
  ui.line("  --version  显示版本");
}

process.exitCode = await main(process.argv.slice(2));
