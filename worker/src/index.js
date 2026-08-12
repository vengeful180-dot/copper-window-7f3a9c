import {
  accountLookupId,
  accountVerifierHash,
  authorizeAccount,
  authorizeAdmin,
  authorizeSite,
  checkAccountRate,
  checkAdminRate,
  checkWriteRate,
  createAccountToken,
  createAdminToken,
  fakeAccountKdf,
  fakeAccountVerifierHash,
  verifyAccountVerifier,
  verifyAdminPassword,
  unwrapAccountEnvelope,
  wrapAccountEnvelope,
} from "./auth.js";
import { ConflictError, GitHubError, GitHubStore } from "./github-store.js";
import {
  InputError,
  readJsonBody,
  validateAccountLoginBody,
  validateAccountLookupBody,
  validateAccountRegistrationBody,
  validateCreatePersonBody,
  validateEncryptedWriteBody,
  validatePersonId,
} from "./validation.js";

const SECURITY_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

function allowedOrigins(env) {
  return [env.ALLOWED_ORIGIN, env.DEV_ORIGIN].filter(Boolean).map((origin) => origin.replace(/\/$/u, ""));
}

function originFor(request, env) {
  const origin = request.headers.get("origin")?.replace(/\/$/u, "") || "";
  return allowedOrigins(env).includes(origin) ? origin : null;
}

function responseHeaders(request, env, extra = {}) {
  const origin = originFor(request, env);
  return {
    ...SECURITY_HEADERS,
    ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    ...extra,
  };
}

function json(request, env, body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders(request, env, extraHeaders) });
}

function requireOrigin(request, env) {
  if (!originFor(request, env)) throw new InputError("Origin is not allowed.", 403);
}

function requireRate(rate) {
  if (!rate.allowed) throw new InputError("Too many attempts. Try again later.", 429);
}

async function requireSite(request, env, { countWrite = true } = {}) {
  if (countWrite) requireRate(checkWriteRate(request));
  if (!await authorizeSite(request, env)) throw new InputError("Authentication failed.", 401);
}

async function requireAccount(request, env, { countWrite = true } = {}) {
  if (countWrite) requireRate(checkWriteRate(request));
  const account = await authorizeAccount(request, env);
  if (!account) throw new InputError("Your login session is invalid or expired.", 401);
  return account;
}

async function requireAdmin(request, env) {
  requireRate(checkWriteRate(request));
  if (!await authorizeAdmin(request, env)) throw new InputError("Admin session is invalid or expired.", 401);
}

