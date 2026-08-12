import { api, apiConfigured, ApiError, fetchDataJson } from "./api.js";
import {
  decryptJson,
  deriveSecrets,
  digestDocument,
  encryptJson,
  exportTeamAccess,
  importTeamAccess,
  makeKdf,
  unlockJson,
} from "./crypto.js";
import {
  assertConfigRecord,
  assertPersonRecord,
  canonicalName,
  endOfWeek,
  findPersonByName,
  monthCells,
  mergeConfigChanges,
  normalizeName,
  peopleAwayBetween,
  peopleAwayOn,
  personHue,
  startOfWeek,
  todayIso,
  toIsoDate,
  validateHolidayInput,
} from "./model.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SESSION_KEY = "quiet-leave-account-session-v1";
const $ = (id) => document.getElementById(id);
const state = {
  unlocked: false,
  account: null,
  sessionToken: null,
  sessionExpiresAt: 0,
  teamAccess: null,
  secrets: null,
  config: null,
  configMeta: null,
  people: [],
  personMeta: new Map(),
  month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  adminToken: null,
  adminConfigBase: null,
  overlapConfirmation: null,
  busy: false,
};

class UserMessageError extends Error {}

function makeElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setButtonBusy(button, busy, busyText, idleText) {
  button.disabled = busy;
  button.textContent = busy ? busyText : idleText;
}

function friendlyDate(iso, options = { day: "numeric", month: "short" }) {
  return new Intl.DateTimeFormat("en-GB", options).format(new Date(`${iso}T12:00:00`));
}

function fullFriendlyDate(iso) {
  return friendlyDate(iso, { day: "numeric", month: "short", year: "numeric" });
}

function holidayLabel(holiday) {
  return holiday.start === holiday.end ? fullFriendlyDate(holiday.start) : `${friendlyDate(holiday.start)} – ${fullFriendlyDate(holiday.end)}`;
}

function showToast(message, type = "success") {
  const toast = makeElement("div", `toast${type === "error" ? " error" : ""}`, message);
  $("toastRegion").append(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

function showDialog(dialog) {
  if (!dialog.open) dialog.showModal();
}

function closeDialog(dialog) {
  if (dialog.open) dialog.close();
}

let confirmResolver = null;
function confirmAction(title, message, acceptLabel = "Delete") {
  $("confirmTitle").textContent = title;
  $("confirmMessage").textContent = message;
  $("confirmAccept").textContent = acceptLabel;
  showDialog($("confirmDialog"));
  return new Promise((resolve) => { confirmResolver = resolve; });
}

function settleConfirmation(value) {
  closeDialog($("confirmDialog"));
  if (confirmResolver) confirmResolver(value);
  confirmResolver = null;
}

function validateIndex(index) {
  if (!index || !Array.isArray(index.people) || index.people.length > 100) throw new Error("Invalid anonymous index.");
  const ids = new Set();
  for (const id of index.people) {
    if (typeof id !== "string" || !UUID.test(id) || ids.has(id)) throw new Error("Invalid anonymous index.");
    ids.add(id);
  }
  return index;
}

async function loadEncryptedFile(path) {
  const document = await fetchDataJson(path);
  return { document, digest: await digestDocument(document), sha: null };
}

async function verifiedRepositoryFile(file) {
  if (!file?.document || typeof file.digest !== "string") throw new Error("The repository returned an invalid encrypted file.");
  if (await digestDocument(file.document) !== file.digest) throw new Error("The repository file digest did not match.");
  return { document: file.document, digest: file.digest, sha: file.sha ?? null };
}

async function loadBootstrapConfig() {
  if (!apiConfigured()) return loadEncryptedFile("config.enc.json");
  const response = await api.bootstrapConfig();
  return verifiedRepositoryFile(response.file);
}

async function loadRepositoryState(secrets, sessionToken, knownConfig = null) {
  let index;
  let loadedPeople;
  let configMeta;
  if (apiConfigured()) {
    const [indexResponse, configResponse] = await Promise.all([
      api.readIndex(sessionToken),
      api.readConfig(sessionToken),
    ]);
    const indexMeta = await verifiedRepositoryFile(indexResponse.file);
    index = validateIndex(indexMeta.document);
    loadedPeople = await Promise.all(index.people.map(async (id) => {
      const response = await api.readPerson(id, sessionToken);
      const meta = await verifiedRepositoryFile(response.file);
      const person = assertPersonRecord(await decryptJson(meta.document, secrets), id);
      return { person, meta };
    }));
    configMeta = await verifiedRepositoryFile(configResponse.file);
  } else {
    index = validateIndex(await fetchDataJson("index.json"));
    loadedPeople = await Promise.all(index.people.map(async (id) => {
      const meta = await loadEncryptedFile(`people/${id}.enc.json`);
      const person = assertPersonRecord(await decryptJson(meta.document, secrets), id);
      return { person, meta };
    }));
    configMeta = knownConfig ?? await loadEncryptedFile("config.enc.json");
  }
  const config = assertConfigRecord(await decryptJson(configMeta.document, secrets));
  return {
    people: loadedPeople.map(({ person }) => person).sort((a, b) => a.name.localeCompare(b.name)),
    personMeta: new Map(loadedPeople.map(({ person, meta }) => [person.id, meta])),
    config,
    configMeta,
  };
}

function assertAccountEnvelope(value, expectedId, enteredName) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) throw new Error("Invalid account envelope.");
  if (value.accountId !== expectedId || !UUID.test(value.accountId)) throw new Error("Invalid account envelope.");
  const displayName = normalizeName(value.displayName);
  if (!displayName || displayName !== value.displayName || canonicalName(displayName) !== canonicalName(enteredName)) throw new Error("Invalid account envelope.");
  if (!value.team || Object.keys(value).sort().join(",") !== "accountId,displayName,team,version") throw new Error("Invalid account envelope.");
  return { accountId: value.accountId, displayName, team: value.team };
}

