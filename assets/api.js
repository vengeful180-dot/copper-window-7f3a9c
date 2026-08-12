import { RUNTIME_CONFIG } from "./runtime-config.js";

export class ApiError extends Error {
  constructor(message, status = 0, details = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

export function apiConfigured() {
  return Boolean(RUNTIME_CONFIG.apiBaseUrl);
}

async function request(path, { method = "GET", body, siteToken, sessionToken, adminToken } = {}) {
  if (!apiConfigured()) throw new ApiError("Secure writes are not connected yet.", 503);
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (siteToken) headers.Authorization = `Bearer ${siteToken}`;
  if (sessionToken) headers.Authorization = `Session ${sessionToken}`;
  if (adminToken) headers.Authorization = `Admin ${adminToken}`;
  let response;
  try {
    response = await fetch(`${RUNTIME_CONFIG.apiBaseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  } catch {
    throw new ApiError("The secure write service could not be reached.", 0);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload.error || "The request could not be completed.", response.status, payload);
  return payload;
}

export const api = {
  health: () => request("/health"),
  bootstrapConfig: () => request("/bootstrap/config"),
  accountLookup: (name) => request("/api/account/lookup", { method: "POST", body: { name } }),
  accountRegister: (body, siteToken) => request("/api/account/register", { method: "POST", body, siteToken }),
  accountSession: (body) => request("/api/account/session", { method: "POST", body }),
  readIndex: (sessionToken) => request("/api/index", { sessionToken }),
  readConfig: (sessionToken) => request("/api/config", { sessionToken }),
  readPerson: (id, sessionToken) => request(`/api/person/${encodeURIComponent(id)}`, { sessionToken }),
  createPerson: (body, sessionToken) => request("/api/person", { method: "POST", body, sessionToken }),
  updatePerson: (id, body, sessionToken) => request(`/api/person/${encodeURIComponent(id)}`, { method: "PUT", body, sessionToken }),
  adminSession: (password) => request("/api/admin/session", { method: "POST", body: { password } }),
  updateConfig: (body, adminToken) => request("/api/admin/config", { method: "PUT", body, adminToken }),
  adminUpdatePerson: (id, body, adminToken) => request(`/api/admin/person/${encodeURIComponent(id)}`, { method: "PUT", body, adminToken }),
  adminDeletePerson: (id, adminToken) => request(`/api/admin/person/${encodeURIComponent(id)}`, { method: "DELETE", adminToken }),
};

export async function fetchDataJson(path) {
  const url = new URL(path.replace(/^\//u, ""), RUNTIME_CONFIG.dataBaseUrl);
  url.searchParams.set("v", `${Date.now()}-${crypto.randomUUID()}`);
  const response = await fetch(url, { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
  if (!response.ok) throw new ApiError(response.status === 404 ? "Protected data is not ready yet." : "Protected data could not be loaded.", response.status);
  return response.json();
}
