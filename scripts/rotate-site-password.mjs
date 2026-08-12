import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { decryptJson, deriveSecrets, encryptJson, hashAuthToken, makeKdf } from "../assets/crypto.js";

const oldPassword = process.env.OLD_SITE_PASSWORD;
const newPassword = process.env.NEW_SITE_PASSWORD;
if (!oldPassword || !newPassword || newPassword.length < 20) throw new Error("Set OLD_SITE_PASSWORD and a NEW_SITE_PASSWORD of at least 20 characters.");

const root = process.cwd();
const configPath = path.join(root, "data", "config.enc.json");
const peopleDir = path.join(root, "data", "people");
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
await writeFile(path.join(root, ".rotation-secrets.txt"), `SITE_AUTH_TOKEN_HASH=${await hashAuthToken(nextSecrets.authToken)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(`Re-encrypted config and ${records.length} person record(s). Update the Worker SITE_AUTH_TOKEN_HASH before publishing these files.`);
