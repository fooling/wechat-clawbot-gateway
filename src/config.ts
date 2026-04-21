import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";

// ── Wechat ─────────────────────────────────────────────

export interface WechatConfig {
  credentials_path: string;
  notify_user: string;
}

// ── Channel Configs ────────────────────────────────────

export interface WebhookEndpointConfig {
  template: string;
}

export interface WebhookConfig {
  enabled: boolean;
  port: number;
  token: string;
  endpoints: Record<string, WebhookEndpointConfig>;
}

export interface MqttSubscribeConfig {
  topic: string;
  tag: string;
}

export interface MqttCommandConfig {
  topic: string;
}

export interface MqttConfig {
  enabled: boolean;
  broker: string;
  username: string;
  password: string;
  subscribe: MqttSubscribeConfig[];
  commands: Record<string, MqttCommandConfig>;
}

export interface LlmModelConfig {
  enabled: boolean;
  base_url: string;
  model: string;
  api_key_env: string;
  system_prompt: string;
}

export interface OpenClawConfig {
  enabled: boolean;
  port: number;
  token: string;
}

export interface IftttConfig {
  enabled: boolean;
  key: string;
}

export interface ExecActionConfig {
  command: string;
  template?: string;
  template_file?: string;
  item_template?: string;
  item_separator?: string;
}

export interface ExecCommandConfig {
  enabled: boolean;
  help?: string;
  timeout?: number;
  default: ExecActionConfig;
  subcommands?: Record<string, ExecActionConfig>;
}

// ── Gateway Config ─────────────────────────────────────

export interface GatewayConfig {
  wechat: WechatConfig;
  channels: {
    webhook?: WebhookConfig;
    mqtt?: MqttConfig;
    llm?: Record<string, LlmModelConfig>;
    openclaw?: OpenClawConfig;
    ifttt?: IftttConfig;
    exec?: Record<string, ExecCommandConfig>;
  };
}

// ── Loader ─────────────────────────────────────────────

export function loadConfig(configPath: string): GatewayConfig {
  let raw: Record<string, unknown> = {};

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    raw = (parse(content) as Record<string, unknown>) ?? {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // No config file — use all defaults
    } else {
      throw err;
    }
  }

  const wechat = (raw.wechat ?? {}) as Partial<WechatConfig>;

  return {
    wechat: {
      credentials_path: wechat.credentials_path ?? path.join(os.homedir(), ".wechat-gateway", "credentials.json"),
      notify_user: wechat.notify_user ?? "",
    },
    channels: (raw.channels ?? {}) as GatewayConfig["channels"],
  };
}
