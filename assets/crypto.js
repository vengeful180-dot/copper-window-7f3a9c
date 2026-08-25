const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const KDF_ITERATIONS = 310_000;
export const ENCRYPTION_CONTEXT = encoder.encode("quiet-leave-planner:v1");

function bytesToBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function toBase64Url(bytes) {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function fromBase64Url(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return base64ToBytes(base64);
}

export function makeKdf(salt = crypto.getRandomValues(new Uint8Array(16))) {
  return { name: "PBKDF2", hash: "SHA-256", iterations: KDF_ITERATIONS, salt: bytesToBase64(salt) };
}

export function validateKdf(kdf) {
  if (!kdf || kdf.name !== "PBKDF2" || kdf.hash !== "SHA-256" || kdf.iterations !== KDF_ITERATIONS) throw new Error("Unsupported encryption settings.");
  const salt = base64ToBytes(kdf.salt ?? "");
  if (salt.length !== 16) throw new Error("Invalid encryption salt.");
  return salt;
}

export async function deriveSecrets(password, kdf) {
  if (typeof password !== "string" || !password) throw new Error("A password is required.");
  const salt = validateKdf(kdf);
  const material = await crypto.subtle.importKey("raw", encoder.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: kdf.iterations }, material, 512));
  const dataKey = bits.slice(0, 32);
  const encryptionKey = await crypto.subtle.importKey("raw", dataKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return { encryptionKey, dataKey: toBase64Url(dataKey), authToken: toBase64Url(bits.slice(32)), kdf: { ...kdf } };
}

export function exportTeamAccess(secrets) {
  const access = { version: 1, dataKey: secrets?.dataKey, kdf: { ...secrets?.kdf } };
  validateTeamAccess(access);
  return access;
}

export function validateTeamAccess(access) {
  if (!access || typeof access !== "object" || Array.isArray(access) || access.version !== 1) throw new Error("Invalid team access key.");
  if (typeof access.dataKey !== "string" || fromBase64Url(access.dataKey).length !== 32) throw new Error("Invalid team access key.");
  validateKdf(access.kdf);
  if (Object.keys(access).sort().join(",") !== "dataKey,kdf,version") throw new Error("Invalid team access key.");
  return access;
}

export async function importTeamAccess(access) {
  validateTeamAccess(access);
  const encryptionKey = await crypto.subtle.importKey("raw", fromBase64Url(access.dataKey), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return { encryptionKey, dataKey: access.dataKey, authToken: null, kdf: { ...access.kdf } };
}

export async function encryptJson(value, secrets) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ENCRYPTION_CONTEXT, tagLength: 128 }, secrets.encryptionKey, plaintext);
  return {
    version: 1,
    kdf: { ...secrets.kdf },
    cipher: { name: "AES-GCM", iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(encrypted)) },
  };
}

export async function decryptJson(document, secrets) {
  validateEncryptedDocument(document);
  if (JSON.stringify(document.kdf) !== JSON.stringify(secrets.kdf)) throw new Error("Encryption settings do not match.");
  const iv = base64ToBytes(document.cipher.iv);
  const encrypted = base64ToBytes(document.cipher.data);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: ENCRYPTION_CONTEXT, tagLength: 128 }, secrets.encryptionKey, encrypted);
  return JSON.parse(decoder.decode(plaintext));
}

export async function unlockJson(document, password) {
  validateEncryptedDocument(document);
  const secrets = await deriveSecrets(password, document.kdf);
  const value = await decryptJson(document, secrets);
  return { value, secrets };
}

export function validateEncryptedDocument(document) {
  if (!document || document.version !== 1 || typeof document !== "object") throw new Error("Invalid encrypted document.");
  validateKdf(document.kdf);
  if (!document.cipher || document.cipher.name !== "AES-GCM") throw new Error("Invalid encrypted document.");
  if (base64ToBytes(document.cipher.iv ?? "").length !== 12) throw new Error("Invalid encryption nonce.");
  const data = base64ToBytes(document.cipher.data ?? "");
  if (data.length < 16 || data.length > 64 * 1024) throw new Error("Invalid encrypted payload.");
  return document;
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export async function digestDocument(document) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(stableStringify(document)));
  return toBase64Url(new Uint8Array(digest));
}

export async function hashAuthToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return toBase64Url(new Uint8Array(digest));
}
