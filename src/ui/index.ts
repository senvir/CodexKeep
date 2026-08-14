import {
  cancel,
  confirm,
  intro,
  isCancel,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import { styleText } from "node:util";

export interface DiffLine {
  readonly type: "add" | "remove";
  readonly text: string;
}

export interface Choice<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly hint?: string;
}

export interface UiOptions {
  readonly interactive: boolean;
  readonly assumeYes: boolean;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
}

export class Ui {
  readonly interactive: boolean;
  readonly assumeYes: boolean;
  private readonly stdout: NodeJS.WritableStream;
  private readonly stderr: NodeJS.WritableStream;

  constructor(options: UiOptions) {
    this.interactive = options.interactive;
    this.assumeYes = options.assumeYes;
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
  }

  title(name: string, subtitle?: string): void {
    if (this.interactive) {
      intro(subtitle ? `${name} · ${subtitle}` : name);
      return;
    }
    this.line(name);
    if (subtitle) this.line(subtitle);
  }

  line(message = ""): void {
    this.stdout.write(`${message}\n`);
  }

  info(message: string): void {
    this.line(`• ${message}`);
  }

  success(message: string): void {
    this.line(`✓ ${message}`);
  }

  warn(message: string): void {
    this.line(`! ${message}`);
  }

  error(message: string): void {
    this.stderr.write(`× ${message}\n`);
  }

  done(message: string): void {
    if (this.interactive) {
      outro(message);
    } else {
      this.line(message);
    }
  }

  cancelled(message = "已取消，没有修改任何内容。"): void {
    if (this.interactive) {
      cancel(message);
    } else {
      this.line(message);
    }
  }

  list(lines: readonly string[]): void {
    for (const line of lines) this.line(`  + ${line}`);
  }

  diff(lines: readonly DiffLine[]): void {
    const isTTY = (this.stdout as NodeJS.WriteStream).isTTY === true;
    for (const line of lines) {
      const marker = line.type === "add" ? "+" : "-";
      const styledMarker = isTTY
        ? styleText(line.type === "add" ? "green" : "red", marker, {
            stream: this.stdout,
          })
        : marker;
      this.line(`  ${styledMarker} ${line.text}`);
    }
  }

  async confirm(message: string): Promise<boolean> {
    if (this.assumeYes) return true;
    if (!this.interactive) return false;
    const result = await confirm({ message });
    if (isCancel(result)) {
      this.cancelled();
      return false;
    }
    return result;
  }

  async choose<T extends string>(
    message: string,
    choices: readonly Choice<T>[],
    fallback: T,
  ): Promise<T> {
    if (!this.interactive) return fallback;
    const result = await select<string>({
      message,
      options: choices.map((choice) =>
        choice.hint === undefined
          ? { value: choice.value, label: choice.label }
          : {
              value: choice.value,
              label: choice.label,
              hint: choice.hint,
            },
      ),
    });
    if (isCancel(result)) {
      this.cancelled();
      return fallback;
    }
    return result as T;
  }

  async input(
    message: string,
    placeholder?: string,
  ): Promise<string | undefined> {
    if (!this.interactive) return undefined;
    const result = await text({ message, placeholder });
    if (isCancel(result)) {
      this.cancelled();
      return undefined;
    }
    const value = result.trim();
    return value || undefined;
  }

  async spin<T>(message: string, action: () => Promise<T>): Promise<T> {
    if (!this.interactive) {
      this.info(message);
      return await action();
    }

    const progress = spinner();
    progress.start(message);
    try {
      const result = await action();
      progress.stop(message.replace(/^正在/, "") + "完成");
      return result;
    } catch (error) {
      progress.stop(message.replace(/^正在/, "") + "未完成");
      throw error;
    }
  }
}