function storeSession() {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      version: 1,
      account: state.account,
      token: state.sessionToken,
      expiresAt: state.sessionExpiresAt,
      team: state.teamAccess,
    }));
  } catch { /* A privacy-restricted browser can still use the in-memory session. */ }
}

function clearStoredSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* Nothing else to clear. */ }
}

async function completeAccountLogin({ account, token, expiresIn, teamAccess, secrets = null }) {
  const activeSecrets = secrets ?? await importTeamAccess(teamAccess);
  const repositoryState = await loadRepositoryState(activeSecrets, token);
  state.account = { id: account.accountId, displayName: account.displayName };
  state.sessionToken = token;
  state.sessionExpiresAt = Date.now() + Number(expiresIn) * 1000;
  state.teamAccess = teamAccess;
  state.secrets = activeSecrets;
  state.config = repositoryState.config;
  state.configMeta = repositoryState.configMeta;
  state.people = repositoryState.people;
  state.personMeta = repositoryState.personMeta;
  state.unlocked = true;
  $("signedInName").textContent = account.displayName;
  $("unlockView").hidden = true;
  $("appView").hidden = false;
  storeSession();
  renderAll();
  void checkBackend();
}

function switchAuthView(view) {
  const login = view === "login";
  $("loginTab").classList.toggle("is-active", login);
  $("createTab").classList.toggle("is-active", !login);
  $("loginTab").setAttribute("aria-selected", String(login));
  $("createTab").setAttribute("aria-selected", String(!login));
  $("loginPanel").hidden = !login;
  $("createPanel").hidden = login;
  $("loginError").textContent = "";
  $("createError").textContent = "";
  (login ? $("loginName") : $("createName")).focus();
}

async function loginAccount(event) {
  event.preventDefault();
  if (state.busy) return;
  const name = normalizeName($("loginName").value);
  const password = $("loginPassword").value;
  const message = $("loginError");
  const submit = $("loginForm").querySelector("button[type='submit']");
  message.textContent = "";
  if (!name || !password) {
    message.textContent = "Enter your name and password.";
    return;
  }
  if (!apiConfigured()) {
    message.textContent = "Account login is not connected yet.";
    return;
  }
  state.busy = true;
  setButtonBusy(submit, true, "Logging in…", "Log in");
  try {
    const lookup = await api.accountLookup(name);
    const accountSecrets = await deriveSecrets(password, lookup.kdf);
    const response = await api.accountSession({ name, verifier: accountSecrets.authToken });
    const decrypted = await decryptJson(response.envelope, accountSecrets);
    const account = assertAccountEnvelope(decrypted, response.accountId, name);
    const secrets = await importTeamAccess(account.team);
    await completeAccountLogin({ account, token: response.token, expiresIn: response.expiresIn, teamAccess: account.team, secrets });
    $("loginForm").reset();
  } catch (error) {
    message.textContent = error instanceof ApiError && error.status === 401
      ? "Name or password is incorrect."
      : (error instanceof ApiError ? error.message : "The account could not be opened. Please try again.");
    $("loginPassword").select();
  } finally {
    state.busy = false;
    setButtonBusy(submit, false, "Logging in…", "Log in");
  }
}

