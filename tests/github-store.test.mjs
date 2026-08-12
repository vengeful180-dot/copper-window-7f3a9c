import test from "node:test";
import assert from "node:assert/strict";
import { ConflictError, digestDocument, GitHubStore } from "../worker/src/github-store.js";
import { MockGitHub } from "./helpers.mjs";

const env = { GITHUB_DATA_TOKEN: "test-token", GITHUB_OWNER: "example", GITHUB_REPO: "planner", GITHUB_BRANCH: "main" };
const firstId = "11111111-1111-4111-8111-111111111111";
const concurrentId = "22222222-2222-4222-8222-222222222222";

test("GitHub reads use a URL string accepted by the Workers fetch runtime", async () => {
  let inputType = null;
  const fetchImpl = async (input) => {
    inputType = typeof input;
    return Response.json({ type: "file", sha: "index-sha", content: btoa(JSON.stringify({ people: [] })) });
  };
  const store = new GitHubStore(env, fetchImpl);
  await store.get("data/index.json");
  assert.equal(inputType, "string");
});

test("outbound fetch keeps the Workers runtime global context", async () => {
  let correctContext = false;
  async function runtimeFetch() {
    correctContext = this === globalThis;
    return Response.json({ type: "file", sha: "index-sha", content: btoa(JSON.stringify({ people: [] })) });
  }
  const store = new GitHubStore(env, runtimeFetch);
  await store.get("data/index.json");
  assert.equal(correctContext, true);
});

test("new person creation writes an encrypted file and anonymous index only", async () => {
  const github = new MockGitHub({ "data/index.json": { people: [] } });
  const store = new GitHubStore(env, github.fetch);
  const document = { version: 1, kdf: { salt: "cipher" }, cipher: { data: "opaque" } };
  const result = await store.createPerson(firstId, document);
  assert.deepEqual(github.files.get("data/index.json").document, { people: [firstId] });
  assert.deepEqual(result.person.document, document);
  assert.equal(JSON.stringify(github.files.get("data/index.json").document).includes("name"), false);
});

test("index SHA conflict refetches, merges UUID additions, and retries", async () => {
  const github = new MockGitHub({ "data/index.json": { people: [] } });
  github.conflictOnce("data/index.json", { people: [concurrentId] });
  const store = new GitHubStore(env, github.fetch);
  await store.createPerson(firstId, { version: 1, ciphertext: "opaque" });
  assert.deepEqual(github.files.get("data/index.json").document.people, [firstId, concurrentId].sort());
});

test("stale encrypted update returns latest ciphertext instead of overwriting", async () => {
  const original = { version: 1, ciphertext: "first" };
  const concurrent = { version: 1, ciphertext: "concurrent" };
  const github = new MockGitHub({ [`data/people/${firstId}.enc.json`]: concurrent });
  const store = new GitHubStore(env, github.fetch);
  await assert.rejects(
    () => store.updateEncrypted(`data/people/${firstId}.enc.json`, { version: 1, ciphertext: "ours" }, "wrong-digest", "Update"),
    (error) => error instanceof ConflictError && error.latest.document.ciphertext === "concurrent",
  );
  assert.deepEqual(github.files.get(`data/people/${firstId}.enc.json`).document, concurrent);
  assert.notEqual(await digestDocument(original), await digestDocument(concurrent));
});

test("GitHub race after version check is surfaced with the newest record", async () => {
  const original = { version: 1, ciphertext: "first" };
  const concurrent = { version: 1, ciphertext: "second" };
  const github = new MockGitHub({ [`data/people/${firstId}.enc.json`]: original });
  github.conflictOnce(`data/people/${firstId}.enc.json`, concurrent);
  const store = new GitHubStore(env, github.fetch);
  const originalDigest = await digestDocument(original);
  await assert.rejects(
    () => store.updateEncrypted(`data/people/${firstId}.enc.json`, { version: 1, ciphertext: "ours" }, originalDigest, "Update"),
    (error) => error instanceof ConflictError && error.latest.document.ciphertext === "second",
  );
});
