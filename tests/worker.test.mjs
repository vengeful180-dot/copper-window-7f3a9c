import test from "node:test";
import assert from "node:assert/strict";
import { deriveSecrets, encryptJson, makeKdf } from "../assets/crypto.js";
import { resetRateLimitsForTests } from "../worker/src/auth.js";
import { digestDocument } from "../worker/src/github-store.js";
import { createWorker } from "../worker/src/index.js";
import { jsonRequest, MockGitHub, workerEnv } from "./helpers.mjs";

const personId = "33333333-3333-4333-8333-333333333333";

async function encryptedDocument(value) {
  return encryptJson(value, await deriveSecrets("team-password", makeKdf()));
}

test("health endpoint is public but reveals no configuration", async () => {
  const worker = createWorker(async () => { throw new Error("unused"); });
  const response = await worker.fetch(new Request("https://worker.example/health"), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", service: "encrypted-github-write-gateway" });
});

test("wrong and correct Admin passwords are validated server-side", async () => {
  resetRateLimitsForTests();
  const env = await workerEnv();
  const worker = createWorker(async () => { throw new Error("unused"); });
  const wrong = await worker.fetch(jsonRequest("/api/admin/session", { body: { password: "wrong" } }), env);
  assert.equal(wrong.status, 401);
  const correct = await worker.fetch(jsonRequest("/api/admin/session", { body: { password: "admin-test-password" }, ip: "203.0.113.5" }), env);
  assert.equal(correct.status, 200);
  const payload = await correct.json();
  assert.match(payload.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
});

test("Admin authentication is rate limited", async () => {
  resetRateLimitsForTests();
  const env = await workerEnv();
  const worker = createWorker(async () => { throw new Error("unused"); });
  let response;
  for (let index = 0; index < 6; index += 1) response = await worker.fetch(jsonRequest("/api/admin/session", { body: { password: "wrong" }, ip: "198.51.100.8" }), env);
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("retry-after")) > 0);
});

test("disallowed origins are rejected before authentication", async () => {
  resetRateLimitsForTests();
  const env = await workerEnv();
  const worker = createWorker(async () => { throw new Error("unused"); });
  const response = await worker.fetch(jsonRequest("/api/person", { body: {}, origin: "https://evil.example" }), env);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("site authentication rejects wrong token and accepts correct first-person write", async () => {
  resetRateLimitsForTests();
  const env = await workerEnv();
  const document = await encryptedDocument({ id: personId, name: "Encrypted in transit", holidays: [] });
  const github = new MockGitHub({ "data/index.json": { people: [] } });
  const worker = createWorker(github.fetch);
  const wrong = await worker.fetch(jsonRequest("/api/person", { body: { id: personId, document }, authorization: "Bearer wrong" }), env);
  assert.equal(wrong.status, 401);
  const correct = await worker.fetch(jsonRequest("/api/person", { body: { id: personId, document }, authorization: "Bearer site-test-token", ip: "203.0.113.9" }), env);
  assert.equal(correct.status, 201);
  const payload = await correct.json();
  assert.equal(payload.person.digest, await digestDocument(document));
  assert.deepEqual(github.files.get("data/index.json").document, { people: [personId] });
});

test("Worker-backed reads return fresh encrypted repository files", async () => {
  resetRateLimitsForTests();
  const env = await workerEnv();
  const config = await encryptedDocument({ mom: "Fresh", weekLabel: "", announcement: "", secondaryAnnouncement: "" });
  const person = await encryptedDocument({ id: personId, name: "Fresh person", holidays: [] });
  const github = new MockGitHub({
    "data/config.enc.json": config,
    "data/index.json": { people: [personId] },
    [`data/people/${personId}.enc.json`]: person,
  });
  const worker = createWorker(github.fetch);

  const bootstrap = await worker.fetch(jsonRequest("/bootstrap/config", { method: "GET" }), env);
  assert.equal(bootstrap.status, 200);
  assert.deepEqual((await bootstrap.json()).file.document, config);

  for (const [path, expected] of [["/api/index", { people: [personId] }], ["/api/config", config], [`/api/person/${personId}`, person]]) {
    const response = await worker.fetch(jsonRequest(path, { method: "GET", authorization: "Bearer site-test-token" }), env);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).file.document, expected);
  }
});

test("Admin token can update encrypted MOM/config data", async () => {
  resetRateLimitsForTests();
  const env = await workerEnv();
  const before = await encryptedDocument({ mom: "Before", weekLabel: "", announcement: "", secondaryAnnouncement: "" });
  const after = await encryptedDocument({ mom: "After", weekLabel: "", announcement: "Protected", secondaryAnnouncement: "" });
  const github = new MockGitHub({ "data/config.enc.json": before });
  const worker = createWorker(github.fetch);
  const login = await worker.fetch(jsonRequest("/api/admin/session", { body: { password: "admin-test-password" }, ip: "203.0.113.10" }), env);
  const { token } = await login.json();
  const update = await worker.fetch(jsonRequest("/api/admin/config", {
    method: "PUT",
    body: { document: after, expectedDigest: await digestDocument(before) },
    authorization: `Admin ${token}`,
    ip: "203.0.113.10",
  }), env);
  assert.equal(update.status, 200);
  assert.deepEqual(github.files.get("data/config.enc.json").document, after);
});

test("stale client update receives 409 and the latest encrypted document", async () => {
  resetRateLimitsForTests();
  const env = await workerEnv();
  const latest = await encryptedDocument({ id: personId, name: "Latest", holidays: [] });
  const ours = await encryptedDocument({ id: personId, name: "Ours", holidays: [] });
  const github = new MockGitHub({ [`data/people/${personId}.enc.json`]: latest });
  const worker = createWorker(github.fetch);
  const response = await worker.fetch(jsonRequest(`/api/person/${personId}`, {
    method: "PUT",
    body: { document: ours, expectedDigest: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    authorization: "Bearer site-test-token",
    ip: "203.0.113.11",
  }), env);
  assert.equal(response.status, 409);
  const payload = await response.json();
  assert.deepEqual(payload.latest.document, latest);
});
