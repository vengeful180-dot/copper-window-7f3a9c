import test from "node:test";
import assert from "node:assert/strict";
import { deriveSecrets, encryptJson, exportTeamAccess, makeKdf } from "../assets/crypto.js";
import { accountLookupId, accountVerifierHash, authorizeAccount, createAccountToken, resetRateLimitsForTests } from "../worker/src/auth.js";
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

test("account sessions protect planner writes while the invite token cannot write holidays", async () => {
  resetRateLimitsForTests();
  const env = await workerEnv();
  const accountToken = await createAccountToken(env, personId);
  const document = await encryptedDocument({ id: personId, name: "Encrypted in transit", holidays: [] });
  const github = new MockGitHub({ "data/index.json": { people: [] } });
  const worker = createWorker(github.fetch);
  const wrong = await worker.fetch(jsonRequest("/api/person", { body: { id: personId, document }, authorization: "Session wrong" }), env);
  assert.equal(wrong.status, 401);
  const inviteOnly = await worker.fetch(jsonRequest("/api/person", { body: { id: personId, document }, authorization: "Bearer site-test-token", ip: "203.0.113.8" }), env);
  assert.equal(inviteOnly.status, 401);
  const correct = await worker.fetch(jsonRequest("/api/person", { body: { id: personId, document }, authorization: `Session ${accountToken}`, ip: "203.0.113.9" }), env);
  assert.equal(correct.status, 201);
  const payload = await correct.json();
  assert.equal(payload.person.digest, await digestDocument(document));
  assert.deepEqual(github.files.get("data/index.json").document, { people: [personId] });
  assert.deepEqual(github.files.get(`data/owners/${personId}.json`).document, { version: 1, accountId: personId });
});

test("Worker-backed reads return fresh encrypted repository files", async () => {
  resetRateLimitsForTests();
  const env = await workerEnv();
  const accountToken = await createAccountToken(env, personId);
  const config = await encryptedDocument({ mom: "Fresh", weekLabel: "", announcement: "", secondaryAnnouncement: "" });
  const presence = await encryptedDocument({ version: 1, members: [] });
  const person = await encryptedDocument({ id: personId, name: "Fresh person", holidays: [] });
  const github = new MockGitHub({
    "data/config.enc.json": config,
    "data/presence.enc.json": presence,
    "data/index.json": { people: [personId] },
    [`data/people/${personId}.enc.json`]: person,
  });
  const worker = createWorker(github.fetch);

  const bootstrap = await worker.fetch(jsonRequest("/bootstrap/config", { method: "GET" }), env);
  assert.equal(bootstrap.status, 200);
  assert.deepEqual((await bootstrap.json()).file.document, config);

  for (const [path, expected] of [["/api/index", { people: [personId] }], ["/api/config", config], ["/api/presence", presence], [`/api/person/${personId}`, person]]) {
    const response = await worker.fetch(jsonRequest(path, { method: "GET", authorization: `Session ${accountToken}` }), env);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).file.document, expected);
  }
});

