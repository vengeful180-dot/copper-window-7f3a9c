import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { decryptJson, deriveSecrets, encryptJson } from "../assets/crypto.js";
import { assertPresenceRecord } from "../assets/model.js";
import { validateOwnershipRecord } from "../worker/src/validation.js";

const root = process.cwd();
const credentials = Object.fromEntries((await readFile(path.join(root, ".initial-credentials.txt"), "utf8")).trim().split(/\r?\n/u).map((line) => {
  const splitAt = line.indexOf("=");
  return [line.slice(0, splitAt), line.slice(splitAt + 1)];
}));
const demoPeople = [
  ["Demo Sofia Marin", [["2026-08-10", "2026-08-12"], ["2026-09-14", "2026-09-18"]]],
  ["Demo Alex Ionescu", [["2026-08-11", "2026-08-14"]]],
  ["Demo Mara Pop", [["2026-08-12", "2026-08-13"], ["2026-08-31", "2026-09-04"]]],
  ["Demo Victor Stan", [["2026-08-12", "2026-08-14"]]],
  ["Demo Elena Radu", [["2026-08-17", "2026-08-19"]]],
  ["Demo Luca Petrescu", [["2026-08-18", "2026-08-21"]]],
  ["Demo Ana Dumitru", [["2026-08-19", "2026-08-21"]]],
  ["Demo David Matei", [["2026-08-20", "2026-08-21"], ["2026-09-21", "2026-09-25"]]],
  ["Demo Ioana Pavel", [["2026-08-24", "2026-08-28"]]],
  ["Demo Andrei Muresan", [["2026-08-25", "2026-08-27"]]],
  ["Demo Bianca Tudor", [["2026-08-27", "2026-08-31"]]],
  ["Demo Rares Ilie", [["2026-09-01", "2026-09-03"]]],
  ["Demo Cristina Neagu", [["2026-09-07", "2026-09-11"]]],
  ["Demo Stefan Dinu", [["2026-09-08", "2026-09-10"]]],
  ["Demo Nadia Ene", [["2026-09-28", "2026-10-02"]]],
];
const demoOfficeDays = new Map([
  ["Demo Sofia Marin", ["2026-08-13", "2026-08-14", "2026-08-17", "2026-08-18", "2026-08-20"]],
  ["Demo Alex Ionescu", ["2026-08-10", "2026-08-17", "2026-08-19", "2026-08-21"]],
  ["Demo Mara Pop", ["2026-08-10", "2026-08-11", "2026-08-14", "2026-08-17", "2026-08-18", "2026-08-20"]],
  ["Demo Victor Stan", ["2026-08-10", "2026-08-11", "2026-08-17", "2026-08-18", "2026-08-19"]],
  ["Demo Elena Radu", ["2026-08-10", "2026-08-12", "2026-08-14", "2026-08-20", "2026-08-21"]],
  ["Demo Luca Petrescu", ["2026-08-11", "2026-08-13", "2026-08-14", "2026-08-17"]],
  ["Demo Ana Dumitru", ["2026-08-10", "2026-08-12", "2026-08-14", "2026-08-17", "2026-08-18"]],
  ["Demo David Matei", ["2026-08-11", "2026-08-12", "2026-08-14", "2026-08-17", "2026-08-18", "2026-08-19"]],
  ["Demo Ioana Pavel", ["2026-08-10", "2026-08-12", "2026-08-13", "2026-08-14", "2026-08-17", "2026-08-19", "2026-08-21"]],
  ["Demo Andrei Muresan", ["2026-08-10", "2026-08-11", "2026-08-13", "2026-08-17", "2026-08-18", "2026-08-20", "2026-08-21"]],
  ["Demo Bianca Tudor", ["2026-08-11", "2026-08-12", "2026-08-14", "2026-08-17", "2026-08-19", "2026-08-21"]],
  ["Demo Rares Ilie", ["2026-08-10", "2026-08-13", "2026-08-14", "2026-08-18", "2026-08-20"]],
  ["Demo Cristina Neagu", ["2026-08-11", "2026-08-12", "2026-08-17", "2026-08-19", "2026-08-21"]],
  ["Demo Stefan Dinu", ["2026-08-10", "2026-08-12", "2026-08-14", "2026-08-18", "2026-08-20"]],
  ["Demo Nadia Ene", ["2026-08-11", "2026-08-13", "2026-08-17", "2026-08-18", "2026-08-21"]],
]);

if (!credentials.SITE_PASSWORD) throw new Error("The local team encryption password is unavailable.");

const indexPath = path.join(root, "data", "index.json");
const peopleDirectory = path.join(root, "data", "people");
const configDocument = JSON.parse(await readFile(path.join(root, "data", "config.enc.json"), "utf8"));
const secrets = await deriveSecrets(credentials.SITE_PASSWORD, configDocument.kdf);
await decryptJson(configDocument, secrets);

