import test from "node:test";
import assert from "node:assert/strict";
import {
  addHoliday,
  assertConfigRecord,
  assertPresenceRecord,
  canonicalName,
  countHolidayWeekdays,
  dateRange,
  findPersonByName,
  holidayForAccountDay,
  isOfficeDay,
  isWeekendIso,
  monthCells,
  mergeConfigChanges,
  nextWorkingDayIso,
  normalizeName,
  peopleAwayBetween,
  peopleAwayOn,
  rangesOverlap,
  rangesOverlapOnWorkingDay,
  reconcileCurrentPresenceMember,
  twoWorkWeeks,
  validateHolidayInput,
} from "../assets/model.js";

test("normalizes capitalization keys and duplicate whitespace", () => {
  assert.equal(normalizeName("  John\t  Smith  "), "John Smith");
  assert.equal(canonicalName(" JOHN   SMITH "), canonicalName("john smith"));
});

test("first holiday creates a person and later spelling variants reuse that person", () => {
  const ids = ["holiday-1", "person-1", "holiday-2"];
  const people = [];
  const first = addHoliday(people, { name: " John  Smith ", start: "2026-08-20", end: "2026-08-25" }, () => ids.shift());
  assert.equal(first.createdPerson, true);
  assert.equal(people.length, 1);
  assert.equal(people[0].name, "John Smith");
  const second = addHoliday(people, { name: "john smith", start: "2026-12-21", end: "2026-12-31" }, () => ids.shift());
  assert.equal(second.createdPerson, false);
  assert.equal(people.length, 1);
  assert.equal(people[0].holidays.length, 2);
  assert.equal(findPersonByName(people, " JOHN   SMITH ").id, "person-1");
});

test("a second distinct name creates a second person", () => {
  const ids = ["holiday-a", "person-a", "holiday-b", "person-b"];
  const people = [];
  addHoliday(people, { name: "John Smith", start: "2026-08-20", end: "2026-08-25" }, () => ids.shift());
  addHoliday(people, { name: "Maria Pop", start: "2026-09-01", end: "2026-09-03" }, () => ids.shift());
  assert.equal(people.length, 2);
});

test("validates dates, exact duplicates, and overlapping ranges", () => {
  const existing = [{ id: "h1", start: "2026-08-20", end: "2026-08-25" }];
  const duplicate = validateHolidayInput({ name: "John", start: "2026-08-20", end: "2026-08-25" }, existing);
  assert.match(duplicate.errors.join(" "), /exact holiday range/u);
  const overlap = validateHolidayInput({ name: "John", start: "2026-08-24", end: "2026-08-28" }, existing);
  assert.equal(overlap.valid, true);
  assert.equal(overlap.overlaps.length, 1);
  const reversed = validateHolidayInput({ name: "John", start: "2026-08-28", end: "2026-08-20" }, existing);
  assert.match(reversed.errors.join(" "), /cannot be before/u);
});

test("rejects weekend endpoints but allows a holiday to pass over a weekend", () => {
  const saturday = validateHolidayInput({ name: "John", start: "2026-08-15", end: "2026-08-15" });
  assert.equal(saturday.valid, false);
  assert.match(saturday.errors.join(" "), /Saturday or Sunday/u);
  const sundayEnd = validateHolidayInput({ name: "John", start: "2026-08-14", end: "2026-08-16" });
  assert.equal(sundayEnd.valid, false);
  const fridayToMonday = validateHolidayInput({ name: "John", start: "2026-08-14", end: "2026-08-17" });
  assert.equal(fridayToMonday.valid, true);
  assert.equal(isWeekendIso("2026-08-15"), true);
  assert.equal(isWeekendIso("2026-08-17"), false);
  assert.equal(nextWorkingDayIso("2026-08-15"), "2026-08-17");
});

test("weekends do not count as away days in calendar summaries", () => {
  const people = [{ id: "person-1", name: "John", holidays: [{ id: "holiday-1", start: "2026-08-14", end: "2026-08-17" }] }];
  assert.equal(peopleAwayOn(people, "2026-08-14").length, 1);
  assert.equal(peopleAwayOn(people, "2026-08-15").length, 0);
  assert.equal(peopleAwayOn(people, "2026-08-17").length, 1);
  assert.equal(peopleAwayBetween(people, "2026-08-15", "2026-08-16").length, 0);
  assert.equal(peopleAwayBetween(people, "2026-08-10", "2026-08-16").length, 1);
  assert.equal(rangesOverlapOnWorkingDay("2026-08-14", "2026-08-17", "2026-08-15", "2026-08-16"), false);
});

test("handles holidays spanning two months and inclusive overlap", () => {
  const days = dateRange("2026-08-30", "2026-09-03");
  assert.deepEqual(days, ["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03"]);
  assert.equal(rangesOverlap("2026-08-20", "2026-08-25", "2026-08-25", "2026-08-28"), true);
});

test("counts unique weekday holiday days inside the displayed range", () => {
  const holidays = [
    { id: "h1", start: "2026-08-13", end: "2026-08-17" },
    { id: "h2", start: "2026-08-17", end: "2026-08-19" },
    { id: "h3", start: "2026-09-01", end: "2026-09-02" },
  ];
  assert.equal(countHolidayWeekdays(holidays, "2026-08-01", "2026-08-31"), 5);
  assert.equal(countHolidayWeekdays(holidays, "2026-08-17", "2026-08-31"), 3);
  assert.equal(countHolidayWeekdays(holidays, "2026-09-01", "2026-09-30"), 2);
});

