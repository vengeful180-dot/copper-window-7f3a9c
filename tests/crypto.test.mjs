import test from "node:test";
import assert from "node:assert/strict";
import { decryptJson, deriveSecrets, digestDocument, encryptJson, makeKdf, unlockJson } from "../assets/crypto.js";

test("AES-256-GCM round trip succeeds with the correct password", async () => {
  const kdf = makeKdf(Uint8Array.from({ length: 16 }, (_, index) => index));
  const secrets = await deriveSecrets("correct horse battery staple", kdf);
  const value = { id: "record", name: "Test Person", holidays: [{ id: "h", start: "2026-08-20", end: "2026-08-25" }] };
  const encrypted = await encryptJson(value, secrets);
  assert.deepEqual(await decryptJson(encrypted, secrets), value);
  assert.deepEqual((await unlockJson(encrypted, "correct horse battery staple")).value, value);
});

test("wrong site password cannot decrypt protected data", async () => {
  const kdf = makeKdf();
  const encrypted = await encryptJson({ announcement: "Protected" }, await deriveSecrets("right-password", kdf));
  await assert.rejects(() => unlockJson(encrypted, "wrong-password"));
});

test("fresh random GCM nonces produce different ciphertext", async () => {
  const secrets = await deriveSecrets("same-password", makeKdf());
  const first = await encryptJson({ value: 1 }, secrets);
  const second = await encryptJson({ value: 1 }, secrets);
  assert.notEqual(first.cipher.iv, second.cipher.iv);
  assert.notEqual(first.cipher.data, second.cipher.data);
});

test("document digest is stable across object key ordering", async () => {
  assert.equal(await digestDocument({ b: 2, a: 1 }), await digestDocument({ a: 1, b: 2 }));
});