export function createWorker(fetchImpl = fetch) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") {
        if (!originFor(request, env)) return json(request, env, { error: "Origin is not allowed." }, 403);
        return new Response(null, { status: 204, headers: responseHeaders(request, env, {
          "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Authorization,Content-Type",
          "Access-Control-Max-Age": "600",
        }) });
      }

      try {
        if (request.method === "GET" && url.pathname === "/health") {
          return json(request, env, { status: "ok", service: "encrypted-github-write-gateway" });
        }
        requireOrigin(request, env);
        const store = () => new GitHubStore(env, fetchImpl);

        if (request.method === "GET" && url.pathname === "/bootstrap/config") {
          return json(request, env, { file: await store().get("data/config.enc.json") });
        }

        if (request.method === "POST" && url.pathname === "/api/account/lookup") {
          const rate = checkAccountRate(request);
          if (!rate.allowed) return json(request, env, { error: "Too many attempts. Try again later." }, 429, { "Retry-After": String(rate.retryAfter) });
          const { canonicalName } = validateAccountLookupBody(await readJsonBody(request));
          const lookup = await accountLookupId(canonicalName, env);
          const account = await store().getAccount(lookup, { allowMissing: true });
          return json(request, env, { kdf: account?.document.kdf ?? await fakeAccountKdf(canonicalName, env) });
        }

        if (request.method === "POST" && url.pathname === "/api/account/register") {
          await requireSite(request, env);
          const body = validateAccountRegistrationBody(await readJsonBody(request));
          const lookup = await accountLookupId(body.canonicalName, env);
          await store().createAccount(lookup, {
            version: 1,
            id: body.id,
            kdf: body.kdf,
            verifierHash: await accountVerifierHash(body.verifier, env),
            wrappedEnvelope: await wrapAccountEnvelope(body.envelope, env),
          });
          return json(request, env, {
            token: await createAccountToken(env, body.id),
            expiresIn: 8 * 60 * 60,
            accountId: body.id,
            envelope: body.envelope,
          }, 201);
        }

        if (request.method === "POST" && url.pathname === "/api/account/session") {
          const rate = checkAccountRate(request);
          if (!rate.allowed) return json(request, env, { error: "Too many attempts. Try again later." }, 429, { "Retry-After": String(rate.retryAfter) });
          const body = validateAccountLoginBody(await readJsonBody(request));
          const lookup = await accountLookupId(body.canonicalName, env);
          const account = await store().getAccount(lookup, { allowMissing: true });
          const verifierHash = account?.document.verifierHash ?? await fakeAccountVerifierHash(body.canonicalName, env);
          const authorized = await verifyAccountVerifier(body.verifier, verifierHash, env);
          if (!account || !authorized) return json(request, env, { error: "Name or password is incorrect." }, 401);
          return json(request, env, {
            token: await createAccountToken(env, account.document.id),
            expiresIn: 8 * 60 * 60,
            accountId: account.document.id,
            envelope: await unwrapAccountEnvelope(account.document.wrappedEnvelope, env),
          });
        }

        if (request.method === "POST" && url.pathname === "/api/admin/session") {
          const rate = checkAdminRate(request);
          if (!rate.allowed) return json(request, env, { error: "Too many attempts. Try again later." }, 429, { "Retry-After": String(rate.retryAfter) });
          const body = await readJsonBody(request);
          if (!await verifyAdminPassword(body.password, env)) return json(request, env, { error: "Authentication failed." }, 401);
          return json(request, env, { token: await createAdminToken(env), expiresIn: 900 });
        }

        if (request.method === "GET" && url.pathname === "/api/index") {
          await requireAccount(request, env, { countWrite: false });
          return json(request, env, { file: await store().get("data/index.json") });
        }

        if (request.method === "GET" && url.pathname === "/api/config") {
          await requireAccount(request, env, { countWrite: false });
          return json(request, env, { file: await store().get("data/config.enc.json") });
        }

        if (request.method === "GET" && url.pathname === "/api/presence") {
          await requireAccount(request, env, { countWrite: false });
          return json(request, env, { file: await store().get("data/presence.enc.json") });
        }

        if (request.method === "PUT" && url.pathname === "/api/presence") {
          await requireAccount(request, env);
          const body = validateEncryptedWriteBody(await readJsonBody(request));
          const file = await store().updateEncrypted("data/presence.enc.json", body.document, body.expectedDigest, "Update encrypted work locations");
          return json(request, env, { ok: true, file });
        }

        if (request.method === "POST" && url.pathname === "/api/person") {
          const account = await requireAccount(request, env);
          const body = validateCreatePersonBody(await readJsonBody(request));
          const result = await store().createPerson(body.id, body.document, account.accountId);
          return json(request, env, { ok: true, ...result }, 201);
        }

        const personMatch = url.pathname.match(/^\/api\/person\/([^/]+)$/u);
        if (request.method === "GET" && personMatch) {
          await requireAccount(request, env, { countWrite: false });
          const id = validatePersonId(personMatch[1]);
          return json(request, env, { file: await store().get(`data/people/${id}.enc.json`) });
        }
        if (request.method === "PUT" && personMatch) {
          const account = await requireAccount(request, env);
          const id = validatePersonId(personMatch[1]);
          const body = validateEncryptedWriteBody(await readJsonBody(request));
          const personStore = store();
          await personStore.requirePersonOwner(id, account.accountId);
          const file = await personStore.updateEncrypted(`data/people/${id}.enc.json`, body.document, body.expectedDigest, "Update encrypted holiday record");
          return json(request, env, { ok: true, file });
        }

        if (request.method === "PUT" && url.pathname === "/api/admin/config") {
          await requireAdmin(request, env);
          const body = validateEncryptedWriteBody(await readJsonBody(request));
          const file = await store().updateEncrypted("data/config.enc.json", body.document, body.expectedDigest, "Update encrypted homepage settings");
          return json(request, env, { ok: true, file });
        }

        if (request.method === "POST" && url.pathname === "/api/admin/person") {
          await requireAdmin(request, env);
          const body = validateCreatePersonBody(await readJsonBody(request));
          const result = await store().createPerson(body.id, body.document);
          return json(request, env, { ok: true, ...result }, 201);
        }

        const adminPersonMatch = url.pathname.match(/^\/api\/admin\/person\/([^/]+)$/u);
        if (request.method === "PUT" && adminPersonMatch) {
          await requireAdmin(request, env);
          const id = validatePersonId(adminPersonMatch[1]);
          const body = validateEncryptedWriteBody(await readJsonBody(request));
          const file = await store().updateEncrypted(`data/people/${id}.enc.json`, body.document, body.expectedDigest, "Admin update encrypted person record");
          return json(request, env, { ok: true, file });
        }

        if (request.method === "DELETE" && adminPersonMatch) {
          await requireAdmin(request, env);
          const id = validatePersonId(adminPersonMatch[1]);
          const result = await store().deletePerson(id);
          return json(request, env, { ok: true, ...result });
        }

        return json(request, env, { error: "Not found." }, 404);
      } catch (error) {
        if (error instanceof ConflictError) return json(request, env, { error: error.message, latest: error.latest }, 409);
        if (error instanceof InputError) return json(request, env, { error: error.message }, error.status);
        if (error instanceof GitHubError) return json(request, env, { error: error.message }, error.status >= 400 && error.status < 600 ? error.status : 502);
        return json(request, env, { error: "The secure write service could not complete the request." }, 500);
      }
    },
  };
}

export default createWorker();
