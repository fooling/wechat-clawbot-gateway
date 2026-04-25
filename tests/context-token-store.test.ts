import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ContextTokenStore } from "../src/core/context-token-store.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ctxstore-"));
}

const USER_A = "alice@im.wechat";
const USER_B = "bob@im.wechat";
const TOKEN_1 = "token-aaa";
const TOKEN_2 = "token-bbb";

test("non-existent file → empty store, no error", () => {
  const dir = tempDir();
  const store = new ContextTokenStore(path.join(dir, "missing.json"));
  assert.equal(store.size, 0);
  assert.equal(store.get(USER_A), undefined);
});

test("load existing JSON file populates store", () => {
  const dir = tempDir();
  const file = path.join(dir, "tokens.json");
  fs.writeFileSync(file, JSON.stringify({ [USER_A]: TOKEN_1, [USER_B]: TOKEN_2 }));
  const store = new ContextTokenStore(file);
  assert.equal(store.size, 2);
  assert.equal(store.get(USER_A), TOKEN_1);
  assert.equal(store.get(USER_B), TOKEN_2);
});

test("set persists to disk and survives reload", () => {
  const dir = tempDir();
  const file = path.join(dir, "tokens.json");
  const a = new ContextTokenStore(file);
  assert.equal(a.set(USER_A, TOKEN_1), true);
  assert.ok(fs.existsSync(file));

  const b = new ContextTokenStore(file);
  assert.equal(b.size, 1);
  assert.equal(b.get(USER_A), TOKEN_1);
});

test("set with same value is no-op (returns false, does not rewrite)", () => {
  const dir = tempDir();
  const file = path.join(dir, "tokens.json");
  const store = new ContextTokenStore(file);
  store.set(USER_A, TOKEN_1);
  const mtimeBefore = fs.statSync(file).mtimeMs;

  // wait a tick so mtime would change if rewritten
  const until = Date.now() + 20;
  while (Date.now() < until) { /* spin */ }

  assert.equal(store.set(USER_A, TOKEN_1), false);
  const mtimeAfter = fs.statSync(file).mtimeMs;
  assert.equal(mtimeAfter, mtimeBefore, "file should not be rewritten when value unchanged");
});

test("set with empty token is rejected", () => {
  const dir = tempDir();
  const file = path.join(dir, "tokens.json");
  const store = new ContextTokenStore(file);
  assert.equal(store.set(USER_A, ""), false);
  assert.equal(store.size, 0);
  assert.ok(!fs.existsSync(file), "file should not be created for empty token");
});

test("set creates parent directory if missing", () => {
  const dir = tempDir();
  const file = path.join(dir, "nested", "deep", "tokens.json");
  const store = new ContextTokenStore(file);
  store.set(USER_A, TOKEN_1);
  assert.ok(fs.existsSync(file));
});

test("corrupt JSON file → empty store, no crash", () => {
  const dir = tempDir();
  const file = path.join(dir, "tokens.json");
  fs.writeFileSync(file, "{ this is not valid json");
  const store = new ContextTokenStore(file);
  assert.equal(store.size, 0);
  // store should still be usable
  assert.equal(store.set(USER_A, TOKEN_1), true);
  assert.equal(store.get(USER_A), TOKEN_1);
});

test("load skips non-string values gracefully", () => {
  const dir = tempDir();
  const file = path.join(dir, "tokens.json");
  fs.writeFileSync(file, JSON.stringify({ [USER_A]: TOKEN_1, broken: 42, missing: null }));
  const store = new ContextTokenStore(file);
  assert.equal(store.size, 1);
  assert.equal(store.get(USER_A), TOKEN_1);
});

test("file is written with 0o600 permissions (token is sensitive)", { skip: process.platform === "win32" }, () => {
  const dir = tempDir();
  const file = path.join(dir, "tokens.json");
  const store = new ContextTokenStore(file);
  store.set(USER_A, TOKEN_1);
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0o600, got 0o${mode.toString(8)}`);
});

test("update to a new token for same user overwrites and persists", () => {
  const dir = tempDir();
  const file = path.join(dir, "tokens.json");
  const a = new ContextTokenStore(file);
  a.set(USER_A, TOKEN_1);
  assert.equal(a.set(USER_A, TOKEN_2), true);
  assert.equal(a.get(USER_A), TOKEN_2);

  const b = new ContextTokenStore(file);
  assert.equal(b.get(USER_A), TOKEN_2);
});

test("path getter returns resolved absolute path", () => {
  const dir = tempDir();
  const file = path.join(dir, "tokens.json");
  const store = new ContextTokenStore(file);
  assert.equal(store.path, path.resolve(file));
});
