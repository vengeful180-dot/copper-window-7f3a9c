const workerPlaceholder = "__WORKER_API_URL__";
const dataPlaceholder = "__DATA_BASE_URL__";

const isLocal = ["localhost", "127.0.0.1"].includes(window.location.hostname);

export const RUNTIME_CONFIG = Object.freeze({
  apiBaseUrl: workerPlaceholder.startsWith("__")
    ? (isLocal ? "http://127.0.0.1:8787" : "")
    : workerPlaceholder.replace(/\/$/, ""),
  dataBaseUrl: dataPlaceholder.startsWith("__")
    ? new URL("../data/", import.meta.url).href
    : dataPlaceholder.replace(/\/?$/, "/"),
});
