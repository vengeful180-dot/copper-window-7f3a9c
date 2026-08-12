import { ACCOUNT_LOOKUP_PATTERN, validateAccountRecord, validateAnonymousIndex, validateOwnershipRecord } from "./validation.js";

const encoder = new TextEncoder();

function bytesToBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function base64ToText(value) {
  const binary = atob(String(value).replace(/\s/gu, ""));
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export async function digestDocument(document) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(stableStringify(document))));
  return bytesToBase64(digest).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export class GitHubError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

export class ConflictError extends Error {
  constructor(latest, message = "This record changed elsewhere. The latest version is included so the change can be merged safely.") {
    super(message);
    this.name = "ConflictError";
    this.status = 409;
    this.latest = latest;
  }
}

export class GitHubStore {
  constructor(env, fetchImpl = fetch) {
    this.fetch = fetchImpl.bind(globalThis);
    this.owner = env.GITHUB_OWNER;
    this.repo = env.GITHUB_REPO;
    this.branch = env.GITHUB_BRANCH || "main";
    this.token = env.GITHUB_DATA_TOKEN;
    if (!this.owner || !this.repo || !this.token) throw new GitHubError("The repository connection is not configured.", 503);
  }

  pathUrl(path) {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    return `https://api.github.com/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${encodedPath}`;
  }