const existing = JSON.parse(await readFile(indexPath, "utf8"));
const existingNames = new Set();
const peopleByName = new Map();
for (const id of existing.people ?? []) {
  const document = JSON.parse(await readFile(path.join(peopleDirectory, `${id}.enc.json`), "utf8"));
  const person = await decryptJson(document, secrets);
  existingNames.add(person.name);
  peopleByName.set(person.name, person);
}

const additions = [];
for (const [name, ranges] of demoPeople) {
  if (existingNames.has(name)) continue;
  const id = crypto.randomUUID();
  const person = { id, name, holidays: ranges.map(([start, end]) => ({ id: crypto.randomUUID(), start, end })) };
  const document = await encryptJson(person, secrets);
  additions.push({ id, document, person });
  peopleByName.set(name, person);
}

for (const { id, document } of additions) {
  await writeFile(path.join(peopleDirectory, `${id}.enc.json`), `${JSON.stringify(document, null, 2)}\n`, "utf8");
}
if (additions.length) {
  existing.people.push(...additions.map(({ id }) => id));
  await writeFile(indexPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
}

console.log(`Created ${additions.length} encrypted demo people; ${demoPeople.length - additions.length} already existed.`);

const presencePath = path.join(root, "data", "presence.enc.json");
const presenceDocument = JSON.parse(await readFile(presencePath, "utf8"));
const presence = assertPresenceRecord(await decryptJson(presenceDocument, secrets));
let scheduleMembersAdded = 0;
for (const [name] of demoPeople) {
  const person = peopleByName.get(name);
  if (!person) throw new Error(`The demo person ${name} is unavailable.`);
  const existingMember = presence.members.find((member) => member.displayName === name || member.accountId === person.id);
  if (existingMember) {
    if (existingMember.accountId !== person.id || existingMember.displayName !== name) throw new Error(`The demo schedule member ${name} conflicts with an existing member.`);
    continue;
  }
  presence.members.push({ accountId: person.id, displayName: name, officeDays: demoOfficeDays.get(name) ?? [] });
  scheduleMembersAdded += 1;
}
const validatedPresence = assertPresenceRecord(presence);
if (scheduleMembersAdded) await writeFile(presencePath, `${JSON.stringify(await encryptJson(validatedPresence, secrets), null, 2)}\n`, "utf8");
console.log(`Added ${scheduleMembersAdded} encrypted demo work schedules; ${demoPeople.length - scheduleMembersAdded} already existed.`);

const ownersDirectory = path.join(root, "data", "owners");
await mkdir(ownersDirectory, { recursive: true });
let ownersCreated = 0;
for (const member of validatedPresence.members) {
  const person = peopleByName.get(member.displayName);
  if (!person || member.accountId === person.id) continue;
  const ownership = validateOwnershipRecord({ version: 1, accountId: member.accountId });
  const ownerPath = path.join(ownersDirectory, `${person.id}.json`);
  let existingOwner = null;
  try { existingOwner = validateOwnershipRecord(JSON.parse(await readFile(ownerPath, "utf8"))); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (existingOwner) {
    if (existingOwner.accountId !== ownership.accountId) throw new Error(`The ownership record for ${member.displayName} conflicts with the current account.`);
    continue;
  }
  await writeFile(ownerPath, `${JSON.stringify(ownership, null, 2)}\n`, "utf8");
  ownersCreated += 1;
}
console.log(`Created ${ownersCreated} opaque holiday ownership records.`);

const finalIndex = JSON.parse(await readFile(indexPath, "utf8"));
let verifiedDemoPeople = 0;
let verifiedDemoHolidays = 0;
for (const id of finalIndex.people) {
  const document = JSON.parse(await readFile(path.join(peopleDirectory, `${id}.enc.json`), "utf8"));
  const person = await decryptJson(document, secrets);
  if (!person.name.startsWith("Demo ")) continue;
  verifiedDemoPeople += 1;
  verifiedDemoHolidays += person.holidays.length;
}
if (verifiedDemoPeople !== demoPeople.length) throw new Error("The encrypted demo population did not verify correctly.");
console.log(`Verified ${verifiedDemoPeople} encrypted demo people with ${verifiedDemoHolidays} holiday ranges.`);
const verifiedPresenceDocument = JSON.parse(await readFile(presencePath, "utf8"));
const verifiedPresence = assertPresenceRecord(await decryptJson(verifiedPresenceDocument, secrets));
const verifiedDemoSchedules = verifiedPresence.members.filter((member) => peopleByName.get(member.displayName)?.id === member.accountId);
if (verifiedDemoSchedules.length !== demoPeople.length) throw new Error("The encrypted demo work schedules did not verify correctly.");
console.log(`Verified ${verifiedDemoSchedules.length} encrypted demo work schedules.`);
