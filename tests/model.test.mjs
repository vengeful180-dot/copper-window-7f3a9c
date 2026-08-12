import test from "node:test";
import assert from "node:assert/strict";
import {
  addHoliday,
  canonicalName,
  dateRange,
  findPersonByName,
  monthCells,
  mergeConfigChanges,
  normalizeName,
  rangesOverlap,
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

test("handles holidays spanning two months and inclusive overlap", () => {
  const days = dateRange("2026-08-30", "2026-09-03");
  assert.deepEqual(days, ["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03"]);
  assert.equal(rangesOverlap("2026-08-20", "2026-08-25", "2026-08-25", "2026-08-28"), true);
});

test("calendar starts on Monday and always renders six complete weeks", () => {
  const cells = monthCells(2026, 7);
  assert.equal(cells.length, 42);
  assert.equal(cells[0].date.getDay(), 1);
  assert.equal(cells[0].iso, "2026-07-27");
});

test("weekly config conflicts merge different fields but reject the same field", () => {
  const original = { mom: "A", weekLabel: "Week 1", announcement: "Old", secondaryAnnouncement: "" };
  const latest = { ...original, mom: "B" };
  const desired = { ...original, announcement: "New" };
  assert.deepEqual(mergeConfigChanges(original, latest, desired), { ...latest, announcement: "New" });
  assert.throws(() => mergeConfigChanges(original, latest, { ...original, mom: "C" }), /changed elsewhere/u);
});