test("account sessions can update the encrypted work-location schedule", async () => {
  resetRateLimitsForTests();
  const env = await workerEnv();
  const accountToken = await createAccountToken(env, personId);
  const before = await encryptedDocument({ version: 1, members: [] });
  const after = await encryptedDocument({ version: 1, members: [{ accountId: personId, displayName: "Encrypted", officeDays: ["2026-08-13"] }] });
  const github = new MockGitHub({ "data/presence.enc.json": before });
  const worker = createWorker(github.fetch);
  const response = await worker.fetch(jsonRequest("/api/presence", {
    method: "PUT",
    body: { document: after, expectedDigest: await digestDocument(before) },
    authorization: `Session ${accountToken}`,
    ip: "203.0.113.12",
  }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(github.files.get("data/presence.enc.json").document, after);
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

test("Admin token can update every encrypted work-location row", async () => {
  resetRateLimitsForTests();
  const env = await workerEnv();
  const before = await encryptedDocument({ version: 1, members: [] });
  const after = await encryptedDocument({ version: 1, members: [{ accountId: personId, displayName: "Managed by Admin", officeDays: ["2026-08-13"] }] });
  const github = new MockGitHub({ "data/presence.enc.json": before });
  const worker = createWorker(github.fetch);
  const login = await worker.fetch(jsonRequest("/api/admin/session", { body: { password: "admin-test-password" }, ip: "203.0.113.14" }), env);
  const { token } = await login.json();
  const update = await worker.fetch(jsonRequest("/api/admin/presence", {
    method: "PUT",
    body: { document: after, expectedDigest: await digestDocument(before) },
    authorization: `Admin ${token}`,
    ip: "203.0.113.14",
  }), env);
  assert.equal(update.status, 200);
  assert.deepEqual(github.files.get("data/presence.enc.json").document, after);
});

test("stale client update receives 409 and the latest encrypted document", async () => {
  resetRateLimitsForTests();
  const env = await workerEnv();
  const accountToken = await createAccountToken(env, personId);
  const latest = await encryptedDocument({ id: personId, name: "Latest", holidays: [] });
  const ours = await encryptedDocument({ id: personId, name: "Ours", holidays: [] });
  const github = new MockGitHub({
    [`data/people/${personId}.enc.json`]: latest,
    [`data/owners/${personId}.json`]: { version: 1, accountId: personId },
  });
  const worker = createWorker(github.fetch);
  const response = await worker.fetch(jsonRequest(`/api/person/${personId}`, {
    method: "PUT",
    body: { document: ours, expectedDigest: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    authorization: `Session ${accountToken}`,
    ip: "203.0.113.11",
  }), env);
  assert.equal(response.status, 409);
  const payload = await response.json();
  assert.deepEqual(payload.latest.document, latest);
});

test("personal sessions can update only their own holiday record while Admin can update any record", async () => {
  resetRateLimitsForTests();
  const env = await workerEnv();
  const otherAccountId = "44444444-4444-4444-8444-444444444444";
  const ownerToken = await createAccountToken(env, personId);
  const otherToken = await createAccountToken(env, otherAccountId);
  const before = await encryptedDocument({ id: personId, name: "Owner", holidays: [] });
  const ownerUpdate = await encryptedDocument({ id: personId, name: "Owner", holidays: [{ id: personId, start: "2026-08-12", end: "2026-08-12" }] });
  const adminUpdate = await encryptedDocument({ id: personId, name: "Admin edit", holidays: [] });
  const github = new MockGitHub({
    [`data/people/${personId}.enc.json`]: before,
    [`data/owners/${personId}.json`]: { version: 1, accountId: personId },
  });
  const worker = createWorker(github.fetch);

  const denied = await worker.fetch(jsonRequest(`/api/person/${personId}`, {
    method: "PUT",
    body: { document: ownerUpdate, expectedDigest: await digestDocument(before) },
    authorization: `Session ${otherToken}`,
    ip: "203.0.113.31",
  }), env);
  assert.equal(denied.status, 403);
  assert.deepEqual(github.files.get(`data/people/${personId}.enc.json`).document, before);

  const allowed = await worker.fetch(jsonRequest(`/api/person/${personId}`, {
    method: "PUT",
    body: { document: ownerUpdate, expectedDigest: await digestDocument(before) },
    authorization: `Session ${ownerToken}`,
    ip: "203.0.113.32",
  }), env);
  assert.equal(allowed.status, 200);

  const login = await worker.fetch(jsonRequest("/api/admin/session", { body: { password: "admin-test-password" }, ip: "203.0.113.33" }), env);
  const { token: adminToken } = await login.json();
  const adminAllowed = await worker.fetch(jsonRequest(`/api/admin/person/${personId}`, {
    method: "PUT",
    body: { document: adminUpdate, expectedDigest: await digestDocument(ownerUpdate) },
    authorization: `Admin ${adminToken}`,
    ip: "203.0.113.33",
  }), env);
  assert.equal(adminAllowed.status, 200);
  assert.deepEqual(github.files.get(`data/people/${personId}.enc.json`).document, adminUpdate);
});

test("Admin-created demo records are editable only in Admin mode and carry no personal owner", async () => {
  resetRateLimitsForTests();
  const env = await workerEnv();
  const document = await encryptedDocument({ id: personId, name: "Demo person", holidays: [] });
  const github = new MockGitHub({ "data/index.json": { people: [] } });
  const worker = createWorker(github.fetch);
  const login = await worker.fetch(jsonRequest("/api/admin/session", { body: { password: "admin-test-password" }, ip: "203.0.113.41" }), env);
  const { token } = await login.json();
  const created = await worker.fetch(jsonRequest("/api/admin/person", {
    body: { id: personId, document },
    authorization: `Admin ${token}`,
    ip: "203.0.113.41",
  }), env);
  assert.equal(created.status, 201);
  assert.equal(github.files.has(`data/owners/${personId}.json`), false);

  const personalToken = await createAccountToken(env, personId);
  const denied = await worker.fetch(jsonRequest(`/api/person/${personId}`, {
    method: "PUT",
    body: { document, expectedDigest: await digestDocument(document) },
    authorization: `Session ${personalToken}`,
    ip: "203.0.113.42",
  }), env);
  assert.equal(denied.status, 403);
});

test("account registration stores no name or reusable password verifier and supports personal login", async () => {
  resetRateLimitsForTests();
  const env = await workerEnv();
  const name = "  Test   Person  ";
  const canonicalName = "test person";
  const accountPassword = "personal-password-for-tests";
  const accountId = "44444444-4444-4444-8444-444444444444";
  const teamSecrets = await deriveSecrets("team-password", makeKdf());
  const accountSecrets = await deriveSecrets(accountPassword, makeKdf());
  const envelope = await encryptJson({ version: 1, accountId, displayName: "Test Person", team: exportTeamAccess(teamSecrets) }, accountSecrets);
  const github = new MockGitHub({ "data/index.json": { people: [] } });
  const worker = createWorker(github.fetch);

  const unknownLookup = await worker.fetch(jsonRequest("/api/account/lookup", { body: { name } }), env);
  assert.equal(unknownLookup.status, 200);
  assert.deepEqual(Object.keys(await unknownLookup.clone().json()), ["kdf"]);

  const registration = await worker.fetch(jsonRequest("/api/account/register", {
    body: { id: accountId, name, kdf: accountSecrets.kdf, verifier: accountSecrets.authToken, envelope },
    authorization: "Bearer site-test-token",
  }), env);
  assert.equal(registration.status, 201);
  const registered = await registration.json();
  assert.match(registered.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);

  const lookup = await accountLookupId(canonicalName, env);
  const persisted = github.files.get(`data/accounts/${lookup}.json`).document;
  assert.equal(persisted.verifierHash, await accountVerifierHash(accountSecrets.authToken, env));
  assert.notEqual(persisted.verifierHash, accountSecrets.authToken);
  assert.equal("envelope" in persisted, false);
  assert.equal(persisted.wrappedEnvelope.cipher.name, "AES-GCM");
  assert.notDeepEqual(persisted.wrappedEnvelope, envelope);
  const publicText = JSON.stringify({ lookup, persisted });
  assert.doesNotMatch(publicText, /Test Person|test person|personal-password-for-tests/u);

  const duplicate = await worker.fetch(jsonRequest("/api/account/register", {
    body: { id: "55555555-5555-4555-8555-555555555555", name: "TEST PERSON", kdf: accountSecrets.kdf, verifier: accountSecrets.authToken, envelope },
    authorization: "Bearer site-test-token",
  }), env);
  assert.equal(duplicate.status, 409);

  const realLookup = await worker.fetch(jsonRequest("/api/account/lookup", { body: { name: "test person" } }), env);
  assert.deepEqual((await realLookup.json()).kdf, accountSecrets.kdf);
  const wrongLogin = await worker.fetch(jsonRequest("/api/account/session", { body: { name, verifier: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } }), env);
  assert.equal(wrongLogin.status, 401);
  const login = await worker.fetch(jsonRequest("/api/account/session", { body: { name: "TEST PERSON", verifier: accountSecrets.authToken } }), env);
  assert.equal(login.status, 200);
  const session = await login.json();
  assert.equal(session.accountId, accountId);
  assert.deepEqual(session.envelope, envelope);

  const read = await worker.fetch(jsonRequest("/api/index", { method: "GET", authorization: `Session ${session.token}` }), env);
  assert.equal(read.status, 200);
  assert.deepEqual((await read.json()).file.document, { people: [] });
});

test("account lookup and login attempts are rate limited", async () => {
  resetRateLimitsForTests();
  const env = await workerEnv();
  const worker = createWorker(new MockGitHub().fetch);
  let response;
  for (let index = 0; index < 21; index += 1) response = await worker.fetch(jsonRequest("/api/account/lookup", { body: { name: "Unknown person" }, ip: "198.51.100.77" }), env);
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("retry-after")) > 0);
});

test("expired personal account sessions are rejected", async () => {
  const env = await workerEnv();
  const now = Date.now();
  const expired = await createAccountToken(env, personId, now - 9 * 60 * 60 * 1000);
  const request = jsonRequest("/api/index", { method: "GET", authorization: `Session ${expired}` });
  assert.equal(await authorizeAccount(request, env, now), false);
});