async function createAccount(event) {
  event.preventDefault();
  if (state.busy) return;
  const name = normalizeName($("createName").value);
  const password = $("createPassword").value;
  const confirmation = $("confirmPassword").value;
  const teamPassword = $("teamInvitePassword").value;
  const message = $("createError");
  const submit = $("createForm").querySelector("button[type='submit']");
  message.textContent = "";
  if (!name) message.textContent = "Enter your full name.";
  else if (password.length < 12) message.textContent = "Choose a password with at least 12 characters.";
  else if (password !== confirmation) message.textContent = "The two personal passwords do not match.";
  else if (!teamPassword) message.textContent = "Enter the team invite password.";
  if (message.textContent) return;
  if (!apiConfigured()) {
    message.textContent = "Account creation is not connected yet.";
    return;
  }
  state.busy = true;
  setButtonBusy(submit, true, "Creating account…", "Create account");
  try {
    const configMeta = await loadBootstrapConfig();
    let teamSecrets;
    try { teamSecrets = (await unlockJson(configMeta.document, teamPassword)).secrets; }
    catch { throw new UserMessageError("The team invite password is incorrect."); }
    const accountId = crypto.randomUUID();
    const accountSecrets = await deriveSecrets(password, makeKdf());
    const teamAccess = exportTeamAccess(teamSecrets);
    const envelope = await encryptJson({ version: 1, accountId, displayName: name, team: teamAccess }, accountSecrets);
    const response = await api.accountRegister({
      id: accountId,
      name,
      kdf: accountSecrets.kdf,
      verifier: accountSecrets.authToken,
      envelope,
    }, teamSecrets.authToken);
    const account = { accountId, displayName: name, team: teamAccess };
    await completeAccountLogin({ account, token: response.token, expiresIn: response.expiresIn, teamAccess, secrets: teamSecrets });
    $("createForm").reset();
    showToast("Your encrypted account is ready.");
  } catch (error) {
    message.textContent = error instanceof UserMessageError || error instanceof ApiError ? error.message : "The account could not be created. Please try again.";
  } finally {
    state.busy = false;
    setButtonBusy(submit, false, "Creating account…", "Create account");
  }
}

async function restoreSession() {
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); } catch { saved = null; }
  if (!saved || saved.version !== 1 || !saved.account || !saved.team || typeof saved.token !== "string" || !Number.isFinite(saved.expiresAt) || saved.expiresAt <= Date.now()) {
    clearStoredSession();
    return;
  }
  $("loginError").textContent = "Restoring your secure session…";
  try {
    const secrets = await importTeamAccess(saved.team);
    await completeAccountLogin({
      account: { accountId: saved.account.id, displayName: saved.account.displayName },
      token: saved.token,
      expiresIn: Math.max(1, Math.floor((saved.expiresAt - Date.now()) / 1000)),
      teamAccess: saved.team,
      secrets,
    });
  } catch {
    clearStoredSession();
    $("loginError").textContent = "Your previous session ended. Log in again.";
  }
}

async function checkBackend() {
  const banner = $("backendBanner");
  if (!apiConfigured()) {
    banner.textContent = "The calendar is available in read-only mode until the secure write service is connected.";
    banner.hidden = false;
    return;
  }
  try {
    await api.health();
    banner.hidden = true;
    banner.textContent = "";
  } catch {
    banner.textContent = "The secure write service is temporarily unavailable. Viewing still works; changes are paused.";
    banner.hidden = false;
  }
}

function lockPlanner() {
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  clearStoredSession();
  state.unlocked = false;
  state.account = null;
  state.sessionToken = null;
  state.sessionExpiresAt = 0;
  state.teamAccess = null;
  state.secrets = null;
  state.config = null;
  state.configMeta = null;
  state.people = [];
  state.personMeta = new Map();
  state.adminToken = null;
  state.adminConfigBase = null;
  state.overlapConfirmation = null;
  $("momValue").textContent = "";
  $("weekLabelValue").textContent = "";
  $("announcementValue").textContent = "";
  $("secondaryAnnouncementValue").textContent = "";
  $("signedInName").textContent = "";
  for (const id of ["awayTodayList", "awayWeekList", "peopleList", "calendarGrid", "mobileAgenda", "adminPeopleList"]) $(id).replaceChildren();
  $("adminPassword").value = "";
  $("loginForm").reset();
  $("createForm").reset();
  $("appView").hidden = true;
  $("unlockView").hidden = false;
  switchAuthView("login");
}

function setProtectedText(node, value, fallback) {
  node.textContent = value || fallback;
  node.classList.toggle("empty-copy", !value);
}

function renderWeekly() {
  const weekStart = startOfWeek();
  const weekEnd = endOfWeek();
  const computedWeek = `${friendlyDate(toIsoDate(weekStart))} – ${fullFriendlyDate(toIsoDate(weekEnd))}`;
  setProtectedText($("momValue"), state.config.mom, "Not set");
  setProtectedText($("weekLabelValue"), state.config.weekLabel, computedWeek);
  setProtectedText($("announcementValue"), state.config.announcement, "No announcement this week");
  $("secondaryAnnouncementValue").textContent = state.config.secondaryAnnouncement;
  $("secondaryAnnouncementValue").hidden = !state.config.secondaryAnnouncement;
}

