import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config.js";

function tempConfigFile(yaml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-"));
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, yaml, "utf-8");
  return file;
}

test("missing wechat block → both paths default under ~/.wechat-gateway/", () => {
  const file = tempConfigFile("channels: {}\n");
  const cfg = loadConfig(file);
  const home = os.homedir();
  assert.equal(cfg.wechat.credentials_path, path.join(home, ".wechat-gateway", "credentials.json"));
  assert.equal(cfg.wechat.context_tokens_path, path.join(home, ".wechat-gateway", "context_tokens.json"));
  assert.equal(cfg.wechat.notify_user, "");
});

test("missing context_tokens_path defaults to home, even if credentials_path is overridden", () => {
  const file = tempConfigFile("wechat:\n  credentials_path: data/credentials.json\nchannels: {}\n");
  const cfg = loadConfig(file);
  assert.equal(cfg.wechat.credentials_path, "data/credentials.json");
  assert.equal(
    cfg.wechat.context_tokens_path,
    path.join(os.homedir(), ".wechat-gateway", "context_tokens.json"),
    "context_tokens default must NOT follow credentials override (avoids accidentally landing in repo)",
  );
});

test("explicit context_tokens_path is honored", () => {
  const custom = "/var/lib/wxgw/tokens.json";
  const file = tempConfigFile(`wechat:\n  context_tokens_path: ${custom}\nchannels: {}\n`);
  const cfg = loadConfig(file);
  assert.equal(cfg.wechat.context_tokens_path, custom);
});

test("config file missing entirely → all defaults", () => {
  const cfg = loadConfig("/nonexistent/path/config.yaml");
  assert.equal(
    cfg.wechat.context_tokens_path,
    path.join(os.homedir(), ".wechat-gateway", "context_tokens.json"),
  );
});