test("calendar starts on Monday and always renders six complete weeks", () => {
  const cells = monthCells(2026, 7);
  assert.equal(cells.length, 42);
  assert.equal(cells[0].date.getDay(), 1);
  assert.equal(cells[0].iso, "2026-07-27");
});

test("homepage config validates links and merges different fields safely", () => {
  const links = Array.from({ length: 6 }, () => ({ label: "", url: "" }));
  const original = { version: 2, groupName: "Dream Team", mom: "A", links, officeDays: [] };
  const latest = { ...original, mom: "B" };
  const desired = { ...original, groupName: "Great Team" };
  const featureDefaults = { shoutouts: { start: "", end: "", people: [] }, birthdays: [] };
  const legacyBridge = { ...featureDefaults, weekLabel: "", announcement: "", secondaryAnnouncement: "" };
  assert.deepEqual(mergeConfigChanges(original, latest, desired), { ...latest, ...legacyBridge, groupName: "Great Team" });
  assert.throws(() => mergeConfigChanges(original, latest, { ...original, mom: "C" }), /changed elsewhere/u);
  assert.equal(assertConfigRecord({ mom: "Legacy MOM", weekLabel: "", announcement: "", secondaryAnnouncement: "" }).groupName, "Dream Team");
  assert.deepEqual(assertConfigRecord(original), { ...original, ...legacyBridge });
  assert.throws(() => assertConfigRecord({ ...original, links: [{ label: "Bad", url: "javascript:alert(1)" }, ...links.slice(1)] }), /https:\/\//u);
  assert.throws(() => assertConfigRecord({ ...original, links: [{ label: "Insecure", url: "http://example.com" }, ...links.slice(1)] }), /https:\/\//u);
  assert.throws(() => assertConfigRecord({ ...original, officeDays: ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"] }), /no more than 4/u);
  assert.throws(() => assertConfigRecord({ ...original, officeDays: ["2026-08-08"] }), /weekday office dates/u);
  const features = assertConfigRecord({
    ...original,
    shoutouts: { start: "2026-08-25", end: "2026-08-31", people: ["Ana Pop", "Mara Ionescu"] },
    birthdays: [{ name: "Victor Stan", date: "1992-08-29" }],
  });
  assert.deepEqual(features.shoutouts.people, ["Ana Pop", "Mara Ionescu"]);
  assert.equal(features.birthdays[0].date, "1992-08-29");
  assert.throws(() => assertConfigRecord({ ...original, shoutouts: { start: "2026-08-31", end: "2026-08-25", people: ["Ana Pop"] } }), /valid shoutout period/u);
  assert.throws(() => assertConfigRecord({ ...original, birthdays: [{ name: "Ana Pop", date: "1990-08-10" }, { name: "ana pop", date: "1991-09-11" }] }), /unique name/u);
});

test("work-location records default to home and produce current and next weekdays", () => {
  const accountId = "33333333-3333-4333-8333-333333333333";
  const presence = assertPresenceRecord({ version: 1, members: [{ accountId, displayName: "John Smith", officeDays: ["2026-08-13"] }] });
  assert.deepEqual(presence.members[0].officeDays, ["2026-08-13"]);
  assert.deepEqual(presence.members[0].homeDays, []);
  assert.equal(presence.members[0].officeDays.includes("2026-08-12"), false);
  const weeks = twoWorkWeeks(new Date(2026, 7, 12, 12));
  assert.deepEqual(weeks.map((week) => week.days), [
    ["2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14"],
    ["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21"],
  ]);
  assert.throws(() => assertPresenceRecord({ version: 1, members: [{ accountId, displayName: "John Smith", officeDays: ["2026-08-15"] }] }), /office day/u);
});

test("a recreated account reclaims its existing work-location row by name", () => {
  const staleAccountId = "11111111-1111-4111-8111-111111111111";
  const currentAccountId = "22222222-2222-4222-8222-222222222222";
  const original = { version: 1, members: [{ accountId: staleAccountId, displayName: "John Smith", officeDays: ["2026-08-13"], homeDays: ["2026-08-14"] }] };
  const result = reconcileCurrentPresenceMember(original, { id: currentAccountId, displayName: "John Smith" });
  assert.equal(result.changed, true);
  assert.deepEqual(result.presence.members, [{ accountId: currentAccountId, displayName: "John Smith", officeDays: ["2026-08-13"], homeDays: ["2026-08-14"] }]);
  assert.equal(reconcileCurrentPresenceMember(result.presence, { id: currentAccountId, displayName: "John Smith" }).changed, false);
});

test("team office days remain defaults that each person can override to home", () => {
  const base = { officeDays: [], homeDays: [] };
  assert.equal(isOfficeDay(base, ["2026-08-14"], "2026-08-14"), true);
  assert.equal(isOfficeDay({ ...base, homeDays: ["2026-08-14"] }, ["2026-08-14"], "2026-08-14"), false);
  assert.equal(isOfficeDay({ ...base, officeDays: ["2026-08-17"] }, [], "2026-08-17"), true);
  assert.equal(isOfficeDay(base, ["2026-08-15"], "2026-08-15"), false);
});

test("a matching holiday overrides an account work day", () => {
  const people = [{ id: "person-1", name: "John Smith", holidays: [{ id: "holiday-1", start: "2026-08-12", end: "2026-08-14" }] }];
  assert.equal(holidayForAccountDay(people, " john  smith ", "2026-08-13")?.id, "holiday-1");
  assert.equal(holidayForAccountDay(people, "John Smith", "2026-08-17"), null);
});