function activeHoliday(person, start, end = start) {
  return person.holidays.find((holiday) => holiday.start <= end && holiday.end >= start) ?? null;
}

function renderPersonSummary(list, people, emptyMessage) {
  list.replaceChildren();
  if (!people.length) {
    list.append(makeElement("p", "list-empty", emptyMessage));
    return;
  }
  const weekStart = toIsoDate(startOfWeek());
  const weekEnd = toIsoDate(endOfWeek());
  for (const person of people) {
    const row = makeElement("div", "person-row");
    row.style.setProperty("--person-hue", personHue(person.id));
    row.append(makeElement("span", "person-dot"));
    const copy = makeElement("div", "person-copy");
    copy.append(makeElement("p", "person-name", person.name));
    const holiday = activeHoliday(person, todayIso()) ?? activeHoliday(person, weekStart, weekEnd);
    if (holiday) copy.append(makeElement("p", "person-dates", holidayLabel(holiday)));
    row.append(copy);
    list.append(row);
  }
}

function renderSummaries() {
  const today = todayIso();
  const weekStart = toIsoDate(startOfWeek());
  const weekEnd = toIsoDate(endOfWeek());
  const awayToday = peopleAwayOn(state.people, today);
  const awayWeek = peopleAwayBetween(state.people, weekStart, weekEnd);
  $("awayTodayCount").textContent = String(awayToday.length);
  $("awayWeekCount").textContent = String(awayWeek.length);
  $("peopleCount").textContent = String(state.people.length);
  renderPersonSummary($("awayTodayList"), awayToday, "Everyone is here today.");
  renderPersonSummary($("awayWeekList"), awayWeek, "No one is away this week.");
  const teamList = $("peopleList");
  teamList.replaceChildren();
  if (!state.people.length) {
    teamList.append(makeElement("p", "list-empty", "People appear automatically when their first holiday is added."));
  } else {
    for (const person of state.people) {
      const row = makeElement("div", "team-row");
      row.style.setProperty("--person-hue", personHue(person.id));
      row.append(makeElement("span", "person-dot"), makeElement("span", "person-name", person.name));
      row.append(makeElement("span", "holiday-total", `${person.holidays.length} ${person.holidays.length === 1 ? "holiday" : "holidays"}`));
      teamList.append(row);
    }
  }
}

function holidaysForDate(iso) {
  const entries = [];
  for (const person of state.people) {
    for (const holiday of person.holidays) {
      if (holiday.start <= iso && holiday.end >= iso) entries.push({ person, holiday });
    }
  }
  return entries.sort((a, b) => a.person.name.localeCompare(b.person.name));
}

function makeHolidayButton(person, holiday, className = "holiday-chip") {
  const button = makeElement("button", className);
  button.type = "button";
  button.style.setProperty("--person-hue", personHue(person.id));
  if (className === "holiday-chip") {
    button.textContent = person.name;
    button.title = `${person.name}: ${holidayLabel(holiday)}`;
  } else {
    button.append(makeElement("strong", "", person.name), makeElement("span", "", holidayLabel(holiday)));
  }
  button.addEventListener("click", () => openHolidayEditor(person.id, holiday.id));
  return button;
}

function renderCalendar() {
  const year = state.month.getFullYear();
  const month = state.month.getMonth();
  $("monthTitle").textContent = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(state.month);
  $("calendarLoading").hidden = true;
  const hasHolidays = state.people.some((person) => person.holidays.length);
  $("calendarEmpty").hidden = hasHolidays;
  $("calendarDesktop").hidden = !hasHolidays;
  $("mobileAgenda").hidden = !hasHolidays;
  if (!hasHolidays) return;

  const grid = $("calendarGrid");
  grid.replaceChildren();
  const today = todayIso();
  for (const cell of monthCells(year, month)) {
    const day = makeElement("div", "calendar-day");
    day.setAttribute("role", "gridcell");
    day.setAttribute("aria-label", friendlyDate(cell.iso, { weekday: "long", day: "numeric", month: "long", year: "numeric" }));
    if (!cell.currentMonth) day.classList.add("outside-month");
    if (cell.iso === today) day.classList.add("is-today");
    day.append(makeElement("span", "day-number", String(cell.date.getDate())));
    const events = makeElement("div", "day-holidays");
    const entries = holidaysForDate(cell.iso);
    for (const { person, holiday } of entries.slice(0, 3)) events.append(makeHolidayButton(person, holiday));
    if (entries.length > 3) events.append(makeElement("span", "holiday-overflow", `+${entries.length - 3} more`));
    day.append(events);
    grid.append(day);
  }

  const agenda = $("mobileAgenda");
  agenda.replaceChildren();
  const monthDays = monthCells(year, month).filter((cell) => cell.currentMonth && holidaysForDate(cell.iso).length);
  if (!monthDays.length) {
    agenda.append(makeElement("p", "agenda-none", "No one is away this month."));
  } else {
    for (const cell of monthDays) {
      const day = makeElement("section", "agenda-day");
      const date = makeElement("div", "agenda-date");
      date.append(makeElement("strong", "", String(cell.date.getDate())), document.createTextNode(new Intl.DateTimeFormat("en-GB", { weekday: "short" }).format(cell.date)));
      const events = makeElement("div", "agenda-events");
      for (const { person, holiday } of holidaysForDate(cell.iso)) events.append(makeHolidayButton(person, holiday, "agenda-event"));
      day.append(date, events);
      agenda.append(day);
    }
  }
}

