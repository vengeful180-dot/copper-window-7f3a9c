import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("public shell is unlisted and contains no protected seed content", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /noindex,nofollow,noarchive/u);
  assert.doesNotMatch(html, /John Smith|2026-08-20|Friday meeting moved/u);
  assert.match(html, /id="unlockView"/u);
  assert.match(html, /id="loginForm"/u);
  assert.match(html, /id="createForm"/u);
  assert.match(html, /id="appView"[^>]*hidden/u);
});

test("frontend never uses persistent local storage or unsafe HTML insertion", async () => {
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /localStorage|\.innerHTML\s*=|insertAdjacentHTML/u);
  const sessionFields = app.match(/sessionStorage\.setItem\(SESSION_KEY,\s*JSON\.stringify\(\{([\s\S]*?)\}\)\);/u)?.[1];
  assert.ok(sessionFields);
  assert.doesNotMatch(sessionFields, /password|people|config/iu);
});

test("account records remain server-side and are excluded from the Pages artifact", async () => {
  const build = await readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8");
  assert.match(build, /\["index\.html", "robots\.txt", "assets"\]/u);
  assert.doesNotMatch(build, /data[\\/]accounts/u);
  assert.doesNotMatch(build, /path\.join\(root, "data"\)(?!,)/u);
});
