import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const output = path.join(root, "dist");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const entry of ["index.html", "robots.txt", "assets"]) {
  await cp(path.join(root, entry), path.join(output, entry), { recursive: true });
}

await mkdir(path.join(output, "data", "people"), { recursive: true });
for (const file of ["index.json", "config.enc.json", "presence.enc.json"]) {
  await cp(path.join(root, "data", file), path.join(output, "data", file));
}
await cp(path.join(root, "data", "people"), path.join(output, "data", "people"), { recursive: true });

const runtimePath = path.join(output, "assets", "runtime-config.js");
let runtime = await readFile(runtimePath, "utf8");
const repository = process.env.GITHUB_REPOSITORY || "";
const branch = process.env.GITHUB_REF_NAME || process.env.GITHUB_BRANCH || "main";
const inferredDataUrl = repository ? `https://raw.githubusercontent.com/${repository}/${branch}/data/` : "";
const workerUrl = (process.env.WORKER_API_URL || "").replace(/\/$/u, "");
const dataUrl = (process.env.DATA_BASE_URL || inferredDataUrl).replace(/\/?$/u, "/");
if (workerUrl) runtime = runtime.replace("__WORKER_API_URL__", workerUrl);
if (dataUrl) runtime = runtime.replace("__DATA_BASE_URL__", dataUrl);
await writeFile(runtimePath, runtime, "utf8");

const html = await readFile(path.join(output, "index.html"), "utf8");
if (!html.includes('name="robots" content="noindex,nofollow,noarchive"')) throw new Error("Missing noindex protection.");
if (html.includes("__WORKER_API_URL__") || html.includes("__DATA_BASE_URL__")) throw new Error("Runtime placeholders leaked into HTML.");
console.log(`Built static site in ${output}`);