function renderAll() {
  $("headerDate").textContent = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" }).format(new Date());
  renderWeekly();
  renderSummaries();
  renderCalendar();
  if (!$("adminPanel").hidden) renderAdminPeople();
}

function openAddHoliday() {
  if (!apiConfigured()) {
    showToast("Secure writes are not connected yet.", "error");
    return;
  }
  $("holidayForm").reset();
  $("editPersonId").value = "";
  $("editHolidayId").value = "";
  $("employeeName").readOnly = false;
  $("employeeName").value = state.account?.displayName ?? "";
  $("holidayStart").value = todayIso();
  $("holidayEnd").value = todayIso();
  $("holidayModalEyebrow").textContent = "New time away";
  $("holidayModalTitle").textContent = "Add holiday";
  $("deleteHolidayButton").hidden = true;
  $("saveHolidayButton").textContent = "Save holiday";
  $("holidayFormMessage").textContent = "";
  state.overlapConfirmation = null;
  showDialog($("holidayDialog"));
  $("employeeName").focus();
}

function openHolidayEditor(personId, holidayId) {
  const person = state.people.find((candidate) => candidate.id === personId);
  const holiday = person?.holidays.find((candidate) => candidate.id === holidayId);
  if (!person || !holiday) return;
  $("editPersonId").value = personId;
  $("editHolidayId").value = holidayId;
  $("employeeName").value = person.name;
  $("employeeName").readOnly = true;
  $("holidayStart").value = holiday.start;
  $("holidayEnd").value = holiday.end;
  $("holidayModalEyebrow").textContent = "Adjust time away";
  $("holidayModalTitle").textContent = "Edit holiday";
  $("deleteHolidayButton").hidden = false;
  $("saveHolidayButton").textContent = "Save changes";
  $("holidayFormMessage").textContent = "";
  state.overlapConfirmation = null;
  showDialog($("holidayDialog"));
  $("holidayStart").focus();
}

async function reloadPeople() {
  const repositoryState = await loadRepositoryState(state.secrets, state.sessionToken, state.configMeta);
  state.people = repositoryState.people;
  state.personMeta = repositoryState.personMeta;
  state.config = repositoryState.config;
  state.configMeta = repositoryState.configMeta;
  renderAll();
}

async function verifiedPerson(file, id) {
  if (!file?.document || typeof file.digest !== "string") throw new Error("The repository did not confirm the change.");
  const person = assertPersonRecord(await decryptJson(file.document, state.secrets), id);
  const digest = await digestDocument(file.document);
  if (digest !== file.digest) throw new Error("The repository confirmation did not match.");
  return { person, meta: { document: file.document, digest: file.digest, sha: file.sha ?? null } };
}

async function commitPersonMutation(personId, mutate, { admin = false } = {}) {
  let base = structuredClone(state.people.find((person) => person.id === personId));
  let meta = state.personMeta.get(personId);
  if (!base || !meta) throw new UserMessageError("That person is no longer available.");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = assertPersonRecord(mutate(structuredClone(base)), personId);
    const document = await encryptJson(next, state.secrets);
    try {
      const response = admin
        ? await api.adminUpdatePerson(personId, { document, expectedDigest: meta.digest }, state.adminToken)
        : await api.updatePerson(personId, { document, expectedDigest: meta.digest }, state.sessionToken);
      const verified = await verifiedPerson(response.file, personId);
      const index = state.people.findIndex((person) => person.id === personId);
      state.people[index] = verified.person;
      state.people.sort((a, b) => a.name.localeCompare(b.name));
      state.personMeta.set(personId, verified.meta);
      renderAll();
      return verified.person;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.details?.latest?.document) {
        base = assertPersonRecord(await decryptJson(error.details.latest.document, state.secrets), personId);
        meta = error.details.latest;
        continue;
      }
      if (error instanceof ApiError && error.status === 401 && admin) state.adminToken = null;
      throw error;
    }
  }
  throw new UserMessageError("Someone else changed this record at the same time. Reload and try once more.");
}

