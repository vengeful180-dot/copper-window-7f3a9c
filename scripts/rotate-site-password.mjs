import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { decryptJson, deriveSecrets, encryptJson, hashAuthToken, makeKdf, toBase64Url } from "../assets/crypto.js";

const root = process.cwd();
const credentialPath = path.join(root, ".initial-credentials.txt");
const generate = process.env.GENERATE_NEW_SITE_PASSWORD === "1";
let credentialText = "";
let oldPassword = process.env.OLD_SITE_PASSWORD;
let newPassword = process.env.NEW_SITE_PASSWORD;
if (generate) {
  credentialText = await readFile(credentialPath, "utf8");
  const credentials = Object.fromEntries(credentialText.trim().split(/\r?\n/u).map((line) => {
    const splitAt = line.indexOf("=");
    return [line.slice(0, splitAt), line.slice(splitAt + 1)];
  }));
  oldPassword = credentials.SITE_PASSWORD;
  newPassword = `team_${toBase64Url(crypto.getRandomValues(new Uint8Array(24)))}`;
}
if (!oldPassword || !newPassword || newPassword.length < 20) throw new Error("Set OLD_SITE_PASSWORD and a NEW_SITE_PASSWORD of at least 20 characters, or set GENERATE_NEW_SITE_PASSWORD=1.");

const configPath = path.join(root, "data", "config.enc.json");
const peopleDir = path.join(root, "data", "people");
const accountsDir = path.join(root, "data", "accounts");
const accountFiles = (await readdir(accountsDir, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
if (accountFiles.length) throw new Error("Remove or recreate personal accounts before rotating the team encryption key.");
const configDocument = JSON.parse(await readFile(configPath, "utf8"));
const oldSecrets = await deriveSecrets(oldPassword, configDocument.kdf);
const config = await decryptJson(configDocument, oldSecrets);
const files = (await readdir(peopleDir)).filter((file) => file.endsWith(".enc.json"));
const records = [];
for (const file of files) {
  const document = JSON.parse(await readFile(path.join(peopleDir, file), "utf8"));
  records.push({ file, value: await decryptJson(document, oldSecrets) });
}

const nextSecrets = await deriveSecrets(newPassword, makeKdf());
await writeFile(configPath, `${JSON.stringify(await encryptJson(config, nextSecrets), null, 2)}\n`, "utf8");
for (const record of records) {
  await writeFile(path.join(peopleDir, record.file), `${JSON.stringify(await encryptJson(record.value, nextSecrets), null, 2)}\n`, "utf8");
}
const nextVerifier = await hashAuthToken(nextSecrets.authToken);
await writeFile(path.join(root, ".rotation-secrets.txt"), `SITE_AUTH_TOKEN_HASH=${nextVerifier}\n`, { encoding: "utf8", mode: 0o600 });
if (generate) {
  const nextCredentialText = credentialText.replace(/^SITE_PASSWORD=.*$/mu, `SITE_PASSWORD=${newPassword}`);
  await writeFile(credentialPath, nextCredentialText, { encoding: "utf8", mode: 0o600 });
  for (const varsPath of [path.join(root, ".dev.vars"), path.join(root, "worker", ".dev.vars")]) {
    const vars = await readFile(varsPath, "utf8").catch(() => "");
    if (vars) await writeFile(varsPath, vars.replace(/^SITE_AUTH_TOKEN_HASH=.*$/mu, `SITE_AUTH_TOKEN_HASH=${nextVerifier}`), { encoding: "utf8", mode: 0o600 });
  }
}
console.log(`Re-encrypted config and ${records.length} person record(s). Update the Worker SITE_AUTH_TOKEN_HASH before publishing these files.`);
