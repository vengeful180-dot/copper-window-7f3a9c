import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { decryptJson, encryptJson, unlockJson } from "../assets/crypto.js";
import { assertConfigRecord, assertPresenceRecord, normalizeName } from "../assets/model.js";

const root = process.cwd();
const credentials = await readFile(path.join(root, ".initial-credentials.txt"), "utf8");
const credentialMap = Object.fromEntries(credentials.split(/\r?\n/u).map((line) => line.split(/=(.*)/su).slice(0, 2)).filter(([key, value]) => key && value));
const teamPassword = credentialMap[["SITE", "PASSWORD"].join("_")]?.trim();
if (!teamPassword) throw new Error("The local team credential is unavailable.");

const configPath = path.join(root, "data", "config.enc.json");
const encryptedConfig = JSON.parse(await readFile(configPath, "utf8"));
const { value: existingConfig, secrets } = await unlockJson(encryptedConfig, teamPassword);

const presencePath = path.join(root, "data", "presence.enc.json");
let presence = { version: 1, members: [] };
try { presence = assertPresenceRecord(await decryptJson(JSON.parse(await readFile(presencePath, "utf8")), secrets)); }
catch (error) { if (error?.code !== "ENOENT") throw error; }

const seedName = normalizeName(process.env.PORTAL_SEED_NAME ?? "");
if (seedName) {
  const accountFiles = (await readdir(path.join(root, "data", "accounts"))).filter((name) => name.endsWith(".json"));
  if (accountFiles.length !== 1) throw new Error("A single existing account is required for the initial roster migration.");
  const account = JSON.parse(await readFile(path.join(root, "data", "accounts", accountFiles[0]), "utf8"));
  const existing = presence.members.find((member) => member.accountId === account.id);
  if (existing) existing.displayName = seedName;
  else presence.members.push({ accountId: account.id, displayName: seedName, officeDays: [] });
}

presence = assertPresenceRecord(presence);
await writeFile(presencePath, `${JSON.stringify(await encryptJson(presence, secrets), null, 2)}\n`, "utf8");

if (process.argv.includes("--migrate-config")) {
  const config = assertConfigRecord(existingConfig);
  await writeFile(configPath, `${JSON.stringify(await encryptJson(config, secrets), null, 2)}\n`, "utf8");
}

console.log("Encrypted portal data migration completed.");
