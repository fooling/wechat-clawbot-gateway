import readline from "node:readline";
import type { Channel, ChannelContext, LogEntry, DebugEntry } from "./channel.js";

const GREEN = "\x1b[32m";
const BLUE = "\x1b[34m";
const GRAY = "\x1b[90m";
const RESET = "\x1b[0m";

export class TuiChannel implements Channel {
  readonly name = "tui";

  private rl: readline.Interface | null = null;
  private ctx: ChannelContext | null = null;
  private activeUser: string;

  constructor(initialUser = "") {
    this.activeUser = initialUser;
  }

  async start(ctx: ChannelContext): Promise<void> {
    this.ctx = ctx;

    // Subscribe to all gateway traffic
    ctx.onLog((entry: LogEntry) => {
      this.displayLog(entry);
      if (entry.direction === "in" && entry.source === "wx") {
        this.activeUser = entry.userId;
        this.updatePrompt();
      }
    });

    ctx.onDebug((entry: DebugEntry) => {
      this.displayDebug(entry);
    });

    // Claim default handler (display only, no auto-reply)
    ctx.onDefault(async (_userId: string, _text: string) => {
      // Message already displayed via onLog subscription
    });

    // Setup readline
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    this.updatePrompt();
    this.rl.prompt();

    this.rl.on("line", async (line: string) => {
      const input = line.trim();
      if (!input) {
        this.rl?.prompt();
        return;
      }

      if (!this.activeUser) {
        this.printAboveLine(`${GRAY}No active user yet. Waiting for incoming message...${RESET}`);
        this.rl?.prompt();
        return;
      }

      try {
        await ctx.send(this.activeUser, `[tui] ${input}`);
      } catch (err) {
        this.printAboveLine(`${GRAY}Send error: ${err}${RESET}`);
      }
      this.rl?.prompt();
    });

    this.rl.on("close", () => {
      process.kill(process.pid, "SIGINT");
    });
  }

  async stop(): Promise<void> {
    this.rl?.close();
    this.rl = null;
  }

  // ── Display helpers ────────────────────────────────────

  private printAboveLine(text: string): void {
    process.stdout.write(`\r\x1b[K${text}\n`);
    this.rl?.prompt(true);
  }

  private formatTime(ts: number): string {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  private displayLog(entry: LogEntry): void {
    const time = this.formatTime(entry.timestamp);
    if (entry.direction === "in") {
      this.printAboveLine(`${GREEN}${time} <- ${entry.source}/${entry.userId}: ${entry.text}${RESET}`);
    } else {
      this.printAboveLine(`${BLUE}${time} -> [${entry.source}] ${entry.text}${RESET}`);
    }
  }

  private displayDebug(entry: DebugEntry): void {
    const time = this.formatTime(entry.timestamp);
    this.printAboveLine(`${GRAY}${time}   [debug] ${entry.channel}: ${entry.detail}${RESET}`);
  }

  private updatePrompt(): void {
    const user = this.activeUser || "---";
    this.rl?.setPrompt(`[wx:ok | ${user}] > `);
  }
}
