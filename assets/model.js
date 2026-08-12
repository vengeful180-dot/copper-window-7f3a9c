const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;
export const QUICK_LINK_COUNT = 6;
export const MONTHLY_OFFICE_DAY_LIMIT = 4;

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

export function isWeekendIso(value) {
  const date = parseIsoDate(value);
  return Boolean(date && (date.getUTCDay() === 0 || date.getUTCDay() === 6));
}

export function nextWorkingDayIso(value) {
  const date = parseIsoDate(value);
  if (!date) return null;
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
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

export function rangesOverlapOnWorkingDay(aStart, aEnd, bStart, bEnd) {
  const overlapStart = aStart > bStart ? aStart : bStart;
  const overlapEnd = aEnd < bEnd ? aEnd : bEnd;
  return dateRange(overlapStart, overlapEnd, 7).some((iso) => !isWeekendIso(iso));
}

export function validateHolidayInput(input, holidays = [], editingHolidayId = null) {
  const normalizedName = normalizeName(input.name);
  const errors = [];
  const validStart = isIsoDate(input.start);
  const validEnd = isIsoDate(input.end);
  if (!normalizedName) errors.push("Enter an employee name.");
  if (!validStart) errors.push("Choose a valid start date.");
  if (!validEnd) errors.push("Choose a valid end date.");
  if ((validStart && isWeekendIso(input.start)) || (validEnd && isWeekendIso(input.end))) errors.push("Holidays cannot start or end on Saturday or Sunday.");
  if (validStart && validEnd && input.end < input.start) errors.push("The end date cannot be before the start date.");
  if (validStart && validEnd && dateRange(input.start, input.end, 368).length > 367) errors.push("A holiday cannot be longer than 12 months.");

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
  if (!isIsoDate(isoDate) || isWeekendIso(isoDate)) return [];
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
  return people.filter((person) => person.holidays.some((holiday) => rangesOverlapOnWorkingDay(start, end, holiday.start, holiday.end)));
}

export function countHolidayWeekdays(holidays, start, end) {
  if (!Array.isArray(holidays) || !isIsoDate(start) || !isIsoDate(end) || end < start) return 0;
  const days = new Set();
  for (const holiday of holidays) {
    const overlapStart = holiday.start > start ? holiday.start : start;
    const overlapEnd = holiday.end < end ? holiday.end : end;
    for (const iso of dateRange(overlapStart, overlapEnd, 32)) {
      if (!isWeekendIso(iso)) days.add(iso);
    }
  }
  return days.size;
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
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid homepage settings.");

  // Accept the previous encrypted shape during deployment and upgrade it in memory.
  if (config.version === undefined && ["mom", "weekLabel", "announcement", "secondaryAnnouncement"].every((field) => typeof config[field] === "string")) {
    if (config.mom.length > 80) throw new Error("Homepage information is too long.");
    return {
      version: 2,
      groupName: "Dream Team",
      mom: config.mom,
      links: Array.from({ length: QUICK_LINK_COUNT }, () => ({ label: "", url: "" })),
      officeDays: [],
      weekLabel: "",
      announcement: "",
      secondaryAnnouncement: "",
    };
  }

  if (config.version !== 2 || typeof config.groupName !== "string" || typeof config.mom !== "string" || !Array.isArray(config.links)) throw new Error("Invalid homepage settings.");
  const groupName = normalizeName(config.groupName);
  if (!groupName || groupName !== config.groupName || groupName.length > 80) throw new Error("Enter a valid group name.");
  if (config.mom.length > 1_200) throw new Error("MOM can be up to 1,200 characters.");
  if (config.links.length !== QUICK_LINK_COUNT) throw new Error(`Add exactly ${QUICK_LINK_COUNT} quick-link slots.`);
  const links = config.links.map((link) => {
    if (!link || typeof link !== "object" || Array.isArray(link) || Object.keys(link).sort().join(",") !== "label,url") throw new Error("Invalid quick link.");
    const label = normalizeName(link.label);
    const url = typeof link.url === "string" ? link.url.trim() : "";
    if (label.length > 40 || url.length > 500) throw new Error("A quick link is too long.");
    if (Boolean(label) !== Boolean(url)) throw new Error("Each quick link needs both a name and a URL.");
    if (url) {
      let parsed;
      try { parsed = new URL(url); } catch { throw new Error("Use a complete link beginning with https:// or http://."); }
      if (!["https:", "http:"].includes(parsed.protocol)) throw new Error("Quick links must begin with https:// or http://.");
    }
    return { label, url };
  });
  if (config.officeDays !== undefined && !Array.isArray(config.officeDays)) throw new Error("Invalid team office days.");
  const officeDays = [];
  const seenOfficeDays = new Set();
  const officeDaysPerMonth = new Map();
  for (const iso of config.officeDays ?? []) {
    if (!isIsoDate(iso) || isWeekendIso(iso) || seenOfficeDays.has(iso)) throw new Error("Choose unique weekday office dates.");
    const monthKey = iso.slice(0, 7);
    const monthCount = (officeDaysPerMonth.get(monthKey) ?? 0) + 1;
    if (monthCount > MONTHLY_OFFICE_DAY_LIMIT) throw new Error(`Choose no more than ${MONTHLY_OFFICE_DAY_LIMIT} team office days in a month.`);
    seenOfficeDays.add(iso);
    officeDaysPerMonth.set(monthKey, monthCount);
    officeDays.push(iso);
  }
  // Keep empty legacy fields in the encrypted document so an older cached page
  // can still finish login while the cache-busted portal assets are loading.
  return {
    version: 2,
    groupName,
    mom: config.mom.trim(),
    links,
    officeDays: officeDays.sort(compareIsoDates),
    weekLabel: "",
    announcement: "",
    secondaryAnnouncement: "",
  };
}

export function mergeConfigChanges(original, latest, desired) {
  const safeOriginal = assertConfigRecord(original);
  const safeLatest = assertConfigRecord(latest);
  const safeDesired = assertConfigRecord(desired);
  const next = structuredClone(safeLatest);
  for (const field of ["groupName", "mom", "links", "officeDays"]) {
    const before = JSON.stringify(safeOriginal[field]);
    if (JSON.stringify(safeDesired[field]) === before) continue;
    if (JSON.stringify(safeLatest[field]) !== before) throw new Error(`“${field}” changed elsewhere. Reopen Admin before replacing it.`);
    next[field] = structuredClone(safeDesired[field]);
  }
  return next;
}

export function assertPresenceRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record) || record.version !== 1 || !Array.isArray(record.members) || record.members.length > 100) throw new Error("Invalid work-location schedule.");
  const accountIds = new Set();
  const names = new Set();
  const members = record.members.map((member) => {
    const memberKeys = member && typeof member === "object" && !Array.isArray(member) ? Object.keys(member).sort().join(",") : "";
    if (!["accountId,displayName,officeDays", "accountId,displayName,homeDays,officeDays"].includes(memberKeys)) throw new Error("Invalid work-location member.");
    const displayName = normalizeName(member.displayName);
    const nameKey = canonicalName(displayName);
    if (!UUID.test(member.accountId ?? "") || !displayName || displayName !== member.displayName || accountIds.has(member.accountId) || names.has(nameKey) || !Array.isArray(member.officeDays) || member.officeDays.length > 520 || (member.homeDays !== undefined && (!Array.isArray(member.homeDays) || member.homeDays.length > 520))) throw new Error("Invalid work-location member.");
    const officeDays = [];
    const seenDays = new Set();
    for (const iso of member.officeDays) {
      if (!isIsoDate(iso) || isWeekendIso(iso) || seenDays.has(iso)) throw new Error("Invalid office day.");
      seenDays.add(iso);
      officeDays.push(iso);
    }
    const homeDays = [];
    const seenHomeDays = new Set();
    for (const iso of member.homeDays ?? []) {
      if (!isIsoDate(iso) || isWeekendIso(iso) || seenHomeDays.has(iso) || seenDays.has(iso)) throw new Error("Invalid home override day.");
      seenHomeDays.add(iso);
      homeDays.push(iso);
    }
    accountIds.add(member.accountId);
    names.add(nameKey);
    return { accountId: member.accountId.toLowerCase(), displayName, officeDays: officeDays.sort(compareIsoDates), homeDays: homeDays.sort(compareIsoDates) };
  });
  members.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { version: 1, members };
}

export function isOfficeDay(member, teamOfficeDays, iso) {
  if (!isIsoDate(iso) || isWeekendIso(iso)) return false;
  if (member?.homeDays?.includes(iso)) return false;
  return Boolean(member?.officeDays?.includes(iso) || teamOfficeDays?.includes(iso));
}

export function twoWorkWeeks(now = new Date()) {
  const firstMonday = startOfWeek(now);
  return [0, 1].map((weekOffset) => {
    const monday = new Date(firstMonday);
    monday.setDate(monday.getDate() + weekOffset * 7);
    const days = Array.from({ length: 5 }, (_, dayOffset) => {
      const date = new Date(monday);
      date.setDate(date.getDate() + dayOffset);
      return toIsoDate(date);
    });
    return { start: days[0], end: days[4], days };
  });
}

export function holidayForAccountDay(people, displayName, iso) {
  const person = findPersonByName(people, displayName);
  return person?.holidays.find((holiday) => holiday.start <= iso && holiday.end >= iso) ?? null;
}
