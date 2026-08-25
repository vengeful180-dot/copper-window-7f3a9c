const encoder = new TextEncoder();
const adminAttempts = new Map();
const accountAttempts = new Map();
const inviteAttempts = new Map();
const writeAttempts = new Map();
const ADMIN_WINDOW_MS = 15 * 60 * 1000;
const ACCOUNT_WINDOW_MS = 15 * 60 * 1000;
const WRITE_WINDOW_MS = 60 * 1000;
const ACCOUNT_SESSION_MS = 8 * 60 * 60 * 1000;
const ACCOUNT_STORAGE_CONTEXT = encoder.encode("quiet-leave-account-storage:v1");

function base64UrlToBytes(value) {
  const base64 = String(value).replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(String(value).length / 4) * 4, "=");
  try { return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)); } catch { return new Uint8Array(); }
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function timingSafeEqual(a, b) {
  const left = typeof a === "string" ? base64UrlToBytes(a) : a;
  const right = typeof b === "string" ? base64UrlToBytes(b) : b;
  const length = Math.max(left.length, right.length, 1);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) mismatch |= (left[index % Math.max(left.length, 1)] ?? 0) ^ (right[index % Math.max(right.length, 1)] ?? 0);
  return mismatch === 0;
}

export async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

function requestKey(request, prefix) {
  return `${prefix}:${request.headers.get("CF-Connecting-IP") || request.headers.get("x-forwarded-for") || "unknown"}`;
}

function consumeRate(map, key, limit, windowMs) {
  const now = Date.now();
  const current = map.get(key);
  if (!current || current.resetAt <= now) {
    map.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfter: 0 };
  }
  current.count += 1;
  if (current.count > limit) return { allowed: false, retryAfter: Math.ceil((current.resetAt - now) / 1000) };
  return { allowed: true, retryAfter: 0 };
}

export function checkAdminRate(request) {
  return consumeRate(adminAttempts, requestKey(request, "admin"), 5, ADMIN_WINDOW_MS);
}

export function checkAccountRate(request) {
  return consumeRate(accountAttempts, requestKey(request, "account"), 20, ACCOUNT_WINDOW_MS);
}

export function checkInviteRate(request) {
  return consumeRate(inviteAttempts, requestKey(request, "invite"), 8, ACCOUNT_WINDOW_MS);
}

export function checkWriteRate(request) {
  return consumeRate(writeAttempts, requestKey(request, "write"), 90, WRITE_WINDOW_MS);
}

export async function authorizeSite(request, env) {
  const value = request.headers.get("authorization") || "";
  const token = value.startsWith("Bearer ") ? value.slice(7) : "";
  if (!token || token.length > 128 || !env.SITE_AUTH_TOKEN_HASH) return false;
  return timingSafeEqual(await sha256Base64Url(token), env.SITE_AUTH_TOKEN_HASH);
}

export async function verifyAdminPassword(password, env) {
  if (typeof password !== "string" || !password || password.length > 256 || !env.ADMIN_PASSWORD_HASH || !env.ADMIN_PASSWORD_SALT) return false;
  const verifier = await hmac(password.normalize("NFKC"), env.ADMIN_PASSWORD_SALT, 16).catch(() => new Uint8Array());
  return timingSafeEqual(verifier, base64UrlToBytes(env.ADMIN_PASSWORD_HASH));
}

