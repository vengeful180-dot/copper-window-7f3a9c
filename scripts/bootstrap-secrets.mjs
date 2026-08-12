import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { deriveSecrets, encryptJson, hashAuthToken, makeKdf, toBase64Url } from "../assets/crypto.js";

const root = process.cwd();
const credentialPath = path.join(root, ".initial-credentials.txt");
const configPath = path.join(root, "data", "config.enc.json");
const force = process.argv.includes("--force");

if (!force && (existsSync(credentialPath) || existsSync(configPath))) {
  throw new Error("Initial encrypted data already exists. Use the password-rotation workflow instead.");
}

function randomPassword(prefix) {
  return `${prefix}_${toBase64Url(crypto.getRandomValues(new Uint8Array(24)))}`;
}

async function deriveAdminHash(password, salt) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  return toBase64Url(new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 310_000 }, material, 256)));
}

const sitePassword = randomPassword("team");
const adminPassword = randomPassword("admin");
const kdf = makeKdf();
const secrets = await deriveSecrets(sitePassword, kdf);
const config = { mom: "", weekLabel: "", announcement: "", secondaryAnnouncement: "" };
const encryptedConfig = await encryptJson(config, secrets);
const adminSalt = crypto.getRandomValues(new Uint8Array(16));
const sessionSecret = toBase64Url(crypto.getRandomValues(new Uint8Array(48)));

await mkdir(path.dirname(configPath), { recursive: true });
await mkdir(path.join(root, "data", "people"), { recursive: true });
await writeFile(configPath, `${JSON.stringify(encryptedConfig, null, 2)}\n`, "utf8");
await writeFile(path.join(root, "data", "index.json"), `${JSON.stringify({ people: [] }, null, 2)}\n`, "utf8");
await writeFile(path.join(root, "data", "people", ".gitkeep"), "", "utf8");
await writeFile(credentialPath, `SITE_PASSWORD=${sitePassword}\nADMIN_PASSWORD=${adminPassword}\n`, { encoding: "utf8", mode: 0o600 });
await writeFile(path.join(root, ".dev.vars"), [
  `SITE_AUTH_TOKEN_HASH=${await hashAuthToken(secrets.authToken)}`,
  `ADMIN_PASSWORD_HASH=${await deriveAdminHash(adminPassword, adminSalt)}`,
  `ADMIN_PASSWORD_SALT=${toBase64Url(adminSalt)}`,
  `ADMIN_SESSION_SECRET=${sessionSecret}`,
  "GITHUB_DATA_TOKEN=replace-before-running-worker",
  "GITHUB_OWNER=replace-before-running-worker",
  "GITHUB_REPO=replace-before-running-worker",
  "ALLOWED_ORIGIN=http://127.0.0.1:5173",
  "DEV_ORIGIN=http://127.0.0.1:5173",
  "",
].join("\n"), { encoding: "utf8", mode: 0o600 });

// Confirm that an accidental prior credential file was not silently reused.
const confirmation = await readFile(credentialPath, "utf8");
if (!confirmation.includes("SITE_PASSWORD=") || !confirmation.includes("ADMIN_PASSWORD=")) throw new Error("Credential output could not be confirmed.");
console.log("Created encrypted zero-person data and local, git-ignored initial credentials.");