async function createPersonWithHoliday(input) {
  await reloadPeople();
  const existing = findPersonByName(state.people, input.name);
  if (existing) return addHolidayToExisting(existing, input);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const personId = crypto.randomUUID();
    const person = {
      id: personId,
      name: normalizeName(input.name),
      holidays: [{ id: crypto.randomUUID(), start: input.start, end: input.end }],
    };
    const document = await encryptJson(person, state.secrets);
    try {
      const response = await api.createPerson({ id: personId, document }, state.sessionToken);
      const verified = await verifiedPerson(response.person, personId);
      state.people.push(verified.person);
      state.people.sort((a, b) => a.name.localeCompare(b.name));
      state.personMeta.set(personId, verified.meta);
      renderAll();
      return verified.person;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) continue;
      throw error;
    }
  }
  throw new UserMessageError("A unique person record could not be created. Please try again.");
}

async function addHolidayToExisting(person, input) {
  const holiday = { id: crypto.randomUUID(), start: input.start, end: input.end };
  return commitPersonMutation(person.id, (latest) => {
    if (latest.holidays.some((item) => item.start === holiday.start && item.end === holiday.end)) throw new UserMessageError("This exact holiday range already exists.");
    latest.holidays.push(holiday);
    latest.holidays.sort((a, b) => a.start.localeCompare(b.start));
    return latest;
  });
}

async function saveHoliday(event) {
  event.preventDefault();
  if (state.busy) return;
  const personId = $("editPersonId").value;
  const holidayId = $("editHolidayId").value;
  const input = { name: $("employeeName").value, start: $("holidayStart").value, end: $("holidayEnd").value };
  const person = personId ? state.people.find((candidate) => candidate.id === personId) : findPersonByName(state.people, input.name);
  const validation = validateHolidayInput(input, person?.holidays ?? [], holidayId || null);
  const message = $("holidayFormMessage");
  message.textContent = validation.errors.join(" ");
  if (!validation.valid) return;
  const overlapKey = `${person?.id ?? canonicalName(input.name)}:${input.start}:${input.end}:${holidayId}`;
  if (validation.overlaps.length && state.overlapConfirmation !== overlapKey) {
    state.overlapConfirmation = overlapKey;
    message.textContent = "This overlaps another holiday for the same person. Submit again to save it anyway.";
    $("saveHolidayButton").textContent = "Save anyway";
    return;
  }
  state.busy = true;
  const saveButton = $("saveHolidayButton");
  const idleText = holidayId ? "Save changes" : "Save holiday";
  setButtonBusy(saveButton, true, "Saving…", idleText);
  try {
    if (holidayId) {
      const original = structuredClone(person.holidays.find((holiday) => holiday.id === holidayId));
      await commitPersonMutation(person.id, (latest) => {
        const target = latest.holidays.find((holiday) => holiday.id === holidayId);
        if (!target) throw new UserMessageError("This holiday was removed by someone else.");
        if (target.start !== original.start || target.end !== original.end) throw new UserMessageError("Someone else edited this holiday first. Reopen it to see their change.");
        target.start = input.start;
        target.end = input.end;
        latest.holidays.sort((a, b) => a.start.localeCompare(b.start));
        return latest;
      });
      showToast("Holiday updated and confirmed in GitHub.");
    } else if (person) {
      await addHolidayToExisting(person, input);
      showToast("Holiday added and confirmed in GitHub.");
    } else {
      await createPersonWithHoliday(input);
      showToast(`${validation.normalizedName} was added with their first holiday.`);
    }
    closeDialog($("holidayDialog"));
  } catch (error) {
    message.textContent = error instanceof UserMessageError || error instanceof ApiError ? error.message : "The holiday could not be saved.";
  } finally {
    state.busy = false;
    setButtonBusy(saveButton, false, "Saving…", idleText);
  }
}

async function deleteHoliday() {
  const personId = $("editPersonId").value;
  const holidayId = $("editHolidayId").value;
  const person = state.people.find((candidate) => candidate.id === personId);
  const holiday = person?.holidays.find((candidate) => candidate.id === holidayId);
  if (!person || !holiday) return;
  closeDialog($("holidayDialog"));
  const confirmed = await confirmAction("Delete this holiday?", `${person.name} · ${holidayLabel(holiday)} will be removed. This cannot be undone.`);
  if (!confirmed) {
    showDialog($("holidayDialog"));
    return;
  }
  try {
    await commitPersonMutation(personId, (latest) => {
      const current = latest.holidays.find((item) => item.id === holidayId);
      if (!current) return latest;
      if (current.start !== holiday.start || current.end !== holiday.end) throw new UserMessageError("Someone else edited this holiday first. It was not deleted.");
      latest.holidays = latest.holidays.filter((item) => item.id !== holidayId);
      return latest;
    });
    showToast("Holiday deleted and confirmed in GitHub.");
  } catch (error) {
    showToast(error.message || "The holiday could not be deleted.", "error");
  }
}