  headers() {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.token}`,
      "User-Agent": "quiet-leave-gateway",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  async get(path, { allowMissing = false } = {}) {
    const url = new URL(this.pathUrl(path));
    url.searchParams.set("ref", this.branch);
    const response = await this.fetch(url.toString(), { headers: this.headers(), cache: "no-store" });
    if (response.status === 404 && allowMissing) return null;
    if (!response.ok) throw new GitHubError(response.status === 404 ? "A repository data file is missing." : "GitHub could not read the protected data.", response.status === 404 ? 404 : 502);
    const payload = await response.json();
    if (payload.type !== "file" || typeof payload.sha !== "string" || typeof payload.content !== "string") throw new GitHubError("GitHub returned an unexpected file response.");
    let document;
    try { document = JSON.parse(base64ToText(payload.content)); } catch { throw new GitHubError("A repository data file is not valid JSON."); }
    return { sha: payload.sha, document, digest: await digestDocument(document) };
  }

  async put(path, document, message, sha = null) {
    const content = `${JSON.stringify(document, null, 2)}\n`;
    const body = { message, content: bytesToBase64(encoder.encode(content)), branch: this.branch };
    if (sha) body.sha = sha;
    const response = await this.fetch(this.pathUrl(path), {
      method: "PUT",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.status === 409 || response.status === 422) throw new GitHubError("GitHub version conflict.", 409);
    if (!response.ok) throw new GitHubError("GitHub could not save the protected data.");
    const payload = await response.json();
    const savedSha = payload.content?.sha;
    if (typeof savedSha !== "string" || !savedSha) throw new GitHubError("GitHub returned an unexpected save response.");
    // The successful conditional PUT confirms this exact content. A GET through
    // the branch ref can briefly return the previous commit after this point.
    return { sha: savedSha, document, digest: await digestDocument(document) };
  }

  async remove(path, sha, message) {
    const response = await this.fetch(this.pathUrl(path), {
      method: "DELETE",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ message, sha, branch: this.branch }),
    });
    if (response.status === 409 || response.status === 422) throw new GitHubError("GitHub version conflict.", 409);
    if (!response.ok && response.status !== 404) throw new GitHubError("GitHub could not remove the protected data.");
  }

  async updateEncrypted(path, document, expectedDigest, message) {
    const latest = await this.get(path);
    if (latest.digest !== expectedDigest) throw new ConflictError(latest);
    try {
      return await this.put(path, document, message, latest.sha);
    } catch (error) {
      if (error instanceof GitHubError && error.status === 409) throw new ConflictError(await this.get(path));
      throw error;
    }
  }

  async updateIndex(mutator, message) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const latest = await this.get("data/index.json");
      const next = validateAnonymousIndex(mutator(validateAnonymousIndex(latest.document)));
      try {
        return await this.put("data/index.json", next, message, latest.sha);
      } catch (error) {
        if (error instanceof GitHubError && error.status === 409) continue;
        throw error;
      }
    }
    throw new GitHubError("The anonymous index changed too often to update safely.", 409);
  }

  ownerPath(id) {
    return `data/owners/${id}.json`;
  }

  async getPersonOwner(id, { allowMissing = false } = {}) {
    const file = await this.get(this.ownerPath(id), { allowMissing });
    if (!file) return null;
    return { ...file, document: validateOwnershipRecord(file.document) };
  }

  async requirePersonOwner(id, accountId) {
    const owner = await this.getPersonOwner(id, { allowMissing: true });
    if (!owner || owner.document.accountId !== accountId) throw new GitHubError("You can only change your own holidays. Use Admin mode to manage someone else.", 403);
    return owner;
  }

  async createPerson(id, document, ownerAccountId = null) {
    const path = `data/people/${id}.enc.json`;
    if (await this.get(path, { allowMissing: true })) throw new ConflictError(null, "That anonymous identifier already exists. Try again.");
    let person;
    let owner;
    try {
      person = await this.put(path, document, "Add encrypted holiday record");
      if (ownerAccountId) owner = await this.put(this.ownerPath(id), validateOwnershipRecord({ version: 1, accountId: ownerAccountId }), "Bind holiday record to its account");
    } catch (error) {
      if (person?.sha) await this.remove(path, person.sha, "Roll back incomplete encrypted record").catch(() => {});
      if (error instanceof GitHubError && error.status === 409) throw new ConflictError(null, "That anonymous identifier already exists. Try again.");
      throw error;
    }
    let index;
    try {
      index = await this.updateIndex((current) => ({ people: [...new Set([...current.people, id])].sort() }), "Add anonymous team member reference");
    } catch (error) {
      if (owner?.sha) await this.remove(this.ownerPath(id), owner.sha, "Roll back incomplete holiday ownership").catch(() => {});
      if (person?.sha) await this.remove(path, person.sha, "Roll back incomplete encrypted record").catch(() => {});
      throw error;
    }
    return { person, index, ...(owner ? { owner } : {}) };
  }

  async getAccount(lookup, { allowMissing = false } = {}) {
    if (!ACCOUNT_LOOKUP_PATTERN.test(lookup ?? "")) throw new GitHubError("The account lookup is invalid.", 400);
    const file = await this.get(`data/accounts/${lookup}.json`, { allowMissing });
    if (!file) return null;
    return { ...file, document: validateAccountRecord(file.document) };
  }

  async createAccount(lookup, record) {
    const validated = validateAccountRecord(record);
    if (await this.getAccount(lookup, { allowMissing: true })) throw new ConflictError(null, "An account with that name already exists.");
    try {
      return await this.put(`data/accounts/${lookup}.json`, validated, "Create encrypted planner account");
    } catch (error) {
      if (error instanceof GitHubError && error.status === 409) throw new ConflictError(null, "An account with that name already exists.");
      throw error;
    }
  }

  async deletePerson(id) {
    const path = `data/people/${id}.enc.json`;
    const index = await this.updateIndex((current) => ({ people: current.people.filter((candidate) => candidate !== id) }), "Remove anonymous team member reference");
    const latest = await this.get(path, { allowMissing: true });
    if (latest) {
      try { await this.remove(path, latest.sha, "Delete encrypted person record"); }
      catch (error) {
        if (error instanceof GitHubError && error.status === 409) {
          const refreshed = await this.get(path, { allowMissing: true });
          if (refreshed) await this.remove(path, refreshed.sha, "Delete encrypted person record");
        } else throw error;
      }
    }
    const owner = await this.getPersonOwner(id, { allowMissing: true });
    if (owner) {
      try { await this.remove(this.ownerPath(id), owner.sha, "Delete holiday ownership record"); }
      catch (error) {
        if (error instanceof GitHubError && error.status === 409) {
          const refreshed = await this.getPersonOwner(id, { allowMissing: true });
          if (refreshed) await this.remove(this.ownerPath(id), refreshed.sha, "Delete holiday ownership record");
        } else throw error;
      }
    }
    return { index };
  }
}
