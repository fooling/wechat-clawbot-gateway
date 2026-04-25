import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FailedMessageStore } from "../src/core/failed-message-store.js";
import type { MessageItem } from "../src/protocol/weixin.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "failmsg-"));
}

const USER_A = "alice@im.wechat";
const USER_B = "bob@im.wechat";
const ITEM_TEXT: MessageItem = { type: 1, text_item: { text: "hello" } };
const ITEM_TEXT2: MessageItem = { type: 1, text_item: { text: "world" } };
const ERR = { ret: -2 };

test("disabled store → all ops are no-ops", () => {
  const dir = tempDir();
  const store = new FailedMessageStore(path.join(dir, "fail"), false);
  store.enqueue(USER_A, [ITEM_TEXT], ERR);
  assert.equal(store.pendingFor(USER_A).length, 0);
  assert.equal(fs.existsSync(path.join(dir, "fail")), false);
});

test("enabled store → enqueue creates dir and writes file", () => {
  const dir = tempDir();
  const store = new FailedMessageStore(path.join(dir, "fail"), true);
  store.enqueue(USER_A, [ITEM_TEXT], ERR);
  const files = fs.readdirSync(path.join(dir, "fail"));
  assert.equal(files.length, 1);
  assert.match(files[0], /\.json$/);
});

test("pendingFor filters by userId and orders by timestamp ascending", async () => {
  const dir = tempDir();
  const store = new FailedMessageStore(path.join(dir, "fail"), true);
  store.enqueue(USER_A, [ITEM_TEXT], ERR);
  await new Promise(r => setTimeout(r, 5));
  store.enqueue(USER_B, [ITEM_TEXT], ERR);
  await new Promise(r => setTimeout(r, 5));
  store.enqueue(USER_A, [ITEM_TEXT2], ERR);

  const pendingA = store.pendingFor(USER_A);
  assert.equal(pendingA.length, 2);
  assert.ok(pendingA[0].ts <= pendingA[1].ts);
  assert.equal(pendingA[0].items[0].text_item?.text, "hello");
  assert.equal(pendingA[1].items[0].text_item?.text, "world");

  assert.equal(store.pendingFor(USER_B).length, 1);
});

test("remove deletes file from queue", () => {
  const dir = tempDir();
  const store = new FailedMessageStore(path.join(dir, "fail"), true);
  store.enqueue(USER_A, [ITEM_TEXT], ERR);
  const [rec] = store.pendingFor(USER_A);
  store.remove(rec.filename);
  assert.equal(store.pendingFor(USER_A).length, 0);
});

test("bumpAttempt updates attempts count and lastError", () => {
  const dir = tempDir();
  const store = new FailedMessageStore(path.join(dir, "fail"), true);
  store.enqueue(USER_A, [ITEM_TEXT], ERR);
  const [rec] = store.pendingFor(USER_A);
  assert.equal(rec.attempts, 1);
  store.bumpAttempt(rec, { ret: -3, errmsg: "second try" });
  const [reread] = store.pendingFor(USER_A);
  assert.equal(reread.attempts, 2);
  assert.equal(reread.lastError.ret, -3);
  assert.equal(reread.lastError.errmsg, "second try");
});

test("corrupt JSON file in dir is skipped, others still load", () => {
  const dir = tempDir();
  const failDir = path.join(dir, "fail");
  fs.mkdirSync(failDir);
  fs.writeFileSync(path.join(failDir, "garbage.json"), "{not-json");
  const store = new FailedMessageStore(failDir, true);
  store.enqueue(USER_A, [ITEM_TEXT], ERR);
  assert.equal(store.pendingFor(USER_A).length, 1);
});

test("dangerous chars in userId are sanitized in filename", () => {
  const dir = tempDir();
  const store = new FailedMessageStore(path.join(dir, "fail"), true);
  store.enqueue("../../../etc/passwd", [ITEM_TEXT], ERR);
  const files = fs.readdirSync(path.join(dir, "fail"));
  assert.equal(files.length, 1);
  assert.ok(!files[0].includes("/"));
  assert.ok(!files[0].includes(".."));
});
