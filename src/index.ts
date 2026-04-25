import fs from "node:fs";
import { WxClient } from "./core/wx-client.js";
import { Gateway } from "./core/gateway.js";
import { TuiChannel } from "./channels/tui.js";
import { WebhookChannel } from "./channels/webhook.js";
import { MqttChannel } from "./channels/mqtt.js";
import { LlmChannel } from "./channels/llm.js";
import { OpenClawChannel } from "./channels/openclaw.js";
import { IftttChannel } from "./channels/ifttt.js";
import { ExecChannel } from "./channels/exec.js";
import { loadConfig } from "./config.js";
import type { LogEntry, DebugEntry } from "./channels/channel.js";

const CONFIG_PATHS = [
  "config.yaml",                      // 项目目录
  "/etc/wechat-gateway/config.yaml",  // 系统目录
];

function findConfig(): string {
  for (const p of CONFIG_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return CONFIG_PATHS[0]; // fallback to default (will use all defaults)
}

async function main(): Promise<void> {
  const configPath = findConfig();
  const config = loadConfig(configPath);

  // Handle --logout
  if (process.argv.includes("--logout")) {
    const wx = new WxClient({ credentialsPath: config.wechat.credentials_path, contextTokensPath: config.wechat.context_tokens_path });
    wx.clearCredentials();
    console.log("Credentials cleared. QR scan required on next start.");
    return;
  }

  // Create and login WxClient
  const wx = new WxClient({ credentialsPath: config.wechat.credentials_path, contextTokensPath: config.wechat.context_tokens_path });
  await wx.login();

  // Create Gateway
  const gateway = new Gateway(wx, config);

  // Register TUI in --tui mode
  const tuiMode = process.argv.includes("--tui");
  if (tuiMode) {
    gateway.use(new TuiChannel(gateway.getNotifyUser()));
  } else {
    // Daemon mode: log to console for systemd journal
    gateway.on("log", (entry: LogEntry) => {
      const dir = entry.direction === "in" ? "IN " : "OUT";
      console.log(`[${new Date(entry.timestamp).toISOString()}] ${dir} ${entry.source}/${entry.userId}: ${entry.text}`);
    });
    gateway.on("debug", (entry: DebugEntry) => {
      console.log(`[${new Date(entry.timestamp).toISOString()}] DBG ${entry.channel}: ${entry.detail}`);
    });
  }

  // Register channels from config
  if (config.channels.webhook?.enabled) {
    gateway.use(new WebhookChannel(config.channels.webhook));
  }
  if (config.channels.mqtt?.enabled) {
    gateway.use(new MqttChannel(config.channels.mqtt));
  }
  for (const [name, cfg] of Object.entries(config.channels.llm ?? {})) {
    if (cfg.enabled) {
      gateway.use(new LlmChannel(name, cfg));
    }
  }
  if (config.channels.openclaw?.enabled) {
    gateway.use(new OpenClawChannel(config.channels.openclaw));
  }
  if (config.channels.ifttt?.enabled) {
    gateway.use(new IftttChannel(config.channels.ifttt));
  }
  for (const [name, cfg] of Object.entries(config.channels.exec ?? {})) {
    if (cfg.enabled) {
      gateway.use(new ExecChannel(name, cfg));
    }
  }

  // Start gateway
  await gateway.start();

  // Graceful shutdown
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    if (!tuiMode) console.log("\nShutting down...");
    gateway.stop().then(() => {
      process.exit(0);
    }).catch((err) => {
      console.error("Shutdown error:", err);
      process.exit(1);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});
