import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const UUID_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.enc\.json$/iu;
const peopleDir = path.join(process.cwd(), "data", "people");
const people = (await readdir(peopleDir))
  .map((file) => file.match(UUID_FILE)?.[1]?.toLowerCase())
  .filter(Boolean)
  .sort();
await writeFile(path.join(process.cwd(), "data", "index.json"), `${JSON.stringify({ people }, null, 2)}\n`, "utf8");
console.log(`Rebuilt the anonymous index with ${people.length} identifier(s).`);
