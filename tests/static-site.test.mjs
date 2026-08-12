import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("public shell is unlisted and contains no protected seed content", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /noindex,nofollow,noarchive/u);
  assert.doesNotMatch(html, /John Smith|2026-08-20|Friday meeting moved/u);
  assert.match(html, /id="unlockView"/u);
  assert.match(html, /id="appView"[^>]*hidden/u);
});

test("frontend never uses persistent local storage or unsafe HTML insertion", async () => {
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /localStorage|sessionStorage|\.innerHTML\s*=|insertAdjacentHTML/u);
});
