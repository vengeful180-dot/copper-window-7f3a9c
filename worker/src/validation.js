export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
export const ACCOUNT_LOOKUP_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const MAX_BODY_BYTES = 72 * 1024;

export class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "InputError";
    this.status = status;
  }
}

function decodedLength(value) {
  if (typeof value !== "string" || !BASE64_PATTERN.test(value)) return -1;
  try { return atob(value).length; } catch { return -1; }
}

function decodedBase64UrlLength(value) {
  if (typeof value !== "string" || !BASE64_URL_PATTERN.test(value)) return -1;
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try { return atob(base64).length; } catch { return -1; }
}

export function validatePersonId(id) {
  if (!UUID_PATTERN.test(id ?? "")) throw new InputError("Invalid person identifier.");
  return id.toLowerCase();
}

export function validateEncryptedDocument(document) {
  if (!document || typeof document !== "object" || Array.isArray(document) || document.version !== 1) throw new InputError("Invalid encrypted document.");
  const { kdf, cipher } = document;
  if (!kdf || kdf.name !== "PBKDF2" || kdf.hash !== "SHA-256" || kdf.iterations !== 310_000 || decodedLength(kdf.salt) !== 16) throw new InputError("Invalid encryption settings.");
  if (!cipher || cipher.name !== "AES-GCM" || decodedLength(cipher.iv) !== 12) throw new InputError("Invalid encrypted document.");
  const payloadLength = decodedLength(cipher.data);
  if (payloadLength < 16 || payloadLength > 64 * 1024) throw new InputError("Encrypted payload size is invalid.");
  const expectedTopKeys = ["cipher", "kdf", "version"];
  if (Object.keys(document).sort().join(",") !== expectedTopKeys.join(",")) throw new InputError("Unexpected encrypted document fields.");
  return document;
}

export function validateAccountName(value) {
  if (typeof value !== "string") throw new InputError("Enter your name.");
  const displayName = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
  if (!displayName || displayName.length > 80) throw new InputError("Enter a valid name of up to 80 characters.");
  return { displayName, canonicalName: displayName.toLocaleLowerCase("en-US") };
}

function validateVerifier(value, label) {
  if (!DIGEST_PATTERN.test(value ?? "")) throw new InputError(`A valid ${label} is required.`);
  return value;
}

function sameKdf(left, right) {
  return left?.name === right?.name && left?.hash === right?.hash && left?.iterations === right?.iterations && left?.salt === right?.salt;
}

export function validateAccountLookupBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new InputError("Invalid request body.");
  return validateAccountName(body.name);
}

export function validateAccountRegistrationBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new InputError("Invalid request body.");
  const name = validateAccountName(body.name);
  const id = validatePersonId(body.id);
  const envelope = validateEncryptedDocument(body.envelope);
  if (!sameKdf(body.kdf, envelope.kdf)) throw new InputError("Account encryption settings do not match.");
  return { ...name, id, kdf: { ...envelope.kdf }, verifier: validateVerifier(body.verifier, "account verifier"), envelope };
}

export function validateAccountLoginBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new InputError("Invalid request body.");
  return { ...validateAccountName(body.name), verifier: validateVerifier(body.verifier, "login proof") };
}

export function validateWrappedAccountEnvelope(wrapped) {
  if (!wrapped || typeof wrapped !== "object" || Array.isArray(wrapped) || wrapped.version !== 1) throw new InputError("The account record is invalid.", 502);
  if (Object.keys(wrapped).sort().join(",") !== "cipher,version") throw new InputError("The account record is invalid.", 502);
  if (!wrapped.cipher || Object.keys(wrapped.cipher).sort().join(",") !== "data,iv,name" || wrapped.cipher.name !== "AES-GCM") throw new InputError("The account record is invalid.", 502);
  if (decodedBase64UrlLength(wrapped.cipher.iv) !== 12) throw new InputError("The account record is invalid.", 502);
  const payloadLength = decodedBase64UrlLength(wrapped.cipher.data);
  if (payloadLength < 16 || payloadLength > 72 * 1024) throw new InputError("The account record is invalid.", 502);
  return wrapped;
}

export function validateAccountRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record) || record.version !== 1) throw new InputError("The account record is invalid.", 502);
  if (Object.keys(record).sort().join(",") !== "id,kdf,verifierHash,version,wrappedEnvelope") throw new InputError("The account record is invalid.", 502);
  const id = validatePersonId(record.id);
  const kdf = { ...record.kdf };
  if (!kdf || kdf.name !== "PBKDF2" || kdf.hash !== "SHA-256" || kdf.iterations !== 310_000 || decodedLength(kdf.salt) !== 16) throw new InputError("The account record is invalid.", 502);
  return { version: 1, id, kdf, verifierHash: validateVerifier(record.verifierHash, "account verifier"), wrappedEnvelope: validateWrappedAccountEnvelope(record.wrappedEnvelope) };
}

export function validateExpectedDigest(value) {
  if (!DIGEST_PATTERN.test(value ?? "")) throw new InputError("A valid record version is required.");
  return value;
}

export async function readJsonBody(request) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) throw new InputError("Request body is too large.", 413);
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("application/json")) throw new InputError("Content-Type must be application/json.", 415);
  const text = await request.text();
  if (!text || new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new InputError("Request body is invalid or too large.", text ? 413 : 400);
  try { return JSON.parse(text); } catch { throw new InputError("Request body must be valid JSON."); }
}

export function validateEncryptedWriteBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new InputError("Invalid request body.");
  return {
    document: validateEncryptedDocument(body.document),
    expectedDigest: validateExpectedDigest(body.expectedDigest),
  };
}

export function validateCreatePersonBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new InputError("Invalid request body.");
  return { id: validatePersonId(body.id), document: validateEncryptedDocument(body.document) };
}

export function validateAnonymousIndex(index) {
  if (!index || typeof index !== "object" || !Array.isArray(index.people) || index.people.length > 100) throw new InputError("The anonymous index is invalid.", 502);
  const people = [];
  const seen = new Set();
  for (const id of index.people) {
    const valid = validatePersonId(id);
    if (seen.has(valid)) continue;
    seen.add(valid);
    people.push(valid);
  }
  return { people };
}
