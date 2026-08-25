import { writeFile } from "node:fs/promises";
import path from "node:path";
import { toBase64Url } from "../assets/crypto.js";

const password = process.env.NEW_ADMIN_PASSWORD;
if (!password || password.length < 24) throw new Error("Set NEW_ADMIN_PASSWORD to a random value of at least 24 characters.");
const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey("raw", salt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const hash = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(password.normalize("NFKC"))));
const output = `ADMIN_PASSWORD_HASH=${toBase64Url(hash)}\nADMIN_PASSWORD_SALT=${toBase64Url(salt)}\n`;
await writeFile(path.join(process.cwd(), ".rotation-secrets.txt"), output, { encoding: "utf8", mode: 0o600 });
console.log("Created new Admin verifier values in the git-ignored rotation file. No password was stored.");
