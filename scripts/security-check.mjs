import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const ignored = new Set([".git", "node_modules", "dist", ".wrangler"]);
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

const index = JSON.parse(await readFile(path.join(root, "data", "index.json"), "utf8"));
if (Object.keys(index).join(",") !== "people" || !Array.isArray(index.people)) failures.push("data/index.json: unexpected plaintext fields");
if (/name|holiday|announcement|mom|weekLabel/iu.test(JSON.stringify(index))) failures.push("data/index.json: protected plaintext detected");

const config = JSON.parse(await readFile(path.join(root, "data", "config.enc.json"), "utf8"));
if (Object.keys(config).sort().join(",") !== "cipher,kdf,version") failures.push("data/config.enc.json: not an encrypted envelope");
const configText = JSON.stringify(config);
if (/"mom"|"announcement"|"weekLabel"|\d{4}-\d{2}-\d{2}/u.test(configText)) failures.push("data/config.enc.json: protected plaintext detected");

for (const file of files.filter((candidate) => candidate.includes(`${path.sep}data${path.sep}people${path.sep}`) && candidate.endsWith(".json"))) {
  const parsed = JSON.parse(await readFile(file, "utf8"));
  if (Object.keys(parsed).sort().join(",") !== "cipher,kdf,version") failures.push(`${path.relative(root, file)}: not an encrypted envelope`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Security check passed across ${files.length} project files.`);
}
