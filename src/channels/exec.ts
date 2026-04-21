import { exec } from "node:child_process";
import fs from "node:fs";
import type { Channel, ChannelContext } from "./channel.js";
import type { ExecCommandConfig, ExecActionConfig } from "../config.js";

function runCommand(cmd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs, shell: "/bin/bash" }, (err, stdout, stderr) => {
      resolve({
        stdout: (stdout ?? "").trim(),
        stderr: (stderr ?? "").trim(),
        code: err ? (err as NodeJS.ErrnoException).code ? 1 : 1 : 0,
      });
    });
  });
}

function loadTemplate(action: ExecActionConfig): string | null {
  if (action.template) return action.template;
  if (action.template_file) {
    try {
      return fs.readFileSync(action.template_file, "utf-8");
    } catch {
      return null;
    }
  }
  return null;
}

function renderTemplate(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(vars[key] ?? ""));
}

function buildHelpText(name: string, config: ExecCommandConfig): string {
  const lines = [config.help || name];
  if (config.subcommands) {
    const subs = Object.keys(config.subcommands).join(", ");
    lines.push(`  子命令: ${subs}`);
  }
  lines.push(`  用法: /${name} [子命令] [参数]`);
  return lines.join("\n");
}

export class ExecChannel implements Channel {
  readonly name: string;
  private config: ExecCommandConfig;

  constructor(name: string, config: ExecCommandConfig) {
    this.name = name;
    this.config = config;
  }

  async start(ctx: ChannelContext): Promise<void> {
    ctx.onCommand(this.name, async (_userId: string, args: string) => {
      // Parse subcommand
      const firstSpace = args.indexOf(" ");
      const sub = firstSpace === -1 ? args.trim() : args.slice(0, firstSpace).trim();
      const restArgs = firstSpace === -1 ? "" : args.slice(firstSpace + 1).trim();

      let action: ExecActionConfig;
      let actualArgs: string;
      if (sub && this.config.subcommands?.[sub]) {
        action = this.config.subcommands[sub];
        actualArgs = restArgs;
      } else {
        action = this.config.default;
        actualArgs = args.trim();
      }

      // Replace {{args}} in command string
      const cmd = action.command.replace(/\{\{args\}\}/g, actualArgs);

      ctx.debug(`exec: ${cmd}`);
      const timeoutMs = (this.config.timeout ?? 10) * 1000;

      try {
        const { stdout, stderr, code } = await runCommand(cmd, timeoutMs);

        // Build template vars: base fields + JSON-parsed stdout fields
        const vars: Record<string, string | number> = { stdout, stderr, args: actualArgs, code };
        try {
          // Try full stdout first; if it fails, extract the first JSON array/object
          let jsonStr = stdout;
          try { JSON.parse(jsonStr); } catch {
            const match = stdout.match(/(\[[\s\S]*\]|\{[\s\S]*\})\s*$/);
            if (match) jsonStr = match[1];
          }
          const json = JSON.parse(jsonStr) as unknown;
          if (Array.isArray(json) && action.item_template) {
            const sep = action.item_separator ?? "\n";
            vars.items = json.map((item: Record<string, unknown>) => {
              const itemVars: Record<string, string | number> = {};
              for (const [k, v] of Object.entries(item)) {
                itemVars[k] = Array.isArray(v) ? v.join(", ") : v == null ? "" : String(v);
              }
              return renderTemplate(action.item_template!, itemVars);
            }).join(sep);
          } else if (json && typeof json === "object" && !Array.isArray(json)) {
            for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
              if (!(k in vars)) vars[k] = v == null ? "" : String(v);
            }
          }
        } catch {
          // Not JSON — only {{stdout}} available
        }

        const template = loadTemplate(action);
        if (template) {
          return renderTemplate(template, vars);
        }
        return `[${this.name}] ${stdout || stderr}`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.debug(`exec error: ${message}`);
        return `[${this.name}] 执行失败: ${message}`;
      }
    }, buildHelpText(this.name, this.config));

    ctx.debug(`registered command /${this.name}`);
  }

  async stop(): Promise<void> {
    // No cleanup needed
  }
}
