import { toBase64Url } from "../assets/crypto.js";

export function encodeContent(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8").toString("base64");
}

export class MockGitHub {
  constructor(initial = {}) {
    this.files = new Map();
    this.revision = 1;
    this.conflicts = new Map();
    for (const [path, document] of Object.entries(initial)) this.set(path, document);
    this.fetch = this.fetch.bind(this);
  }

  set(path, document) {
    const sha = `sha-${this.revision++}`;
    this.files.set(path, { sha, document: structuredClone(document) });
    return sha;
  }

  conflictOnce(path, concurrentDocument) {
    this.conflicts.set(path, structuredClone(concurrentDocument));
  }

  path(input) {
    const url = new URL(String(input));
    const marker = "/contents/";
    return url.pathname.slice(url.pathname.indexOf(marker) + marker.length).split("/").map(decodeURIComponent).join("/");
  }

  async fetch(input, init = {}) {
    const path = this.path(input);
    const method = (init.method || "GET").toUpperCase();
    if (method === "GET") {
      const file = this.files.get(path);
      if (!file) return Response.json({ message: "Not Found" }, { status: 404 });
      return Response.json({ type: "file", sha: file.sha, content: encodeContent(file.document) });
    }
    if (method === "PUT") {
      const body = JSON.parse(init.body);
      const existing = this.files.get(path);
      if (this.conflicts.has(path)) {
        this.set(path, this.conflicts.get(path));
        this.conflicts.delete(path);
        return Response.json({ message: "Conflict" }, { status: 409 });
      }
      if (existing && body.sha !== existing.sha) return Response.json({ message: "Conflict" }, { status: 409 });
      if (!existing && body.sha) return Response.json({ message: "Conflict" }, { status: 409 });
      if (existing && !body.sha) return Response.json({ message: "Already exists" }, { status: 422 });
      const document = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
      const sha = this.set(path, document);
      return Response.json({ content: { sha }, commit: { sha: `commit-${this.revision}` } });
    }
    if (method === "DELETE") {
      const body = JSON.parse(init.body);
      const existing = this.files.get(path);
      if (!existing) return Response.json({ message: "Not Found" }, { status: 404 });
      if (body.sha !== existing.sha) return Response.json({ message: "Conflict" }, { status: 409 });
      this.files.delete(path);
      return Response.json({ commit: { sha: `commit-${this.revision++}` } });
    }
    return Response.json({ message: "Unsupported" }, { status: 405 });
  }
}

export async function workerEnv({ siteToken = "site-test-token", adminPassword = "admin-test-password" } = {}) {
  const siteDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(siteToken)));
  const adminSalt = crypto.getRandomValues(new Uint8Array(16));
  const adminKey = await crypto.subtle.importKey("raw", adminSalt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const adminHash = new Uint8Array(await crypto.subtle.sign("HMAC", adminKey, new TextEncoder().encode(adminPassword)));
  return {
    SITE_AUTH_TOKEN_HASH: toBase64Url(siteDigest),
    ADMIN_PASSWORD_HASH: toBase64Url(adminHash),
    ADMIN_PASSWORD_SALT: toBase64Url(adminSalt),
    ADMIN_SESSION_SECRET: toBase64Url(crypto.getRandomValues(new Uint8Array(48))),
    GITHUB_DATA_TOKEN: "test-token-not-a-real-secret",
    GITHUB_OWNER: "example",
    GITHUB_REPO: "planner",
    GITHUB_BRANCH: "main",
    ALLOWED_ORIGIN: "https://team.example",
    DEV_ORIGIN: "http://127.0.0.1:5173",
  };
}

export function jsonRequest(path, { method = "POST", body, authorization, origin = "https://team.example", ip = "203.0.113.4" } = {}) {
  const headers = { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": ip };
  if (authorization) headers.Authorization = authorization;
  return new Request(`https://worker.example${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
