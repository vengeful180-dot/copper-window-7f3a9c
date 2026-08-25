import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const ignored = new Set([".git", "node_modules", "dist", ".wrangler", "data"]);
const textExtensions = new Set([".html", ".js", ".mjs", ".json", ".css", ".md", ".toml", ".yml", ".yaml", ".txt", ""]);
const failures = [];

async function walk(directory) {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name) || entry.name === ".initial-credentials.txt" || entry.name === ".dev.vars" || entry.name === ".rotation-secrets.txt") continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await walk(fullPath));
    else results.push(fullPath);
  }
  return results;
}

const files = await walk(root);
for (const file of files) {
  if (!textExtensions.has(path.extname(file).toLowerCase())) continue;
  const content = await readFile(file, "utf8");
  const relative = path.relative(root, file);
  if (/gh[pousr]_[A-Za-z0-9]{20,}/u.test(content) || /github_pat_[A-Za-z0-9_]{20,}/u.test(content)) failures.push(`${relative}: possible GitHub token`);
  if (/\.innerHTML\s*=/u.test(content) || /insertAdjacentHTML\s*\(/u.test(content)) failures.push(`${relative}: unsafe HTML insertion`);
  if (/localStorage\s*\./u.test(content)) failures.push(`${relative}: persistent decrypted storage`);
  if (/SITE_PASSWORD\s*=\s*(?!generated|your|replace|\$|<)[^\s#]{12,}/u.test(content)) failures.push(`${relative}: possible committed site password`);
  if (/ADMIN_PASSWORD\s*=\s*(?!generated|your|replace|\$|<)[^\s#]{12,}/u.test(content)) failures.push(`${relative}: possible committed admin password`);
}

const [build, api, app, runtime, worker, html, gitignore, workerWorkflow, pagesWorkflow, wrangler] = await Promise.all([
  readFile(path.join(root, "scripts", "build.mjs"), "utf8"),
  readFile(path.join(root, "assets", "api.js"), "utf8"),
  readFile(path.join(root, "assets", "app.js"), "utf8"),
  readFile(path.join(root, "assets", "runtime-config.js"), "utf8"),
  readFile(path.join(root, "worker", "src", "index.js"), "utf8"),
  readFile(path.join(root, "index.html"), "utf8"),
  readFile(path.join(root, ".gitignore"), "utf8"),
  readFile(path.join(root, ".github", "workflows", "worker.yml"), "utf8"),
  readFile(path.join(root, ".github", "workflows", "pages.yml"), "utf8"),
  readFile(path.join(root, "worker", "wrangler.toml"), "utf8"),
]);

if (/raw\.githubusercontent\.com|DATA_BASE_URL|dataBaseUrl/u.test(`${build}\n${api}\n${app}\n${runtime}\n${html}`)) failures.push("frontend: public repository data fallback detected");
if (/path\.join\(root,\s*"data"/u.test(build) || /dist[\\/]data/u.test(build)) failures.push("build: protected data may be copied into the public artifact");
if (!/bootstrapConfig:\s*\(siteToken\)[\s\S]*?siteToken/u.test(api)) failures.push("api: bootstrap configuration is not invite-authenticated");
if (!/url\.pathname === "\/bootstrap\/config"\)[\s\S]{0,160}?requireSite\(request, env/u.test(worker)) failures.push("worker: bootstrap configuration is publicly readable");
if (/DEV_ORIGIN/u.test(worker)) failures.push("worker: a development origin can be enabled in production");
if (/sessionStorage\.(?:setItem|getItem)/u.test(app)) failures.push("frontend: account credentials are persisted in browser storage");
if (!/sessionStorage\.removeItem\(LEGACY_SESSION_KEY\)/u.test(app)) failures.push("frontend: legacy stored credentials are not purged");
if (/https:\/\/\*\.workers\.dev/u.test(html) || /connect-src[^"]*(?:localhost|127\.0\.0\.1)/u.test(html)) failures.push("frontend: content policy permits a broad or local connection target");
if (!/window\.top !== window\.self[\s\S]{0,160}?document\.body\.replaceChildren\(\)/u.test(app)) failures.push("frontend: frame guard is missing");
if (!/html:not\(\.is-top-level\) body[\s\S]{0,120}?visibility:\s*hidden !important/u.test(await readFile(path.join(root, "assets", "styles.css"), "utf8"))) failures.push("frontend: fail-closed frame styling is missing");
if (!/require-trusted-types-for 'script'; trusted-types 'none'/u.test(html)) failures.push("frontend: Trusted Types policy is missing");
if (/GH_TOKEN:\s*\$\{\{ secrets\.PLANNER_DATA_TOKEN \}\}|gh workflow run/u.test(workerWorkflow)) failures.push("deployment: the vault credential is reused outside the vault");
if (/uses:\s*[^\s]+@v\d+/u.test(`${workerWorkflow}\n${pagesWorkflow}`)) failures.push("deployment: GitHub Actions are not pinned to immutable commits");
if (![...wrangler.matchAll(/\[\[ratelimits\]\]/gu)].length || !/AUTH_RATE_LIMITER/u.test(wrangler) || !/WRITE_RATE_LIMITER/u.test(wrangler)) failures.push("worker: edge rate limits are not configured");
if (!/^data\/$/mu.test(gitignore)) failures.push("gitignore: private data directory is not excluded");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Security check passed across ${files.length} project files.`);
}
