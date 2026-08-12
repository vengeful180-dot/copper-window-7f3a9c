import { writeFile } from "node:fs/promises";
import path from "node:path";
import { toBase64Url } from "../assets/crypto.js";

const password = process.env.NEW_ADMIN_PASSWORD;
if (!password || password.length < 20) throw new Error("Set NEW_ADMIN_PASSWORD to a new value of at least 20 characters.");
const salt = crypto.getRandomValues(new Uint8Array(16));
const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
const hash = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 310_000 }, material, 256));
const output = `ADMIN_PASSWORD_HASH=${toBase64Url(hash)}\nADMIN_PASSWORD_SALT=${toBase64Url(salt)}\n`;
await writeFile(path.join(process.cwd(), ".rotation-secrets.txt"), output, { encoding: "utf8", mode: 0o600 });
console.log("Created new Admin verifier values in the git-ignored rotation file. No password was stored.");