function resetOverlapConfirmation() {
  state.overlapConfirmation = null;
  $("saveHolidayButton").textContent = $("editHolidayId").value ? "Save changes" : "Save holiday";
  $("holidayFormMessage").textContent = "";
}

function openAdmin() {
  if (!apiConfigured()) {
    showToast("Admin controls need the secure write service.", "error");
    return;
  }
  $("adminLoginMessage").textContent = "";
  if (state.adminToken) showAdminPanel();
  else {
    $("adminLoginForm").hidden = false;
    $("adminPanel").hidden = true;
  }
  showDialog($("adminDialog"));
  if (!state.adminToken) $("adminPassword").focus();
}

function showAdminPanel() {
  $("adminLoginForm").hidden = true;
  $("adminPanel").hidden = false;
  $("momInput").value = state.config.mom;
  $("weekLabelInput").value = state.config.weekLabel;
  $("announcementInput").value = state.config.announcement;
  $("secondaryAnnouncementInput").value = state.config.secondaryAnnouncement;
  state.adminConfigBase = structuredClone(state.config);
  $("configFormMessage").textContent = "";
  renderAdminPeople();
}

async function adminLogin(event) {
  event.preventDefault();
  if (state.busy) return;
  const password = $("adminPassword").value;
  const message = $("adminLoginMessage");
  const button = $("adminLoginForm").querySelector("button[type='submit']");
  message.textContent = "";
  if (!password) {
    message.textContent = "Enter the Admin password.";
    return;
  }
  state.busy = true;
  setButtonBusy(button, true, "Checking…", "Continue");
  try {
    const response = await api.adminSession(password);
    state.adminToken = response.token;
    $("adminPassword").value = "";
    showAdminPanel();
  } catch (error) {
    message.textContent = error.status === 401 ? "Incorrect Admin password." : error.message;
    $("adminPassword").select();
  } finally {
    state.busy = false;
    setButtonBusy(button, false, "Checking…", "Continue");
  }
}

async function saveConfig(event) {
  event.preventDefault();
  if (state.busy) return;
  const changes = {
    mom: normalizeName($("momInput").value),
    weekLabel: $("weekLabelInput").value.trim().replace(/\s+/gu, " "),
    announcement: $("announcementInput").value.trim(),
    secondaryAnnouncement: $("secondaryAnnouncementInput").value.trim(),
  };
  try {
    assertConfigRecord(changes);
  } catch (error) {
    $("configFormMessage").textContent = error.message;
    return;
  }
  const button = $("configForm").querySelector("button[type='submit']");
  const original = structuredClone(state.adminConfigBase ?? state.config);
  const changedFields = Object.keys(changes).filter((field) => changes[field] !== original[field]);
  if (!changedFields.length) {
    $("configFormMessage").textContent = "There are no changes to save.";
    return;
  }
  state.busy = true;
  setButtonBusy(button, true, "Saving…", "Save weekly info");
  let base = structuredClone(state.config);
  let meta = state.configMeta;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let next;
      try { next = mergeConfigChanges(original, base, changes); }
      catch (error) { throw new UserMessageError(error.message); }
      const document = await encryptJson(next, state.secrets);
      try {
        const response = await api.updateConfig({ document, expectedDigest: meta.digest }, state.adminToken);
        const confirmed = assertConfigRecord(await decryptJson(response.file.document, state.secrets));
        if (await digestDocument(response.file.document) !== response.file.digest) throw new Error("The repository confirmation did not match.");
        state.config = confirmed;
        state.adminConfigBase = structuredClone(confirmed);
        state.configMeta = { document: response.file.document, digest: response.file.digest, sha: response.file.sha ?? null };
        renderAll();
        $("configFormMessage").textContent = "Saved and confirmed in GitHub.";
        $("configFormMessage").classList.add("success");
        showToast("Weekly information updated.");
        return;
      } catch (error) {
        if (error instanceof ApiError && error.status === 409 && error.details?.latest?.document) {
          base = assertConfigRecord(await decryptJson(error.details.latest.document, state.secrets));
          meta = error.details.latest;
          continue;
        }
        if (error instanceof ApiError && error.status === 401) state.adminToken = null;
        throw error;
      }
    }
    throw new UserMessageError("The weekly information changed elsewhere. Reopen Admin and try again.");
  } catch (error) {
    $("configFormMessage").classList.remove("success");
    $("configFormMessage").textContent = error.message || "The weekly information could not be saved.";
  } finally {
    state.busy = false;
    setButtonBusy(button, false, "Saving…", "Save weekly info");
  }
}

