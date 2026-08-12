const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;

export function normalizeName(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(CONTROL_CHARACTERS, " ")
    .trim()
    .replace(/\s+/gu, " ")
    .slice(0, 80);
}

export function canonicalName(value) {
  return normalizeName(value).toLocaleLowerCase("en-US");
}

export function findPersonByName(people, name) {
  const key = canonicalName(name);
  return people.find((person) => canonicalName(person.name) === key) ?? null;
}

export function parseIsoDate(value) {
  if (!ISO_DATE.test(value ?? "")) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

export function isIsoDate(value) {
  return parseIsoDate(value) !== null;
}

export function toIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function todayIso(now = new Date()) {
  return toIsoDate(now);
}

export function compareIsoDates(a, b) {
  return String(a).localeCompare(String(b));
}

export function dateRange(start, end, maximumDays = 370) {
  const first = parseIsoDate(start);
  const last = parseIsoDate(end);
  if (!first || !last || first > last) return [];
  const result = [];
  const cursor = new Date(first);
  while (cursor <= last && result.length < maximumDays) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

export function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

export function validateHolidayInput(input, holidays = [], editingHolidayId = null) {
  const normalizedName = normalizeName(input.name);
  const errors = [];
  if (!normalizedName) errors.push("Enter an employee name.");
  if (!isIsoDate(input.start)) errors.push("Choose a valid start date.");
  if (!isIsoDate(input.end)) errors.push("Choose a valid end date.");
  if (isIsoDate(input.start) && isIsoDate(input.end) && input.end < input.start) errors.push("The end date cannot be before the start date.");
  if (isIsoDate(input.start) && isIsoDate(input.end) && dateRange(input.start, input.end, 368).length > 367) errors.push("A holiday cannot be longer than 12 months.");

  const comparable = holidays.filter((holiday) => holiday.id !== editingHolidayId);
  const duplicate = comparable.find((holiday) => holiday.start === input.start && holiday.end === input.end);
  if (duplicate) errors.push("This exact holiday range already exists.");
  const overlaps = comparable.filter((holiday) => rangesOverlap(input.start, input.end, holiday.start, holiday.end));
  return { valid: errors.length === 0, errors, normalizedName, overlaps };
}

export function createHolidayRecord(start, end, idFactory = () => crypto.randomUUID()) {
  return { id: idFactory(), start, end };
}

export function addHoliday(people, input, idFactory = () => crypto.randomUUID()) {
  const existing = findPersonByName(people, input.name);
  const holiday = createHolidayRecord(input.start, input.end, idFactory);
  if (existing) {
    existing.holidays.push(holiday);
    existing.holidays.sort((a, b) => compareIsoDates(a.start, b.start));
    return { person: existing, holiday, createdPerson: false };
  }
  const person = { id: idFactory(), name: normalizeName(input.name), holidays: [holiday] };
  people.push(person);
  people.sort((a, b) => a.name.localeCompare(b.name));
  return { person, holiday, createdPerson: true };
}

export function peopleAwayOn(people, isoDate) {
  return people.filter((person) => person.holidays.some((holiday) => holiday.start <= isoDate && holiday.end >= isoDate));
}

export function startOfWeek(date = new Date()) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = result.getDay() || 7;
  result.setDate(result.getDate() - day + 1);
  return result;
}

export function endOfWeek(date = new Date()) {
  const result = startOfWeek(date);
  result.setDate(result.getDate() + 6);
  return result;
}

export function peopleAwayBetween(people, start, end) {
  return people.filter((person) => person.holidays.some((holiday) => rangesOverlap(start, end, holiday.start, holiday.end)));
}

export function personHue(id) {
  let hash = 2166136261;
  for (const character of String(id)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 360;
}

export function monthCells(year, monthIndex) {
  const first = new Date(year, monthIndex, 1);
  const mondayOffset = (first.getDay() + 6) % 7;
  const start = new Date(year, monthIndex, 1 - mondayOffset);
  const cells = [];
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    cells.push({ date, iso: toIsoDate(date), currentMonth: date.getMonth() === monthIndex });
  }
  return cells;
}

export function assertPersonRecord(record, expectedId = null) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Invalid person record.");
  if (typeof record.id !== "string" || (expectedId && record.id !== expectedId)) throw new Error("Invalid person identifier.");
  if (!normalizeName(record.name) || record.name !== normalizeName(record.name)) throw new Error("Invalid person name.");
  if (!Array.isArray(record.holidays)) throw new Error("Invalid holiday list.");
  const ids = new Set();
  for (const holiday of record.holidays) {
    if (!holiday || typeof holiday.id !== "string" || ids.has(holiday.id)) throw new Error("Invalid holiday identifier.");
    if (!isIsoDate(holiday.start) || !isIsoDate(holiday.end) || holiday.end < holiday.start) throw new Error("Invalid holiday dates.");
    ids.add(holiday.id);
  }
  return record;
}

export function assertConfigRecord(config) {
  const fields = ["mom", "weekLabel", "announcement", "secondaryAnnouncement"];
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid weekly information.");
  for (const field of fields) {
    if (typeof config[field] !== "string") throw new Error("Invalid weekly information.");
    const limit = field.includes("announcement") || field === "announcement" ? 500 : 80;
    if (config[field].length > limit) throw new Error("Weekly information is too long.");
  }
  return config;
}

export function mergeConfigChanges(original, latest, desired) {
  assertConfigRecord(original);
  assertConfigRecord(latest);
  assertConfigRecord(desired);
  const next = { ...latest };
  for (const field of Object.keys(desired)) {
    if (desired[field] === original[field]) continue;
    if (latest[field] !== original[field]) throw new Error(`“${field}” changed elsewhere. Reopen Admin before replacing it.`);
    next[field] = desired[field];
  }
  return next;
}