async function hmac(value, secret, minimumBytes = 32) {
  const secretBytes = base64UrlToBytes(secret);
  if (secretBytes.length < minimumBytes) throw new Error("A signing secret is not configured.");
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export async function accountLookupId(canonicalName, env) {
  return bytesToBase64Url(await hmac(`lookup:${canonicalName}`, env.ACCOUNT_LOOKUP_SECRET));
}

export async function fakeAccountKdf(canonicalName, env) {
  const salt = (await hmac(`kdf:${canonicalName}`, env.ACCOUNT_LOOKUP_SECRET)).slice(0, 16);
  return { name: "PBKDF2", hash: "SHA-256", iterations: 310_000, salt: bytesToBase64(salt) };
}

export async function fakeAccountVerifierHash(canonicalName, env) {
  return bytesToBase64Url(await hmac(`fake-verifier:${canonicalName}`, env.ACCOUNT_LOOKUP_SECRET));
}

export async function accountVerifierHash(verifier, env) {
  return bytesToBase64Url(await hmac(`account-verifier:${verifier}`, env.ACCOUNT_LOOKUP_SECRET));
}

export async function verifyAccountVerifier(verifier, verifierHash, env) {
  return timingSafeEqual(await accountVerifierHash(verifier, env), verifierHash);
}

async function accountStorageKey(env) {
  const keyBytes = await hmac("account-storage-key:v1", env.ACCOUNT_STORAGE_SECRET);
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function wrapAccountEnvelope(envelope, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(envelope));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ACCOUNT_STORAGE_CONTEXT, tagLength: 128 }, await accountStorageKey(env), plaintext);
  return { version: 1, cipher: { name: "AES-GCM", iv: bytesToBase64Url(iv), data: bytesToBase64Url(new Uint8Array(encrypted)) } };
}

export async function unwrapAccountEnvelope(wrapped, env) {
  const iv = base64UrlToBytes(wrapped.cipher.iv);
  const data = base64UrlToBytes(wrapped.cipher.data);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: ACCOUNT_STORAGE_CONTEXT, tagLength: 128 }, await accountStorageKey(env), data);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

export async function createAccountToken(env, accountId, now = Date.now()) {
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify({ exp: now + ACCOUNT_SESSION_MS, sub: accountId, scope: "account", nonce: crypto.randomUUID() })));
  const signature = bytesToBase64Url(await hmac(`account:${payload}`, env.ACCOUNT_SESSION_SECRET));
  return `${payload}.${signature}`;
}

export async function authorizeAccount(request, env, now = Date.now()) {
  const value = request.headers.get("authorization") || "";
  const token = value.startsWith("Session ") ? value.slice(8) : "";
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || token.length > 512) return false;
  const expected = await hmac(`account:${payload}`, env.ACCOUNT_SESSION_SECRET).catch(() => new Uint8Array());
  if (!timingSafeEqual(expected, base64UrlToBytes(signature))) return false;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
    const valid = parsed.scope === "account" && typeof parsed.sub === "string" && typeof parsed.nonce === "string"
      && Number.isFinite(parsed.exp) && parsed.exp >= now && parsed.exp <= now + ACCOUNT_SESSION_MS + 60_000;
    return valid ? { accountId: parsed.sub, expiresAt: parsed.exp } : false;
  } catch { return false; }
}

export async function createAdminToken(env, now = Date.now()) {
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify({ exp: now + 15 * 60 * 1000, nonce: crypto.randomUUID() })));
  const signature = bytesToBase64Url(await hmac(payload, env.ADMIN_SESSION_SECRET));
  return `${payload}.${signature}`;
}

export async function authorizeAdmin(request, env, now = Date.now()) {
  const value = request.headers.get("authorization") || "";
  const token = value.startsWith("Admin ") ? value.slice(6) : "";
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || token.length > 512) return false;
  const expected = await hmac(payload, env.ADMIN_SESSION_SECRET).catch(() => new Uint8Array());
  if (!timingSafeEqual(expected, base64UrlToBytes(signature))) return false;
  try {
    const decoded = new TextDecoder().decode(base64UrlToBytes(payload));
    const parsed = JSON.parse(decoded);
    return Number.isFinite(parsed.exp) && parsed.exp >= now && parsed.exp <= now + 16 * 60 * 1000 && typeof parsed.nonce === "string";
  } catch { return false; }
}

export function resetRateLimitsForTests() {
  adminAttempts.clear();
  accountAttempts.clear();
  inviteAttempts.clear();
  writeAttempts.clear();
}