function renderAdminPeople() {
  const list = $("adminPeopleList");
  list.replaceChildren();
  if (!state.people.length) {
    list.append(makeElement("p", "list-empty", "No people have been created yet."));
    return;
  }
  for (const person of state.people) {
    const row = makeElement("div", "admin-person");
    const input = document.createElement("input");
    input.value = person.name;
    input.maxLength = 80;
    input.setAttribute("aria-label", `Display name for ${person.name}`);
    const rename = makeElement("button", "button button-secondary button-small", "Save name");
    rename.type = "button";
    rename.addEventListener("click", () => renamePerson(person.id, input, rename));
    const remove = makeElement("button", "button button-danger button-small", "Delete person");
    remove.type = "button";
    remove.addEventListener("click", () => deletePerson(person.id));
    row.append(input, rename, remove);
    list.append(row);
  }
}

async function renamePerson(personId, input, button) {
  const person = state.people.find((candidate) => candidate.id === personId);
  const name = normalizeName(input.value);
  if (!name) {
    showToast("Enter a valid display name.", "error");
    input.focus();
    return;
  }
  const duplicate = state.people.find((candidate) => candidate.id !== personId && canonicalName(candidate.name) === canonicalName(name));
  if (duplicate) {
    showToast("That display name already belongs to another person.", "error");
    input.focus();
    return;
  }
  const originalName = person.name;
  setButtonBusy(button, true, "Saving…", "Save name");
  try {
    await commitPersonMutation(personId, (latest) => {
      if (latest.name !== originalName) throw new UserMessageError("Someone else renamed this person first. Reload Admin to see the change.");
      latest.name = name;
      return latest;
    }, { admin: true });
    showToast("Display name updated.");
  } catch (error) {
    showToast(error.message || "The name could not be updated.", "error");
  } finally {
    setButtonBusy(button, false, "Saving…", "Save name");
  }
}

async function deletePerson(personId) {
  const person = state.people.find((candidate) => candidate.id === personId);
  if (!person) return;
  const confirmed = await confirmAction("Delete this person?", `${person.name} and all ${person.holidays.length} of their holiday records will be removed. This cannot be undone.`, "Delete person");
  if (!confirmed) return;
  try {
    await api.adminDeletePerson(personId, state.adminToken);
    state.people = state.people.filter((candidate) => candidate.id !== personId);
    state.personMeta.delete(personId);
    renderAll();
    showToast(`${person.name} was deleted.`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) state.adminToken = null;
    showToast(error.message || "The person could not be deleted.", "error");
  }
}

function changeMonth(offset) {
  state.month = new Date(state.month.getFullYear(), state.month.getMonth() + offset, 1);
  renderCalendar();
}

function bindEvents() {
  $("loginTab").addEventListener("click", () => switchAuthView("login"));
  $("createTab").addEventListener("click", () => switchAuthView("create"));
  $("loginForm").addEventListener("submit", loginAccount);
  $("createForm").addEventListener("submit", createAccount);
  $("lockButton").addEventListener("click", lockPlanner);
  $("addHolidayButton").addEventListener("click", openAddHoliday);
  $("emptyAddButton").addEventListener("click", openAddHoliday);
  $("holidayForm").addEventListener("submit", saveHoliday);
  $("deleteHolidayButton").addEventListener("click", deleteHoliday);
  for (const id of ["employeeName", "holidayStart", "holidayEnd"]) $(id).addEventListener("input", resetOverlapConfirmation);
  $("adminButton").addEventListener("click", openAdmin);
  $("adminLoginForm").addEventListener("submit", adminLogin);
  $("configForm").addEventListener("submit", saveConfig);
  $("previousMonth").addEventListener("click", () => changeMonth(-1));
  $("nextMonth").addEventListener("click", () => changeMonth(1));
  $("todayButton").addEventListener("click", () => { state.month = new Date(new Date().getFullYear(), new Date().getMonth(), 1); renderCalendar(); });
  $("confirmCancel").addEventListener("click", () => settleConfirmation(false));
  $("confirmAccept").addEventListener("click", () => settleConfirmation(true));
  $("confirmDialog").addEventListener("cancel", (event) => { event.preventDefault(); settleConfirmation(false); });
  for (const button of document.querySelectorAll("[data-close-dialog]")) {
    button.addEventListener("click", () => closeDialog($(button.dataset.closeDialog)));
  }
}

bindEvents();
void restoreSession();
