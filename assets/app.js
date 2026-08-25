import { api, apiConfigured, ApiError } from "./api.js?v=20260825-private-data-v1";
import {
  decryptJson,
  deriveSecrets,
  digestDocument,
  encryptJson,
  exportTeamAccess,
  importTeamAccess,
  makeKdf,
} from "./crypto.js?v=20260812-header-fix";
import {
  assertConfigRecord,
  assertPersonRecord,
  assertPresenceRecord,
  canonicalName,
  countHolidayWeekdays,
  endOfWeek,
  findPersonByName,
  holidayForAccountDay,
  isOfficeDay,
  isWeekendIso,
  monthCells,
  mergeConfigChanges,
  nextWorkingDayIso,
  normalizeName,
  parseIsoDate,
  personHue,
  peopleAwayBetween,
  peopleAwayOn,
  rangesOverlapOnWorkingDay,
  reconcileCurrentPresenceMember,
  startOfWeek,
  todayIso,
  toIsoDate,
  twoWorkWeeks,
  validateHolidayInput,
} from "./model.js?v=20260825-security-v1";

if (window.top !== window.self) {
  document.body.replaceChildren();
  throw new Error("This page cannot run inside a frame.");
}
document.documentElement.classList.add("is-top-level");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MIN_ACCOUNT_PASSWORD_LENGTH = 8;
const MIN_TEAM_INVITE_PASSWORD_LENGTH = 7;
const LEGACY_SESSION_KEY = "quiet-leave-account-session-v1";
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const $ = (id) => document.getElementById(id);
const state = {
  unlocked: false,
  account: null,
  sessionToken: null,
  sessionExpiresAt: 0,
  sessionExpiryTimer: null,
  sessionIdleTimer: null,
  sessionLastActivityAt: 0,
  teamAccess: null,
  secrets: null,
  config: null,
  configMeta: null,
  people: [],
  personMeta: new Map(),
  presence: { version: 1, members: [] },
  presenceMeta: null,
  currentView: "home",
  month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  adminToken: null,
  adminExpiresAt: 0,
  adminExpiryTimer: null,
  adminConfigBase: null,
  pendingAdminFeature: null,
  overlapConfirmation: null,
  datePickerTarget: null,
  datePickerMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  officeDaysMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  officeDaysDraft: [],
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

function setHolidayDate(inputId, iso, notify = true) {
  const input = $(inputId);
  const display = $(`${inputId}Display`);
  const trigger = $(`${inputId}Button`);
  input.value = iso || "";
  display.textContent = iso ? fullFriendlyDate(iso) : "Choose a date";
  trigger.classList.toggle("is-placeholder", !iso);
  if (notify) input.dispatchEvent(new Event("input", { bubbles: true }));
}

function datePickerFocusDay() {
  const grid = $("datePickerGrid");
  const preferred = grid.querySelector(".date-picker-day.is-selected:not(:disabled)")
    ?? grid.querySelector(".date-picker-day.is-today:not(:disabled)")
    ?? grid.querySelector(".date-picker-day:not(:disabled)");
  preferred?.focus();
}

function renderDatePicker() {
  const year = state.datePickerMonth.getFullYear();
  const month = state.datePickerMonth.getMonth();
  const selected = state.datePickerTarget ? $(state.datePickerTarget).value : "";
  $("datePickerTitle").textContent = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(state.datePickerMonth);
  const grid = $("datePickerGrid");
  grid.replaceChildren();
  for (const cell of monthCells(year, month)) {
    const weekend = isWeekendIso(cell.iso);
    const day = makeElement("button", "date-picker-day", String(cell.date.getDate()));
    day.type = "button";
    day.dataset.iso = cell.iso;
    day.disabled = weekend;
    day.setAttribute("aria-label", `${friendlyDate(cell.iso, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}${weekend ? ", unavailable" : ""}`);
    if (!cell.currentMonth) day.classList.add("outside-month");
    if (cell.iso === selected) {
      day.classList.add("is-selected");
      day.setAttribute("aria-pressed", "true");
    }
    if (cell.iso === todayIso()) day.classList.add("is-today");
    if (!weekend) day.addEventListener("click", () => selectDatePickerDay(cell.iso));
    grid.append(day);
  }
}

function openDatePicker(inputId) {
  if (!["holidayStart", "holidayEnd"].includes(inputId)) return;
  state.datePickerTarget = inputId;
  const selected = parseIsoDate($(inputId).value) ?? parseIsoDate(nextWorkingDayIso(todayIso()));
  state.datePickerMonth = new Date(selected.getUTCFullYear(), selected.getUTCMonth(), 1);
  $("datePickerFieldLabel").textContent = inputId === "holidayStart" ? "Choose start date" : "Choose end date";
  renderDatePicker();
  showDialog($("datePickerDialog"));
  window.requestAnimationFrame(datePickerFocusDay);
}

function closeDatePicker() {
  const target = state.datePickerTarget;
  closeDialog($("datePickerDialog"));
  state.datePickerTarget = null;
  if (target) $(`${target}Button`).focus();
}

function selectDatePickerDay(iso) {
  if (!state.datePickerTarget || isWeekendIso(iso)) return;
  setHolidayDate(state.datePickerTarget, iso);
  closeDatePicker();
}

function changeDatePickerMonth(offset) {
  state.datePickerMonth = new Date(state.datePickerMonth.getFullYear(), state.datePickerMonth.getMonth() + offset, 1);
  renderDatePicker();
  window.requestAnimationFrame(datePickerFocusDay);
}

function handleDatePickerKeys(event) {
  const current = event.target.closest(".date-picker-day");
  if (!current) return;
  const movement = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
  if (!movement) return;
  event.preventDefault();
  const days = [...$("datePickerGrid").querySelectorAll(".date-picker-day")];
  let index = days.indexOf(current) + movement;
  while (days[index]?.disabled) index += Math.sign(movement);
  days[index]?.focus();
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

async function verifiedRepositoryFile(file) {
  if (!file?.document || typeof file.digest !== "string") throw new Error("The repository returned an invalid encrypted file.");
  if (await digestDocument(file.document) !== file.digest) throw new Error("The repository file digest did not match.");
  return { document: file.document, digest: file.digest, sha: file.sha ?? null };
}

async function loadBootstrapConfig(siteToken) {
  const response = await api.bootstrapConfig(siteToken);
  return verifiedRepositoryFile(response.file);
}

async function loadRepositoryState(secrets, sessionToken) {
  if (!apiConfigured()) throw new UserMessageError("The protected team service is unavailable.");
  const [indexResponse, configResponse, presenceResponse] = await Promise.all([
    api.readIndex(sessionToken),
    api.readConfig(sessionToken),
    api.readPresence(sessionToken),
  ]);
  const indexMeta = await verifiedRepositoryFile(indexResponse.file);
  const index = validateIndex(indexMeta.document);
  const loadedPeople = await Promise.all(index.people.map(async (id) => {
    const response = await api.readPerson(id, sessionToken);
    const meta = await verifiedRepositoryFile(response.file);
    const person = assertPersonRecord(await decryptJson(meta.document, secrets), id);
    return { person, meta };
  }));
  const configMeta = await verifiedRepositoryFile(configResponse.file);
  const presenceMeta = await verifiedRepositoryFile(presenceResponse.file);
  const config = assertConfigRecord(await decryptJson(configMeta.document, secrets));
  const presence = assertPresenceRecord(await decryptJson(presenceMeta.document, secrets));
  return {
    people: loadedPeople.map(({ person }) => person).sort((a, b) => a.name.localeCompare(b.name)),
    personMeta: new Map(loadedPeople.map(({ person, meta }) => [person.id, meta])),
    config,
    configMeta,
    presence,
    presenceMeta,
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

function clearLegacyStoredSession() {
  try { sessionStorage.removeItem(LEGACY_SESSION_KEY); } catch { /* Nothing else to clear. */ }
}

function clearAccountSessionTimers() {
  if (state.sessionExpiryTimer !== null) window.clearTimeout(state.sessionExpiryTimer);
  if (state.sessionIdleTimer !== null) window.clearTimeout(state.sessionIdleTimer);
  state.sessionExpiryTimer = null;
  state.sessionIdleTimer = null;
}

function endAccountSession(message) {
  if (!state.unlocked) return;
  lockPlanner();
  $("loginError").textContent = message;
}

function scheduleAccountSessionTimers({ resetActivity = true } = {}) {
  clearAccountSessionTimers();
  if (!state.unlocked) return;
  const now = Date.now();
  if (resetActivity || !state.sessionLastActivityAt) state.sessionLastActivityAt = now;
  const expiryRemaining = state.sessionExpiresAt - now;
  const idleRemaining = SESSION_IDLE_TIMEOUT_MS - (now - state.sessionLastActivityAt);
  if (expiryRemaining <= 0) {
    endAccountSession("Your login session expired. Log in again.");
    return;
  }
  if (idleRemaining <= 0) {
    endAccountSession("You were logged out after being inactive. Log in again.");
    return;
  }
  state.sessionExpiryTimer = window.setTimeout(
    () => endAccountSession("Your login session expired. Log in again."),
    expiryRemaining,
  );
  state.sessionIdleTimer = window.setTimeout(
    () => endAccountSession("You were logged out after being inactive. Log in again."),
    idleRemaining,
  );
}

function recordAccountActivity(event) {
  if (!state.unlocked || !event.isTrusted) return;
  state.sessionLastActivityAt = Date.now();
  if (state.sessionIdleTimer !== null) window.clearTimeout(state.sessionIdleTimer);
  state.sessionIdleTimer = window.setTimeout(
    () => endAccountSession("You were logged out after being inactive. Log in again."),
    SESSION_IDLE_TIMEOUT_MS,
  );
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
  state.presence = repositoryState.presence;
  state.presenceMeta = repositoryState.presenceMeta;
  state.unlocked = true;
  $("signedInName").textContent = account.displayName;
  $("unlockView").hidden = true;
  $("appView").hidden = false;
  scheduleAccountSessionTimers();
  setView(location.hash.replace(/^#/u, "") || "home", { updateHash: false });
  renderAll();
  void ensureCurrentAccountInPresence();
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
  let credentialsAccepted = false;
  try {
    const lookup = await api.accountLookup(name);
    const accountSecrets = await deriveSecrets(password, lookup.kdf);
    const response = await api.accountSession({ name, verifier: accountSecrets.authToken });
    credentialsAccepted = true;
    const decrypted = await decryptJson(response.envelope, accountSecrets);
    const account = assertAccountEnvelope(decrypted, response.accountId, name);
    const secrets = await importTeamAccess(account.team);
    await completeAccountLogin({ account, token: response.token, expiresIn: response.expiresIn, teamAccess: account.team, secrets });
    $("loginForm").reset();
  } catch (error) {
    message.textContent = error instanceof ApiError && error.status === 401
      ? "Name or password is incorrect."
      : (error instanceof ApiError
        ? error.message
        : (credentialsAccepted
          ? "Your password was accepted, but this page was out of date. Refresh it and try again."
          : "The account could not be opened. Please try again."));
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
  else if (password.length < MIN_ACCOUNT_PASSWORD_LENGTH) message.textContent = `Choose a password with at least ${MIN_ACCOUNT_PASSWORD_LENGTH} characters.`;
  else if (password !== confirmation) message.textContent = "The two personal passwords do not match.";
  else if (teamPassword.length < MIN_TEAM_INVITE_PASSWORD_LENGTH) message.textContent = `Enter the ${MIN_TEAM_INVITE_PASSWORD_LENGTH}-character team invite password.`;
  if (message.textContent) return;
  if (!apiConfigured()) {
    message.textContent = "Account creation is not connected yet.";
    return;
  }
  state.busy = true;
  setButtonBusy(submit, true, "Creating account…", "Create account");
  try {
    const { kdf } = await api.bootstrapKdf();
    let teamSecrets;
    try {
      teamSecrets = await deriveSecrets(teamPassword, kdf);
      const configMeta = await loadBootstrapConfig(teamSecrets.authToken);
      await decryptJson(configMeta.document, teamSecrets);
    }
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

function clearAdminSession({ prompt = false } = {}) {
  if (state.adminExpiryTimer !== null) window.clearTimeout(state.adminExpiryTimer);
  state.adminToken = null;
  state.adminExpiresAt = 0;
  state.adminExpiryTimer = null;
  $("editHomeButton").hidden = true;
  $("adminButton").textContent = "Admin";
  $("adminButton").classList.remove("is-active");
  if ($("teamOfficeDaysDialog").open) closeDialog($("teamOfficeDaysDialog"));
  for (const id of ["shoutoutsDialog", "birthdaysDialog"]) if ($(id).open) closeDialog($(id));
  if ($("momDialog").open && !$("momQuickForm").hidden) showMomReader();
  if (state.unlocked && state.config) {
    renderTeamOfficeDays();
    renderSummaries();
    renderCalendar();
    renderWorkSchedule();
  }
  if (prompt && $("adminDialog").open) {
    $("adminPanel").hidden = true;
    $("adminLoginForm").hidden = false;
    $("adminLoginMessage").textContent = "The Admin session expired. Enter the password again.";
  }
}

function beginAdminSession(token, expiresIn) {
  clearAdminSession();
  const lifetimeMs = Math.max(1, Number(expiresIn) || 900) * 1000;
  state.adminToken = token;
  state.adminExpiresAt = Date.now() + lifetimeMs;
  $("editHomeButton").hidden = false;
  $("adminButton").textContent = "Admin on";
  $("adminButton").classList.add("is-active");
  if (state.unlocked && state.config) {
    renderTeamOfficeDays();
    renderSummaries();
    renderCalendar();
    renderWorkSchedule();
  }
  state.adminExpiryTimer = window.setTimeout(() => clearAdminSession({ prompt: true }), lifetimeMs);
}

function lockPlanner() {
  if (confirmResolver) confirmResolver(false);
  confirmResolver = null;
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  clearLegacyStoredSession();
  clearAccountSessionTimers();
  state.unlocked = false;
  state.account = null;
  state.sessionToken = null;
  state.sessionExpiresAt = 0;
  state.sessionLastActivityAt = 0;
  state.teamAccess = null;
  state.secrets = null;
  state.config = null;
  state.configMeta = null;
  state.people = [];
  state.personMeta = new Map();
  state.presence = { version: 1, members: [] };
  state.presenceMeta = null;
  state.currentView = "home";
  clearAdminSession();
  state.adminConfigBase = null;
  state.pendingAdminFeature = null;
  state.overlapConfirmation = null;
  state.datePickerTarget = null;
  state.officeDaysDraft = [];
  state.busy = false;
  for (const id of ["holidayForm", "momQuickForm", "shoutoutsForm", "birthdaysForm", "profileForm", "adminLoginForm", "configForm"]) $(id).reset();
  $("momValue").textContent = "";
  $("momDetail").textContent = "";
  $("momExpandedValue").textContent = "";
  $("momQuickInput").value = "";
  $("momQuickForm").hidden = true;
  $("momReadView").hidden = false;
  $("momReadActions").hidden = false;
  $("shoutoutPeriod").textContent = "";
  $("shoutoutPeople").replaceChildren();
  $("shoutoutDetail").textContent = "";
  $("directShoutoutPeople").replaceChildren();
  $("birthdayMonth").textContent = "";
  $("birthdayPeople").replaceChildren();
  $("birthdayDetail").textContent = "";
  $("directBirthdays").replaceChildren();
  $("homeGroupName").textContent = "Dream Team";
  $("headerGroupName").textContent = "Dream Team";
  $("quickLinks").replaceChildren();
  $("teamOfficeDaysSlots").replaceChildren();
  $("teamOfficeDaysMonth").textContent = "";
  $("teamOfficeDaysHint").textContent = "";
  $("workSchedule").replaceChildren();
  $("signedInName").textContent = "";
  for (const id of ["awayTodayList", "awayWeekList", "peopleList", "calendarGrid", "mobileAgenda", "adminPeopleList", "adminLinks", "datePickerGrid", "officeDaysGrid", "dayHolidaysList", "toastRegion"]) $(id).replaceChildren();
  for (const id of ["awayTodayCount", "awayWeekCount", "peopleCount", "monthTitle", "dayHolidaysTitle", "profileCurrentName", "datePickerTitle", "datePickerFieldLabel", "officeDaysMonthTitle", "officeDaysSelectionCount", "workMessage", "holidayFormMessage", "momQuickMessage", "shoutoutsFormMessage", "birthdaysFormMessage", "profileMessage", "officeDaysMessage", "adminLoginMessage", "configFormMessage", "confirmMessage"]) $(id).textContent = "";
  $("editPersonId").value = "";
  $("editHolidayId").value = "";
  setHolidayDate("holidayStart", "", false);
  setHolidayDate("holidayEnd", "", false);
  $("deleteHolidayButton").hidden = true;
  $("adminPanel").hidden = true;
  $("adminLoginForm").hidden = false;
  $("confirmTitle").textContent = "Are you sure?";
  $("confirmAccept").textContent = "Delete";
  $("loginForm").reset();
  $("createForm").reset();
  document.title = "Team Time Away";
  $("appView").hidden = true;
  $("unlockView").hidden = false;
  switchAuthView("login");
}

function setProtectedText(node, value, fallback) {
  node.textContent = value || fallback;
  node.classList.toggle("empty-copy", !value);
}

function setView(requestedView, { updateHash = true } = {}) {
  const view = ["home", "holidays", "work"].includes(requestedView) ? requestedView : "home";
  state.currentView = view;
  const activePage = view === "home" ? $("homePage") : view === "holidays" ? $("holidaysPage") : $("workPage");
  $("homePage").hidden = view !== "home";
  $("holidaysPage").hidden = view !== "holidays";
  $("workPage").hidden = view !== "work";
  activePage.classList.remove("is-entering");
  void activePage.offsetWidth;
  activePage.classList.add("is-entering");
  for (const [name, id] of [["home", "navHome"], ["holidays", "navHolidays"], ["work", "navWork"]]) {
    const button = $(id);
    const active = name === view;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  if (updateHash && location.hash !== `#${view}`) history.pushState(null, "", `#${view}`);
  if (state.unlocked) {
    if (view === "work") renderWorkSchedule();
    if (view === "holidays") renderCalendar();
    document.title = `${state.config?.groupName ?? "Dream Team"} · ${view === "home" ? "Home" : view === "work" ? "Work location" : "Holidays"}`;
  }
}

function renderHome() {
  const groupName = state.config.groupName;
  $("homeGroupName").textContent = groupName;
  $("headerGroupName").textContent = groupName;
  setProtectedText($("momValue"), state.config.mom, "—");
  setProtectedText($("momExpandedValue"), state.config.mom, "No meeting notes have been added yet. An Admin can add the full MOM from Edit homepage.");
  const momWordCount = state.config.mom ? state.config.mom.trim().split(/\s+/u).filter(Boolean).length : 0;
  $("momDetail").textContent = momWordCount ? `${momWordCount} ${momWordCount === 1 ? "word" : "words"}` : "No notes yet";

  const shoutouts = state.config.shoutouts;
  $("shoutoutPeriod").textContent = shoutouts.start && shoutouts.end
    ? `${friendlyDate(shoutouts.start)} – ${friendlyDate(shoutouts.end)}`
    : "";
  const shoutoutPeople = $("shoutoutPeople");
  shoutoutPeople.replaceChildren();
  if (shoutouts.people.length) {
    for (const name of shoutouts.people) shoutoutPeople.append(makeElement("span", "shoutout-person", name));
  } else shoutoutPeople.append(makeElement("span", "home-feature-empty", "—"));
  $("shoutoutDetail").textContent = `${shoutouts.people.length} ${shoutouts.people.length === 1 ? "person" : "people"}`;

  const currentMonth = String(new Date().getMonth() + 1).padStart(2, "0");
  $("birthdayMonth").textContent = new Intl.DateTimeFormat("en-GB", { month: "long" }).format(new Date());
  const birthdays = state.config.birthdays.filter((birthday) => birthday.date.slice(5, 7) === currentMonth);
  const birthdayPeople = $("birthdayPeople");
  birthdayPeople.replaceChildren();
  if (birthdays.length) {
    for (const birthday of birthdays) {
      const row = makeElement("span", "birthday-person");
      row.append(makeElement("strong", "", birthday.name), makeElement("span", "", friendlyDate(birthday.date)));
      birthdayPeople.append(row);
    }
  } else birthdayPeople.append(makeElement("span", "home-feature-empty", "—"));
  $("birthdayDetail").textContent = `${birthdays.length} ${birthdays.length === 1 ? "birthday" : "birthdays"} this month`;

  renderTeamOfficeDays();
  const links = $("quickLinks");
  links.replaceChildren();
  state.config.links.forEach((link, index) => {
    if (link.url) {
      const anchor = makeElement("a", "quick-link");
      anchor.href = link.url;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.append(makeElement("span", "quick-link-number", String(index + 1).padStart(2, "0")), makeElement("strong", "", link.label), makeElement("span", "quick-link-arrow", "↗"));
      links.append(anchor);
    } else {
      const button = makeElement("button", "quick-link is-empty");
      button.type = "button";
      button.append(makeElement("span", "quick-link-number", String(index + 1).padStart(2, "0")), makeElement("strong", "", `Link ${index + 1}`), makeElement("span", "quick-link-placeholder", "Not set"));
      button.addEventListener("click", () => openAdmin());
      links.append(button);
    }
  });
}

async function verifiedPresence(file) {
  if (!file?.document || typeof file.digest !== "string") throw new Error("The repository did not confirm the work schedule.");
  const presence = assertPresenceRecord(await decryptJson(file.document, state.secrets));
  if (await digestDocument(file.document) !== file.digest) throw new Error("The work schedule confirmation did not match.");
  return { presence, meta: { document: file.document, digest: file.digest, sha: file.sha ?? null } };
}

async function commitPresenceMutation(mutate, { admin = false } = {}) {
  let base = structuredClone(state.presence);
  let meta = state.presenceMeta;
  if (!meta) throw new UserMessageError("The work-location schedule is not ready yet.");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = assertPresenceRecord(mutate(structuredClone(base)));
    const document = await encryptJson(next, state.secrets);
    try {
      const response = admin
        ? await api.adminUpdatePresence({ document, expectedDigest: meta.digest }, state.adminToken)
        : await api.updatePresence({ document, expectedDigest: meta.digest }, state.sessionToken);
      const verified = await verifiedPresence(response.file);
      state.presence = verified.presence;
      state.presenceMeta = verified.meta;
      renderWorkSchedule();
      return verified.presence;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.details?.latest?.document) {
        base = assertPresenceRecord(await decryptJson(error.details.latest.document, state.secrets));
        meta = error.details.latest;
        continue;
      }
      throw error;
    }
  }
  throw new UserMessageError("The work schedule changed at the same time. Please try once more.");
}

async function ensureCurrentAccountInPresence() {
  if (!state.unlocked || !state.account || !apiConfigured()) return;
  const reconciled = reconcileCurrentPresenceMember(state.presence, state.account);
  if (!reconciled.changed) return;
  try {
    await commitPresenceMutation((latest) => {
      return reconcileCurrentPresenceMember(latest, state.account).presence;
    });
  } catch (error) {
    showToast(error.message || "Your work-location row could not be synced yet.", "error");
  }
}

function workStatusNode(member, iso) {
  const holiday = holidayForAccountDay(state.people, member.displayName, iso);
  if (holiday) {
    const status = makeElement("span", "work-status is-holiday", "Holiday");
    status.title = holidayLabel(holiday);
    return status;
  }
  const office = isOfficeDay(member, state.config.officeDays, iso);
  const teamDefault = state.config.officeDays.includes(iso);
  const ownRow = member.accountId === state.account?.id;
  const editable = ownRow || Boolean(state.adminToken);
  const status = makeElement(editable ? "button" : "span", `work-status ${office ? "is-office" : "is-home"}`, office ? "Office" : "Home");
  if (editable) {
    status.type = "button";
    status.setAttribute("aria-pressed", String(office));
    status.setAttribute("aria-label", `${member.displayName}, ${friendlyDate(iso, { weekday: "long", day: "numeric", month: "long" })}: ${office ? "work at office" : "work from home"}. Select to change.`);
    status.addEventListener("click", () => toggleOfficeDay(member.accountId, member.displayName, iso));
  }
  if (teamDefault && !member.homeDays.includes(iso) && !member.officeDays.includes(iso)) status.title = "Team office day";
  return status;
}

function workMemberRow(member, week, holidayRecordIds) {
  const row = makeElement("div", "work-row");
  if (member.accountId === state.account?.id) row.classList.add("is-current-user");
  const name = makeElement("div", "work-person-cell");
  name.style.setProperty("--person-hue", personHue(member.accountId));
  name.dataset.fullName = member.displayName;
  const nameLabel = makeElement("strong", "", member.displayName);
  nameLabel.title = member.displayName;
  name.append(makeElement("span", "person-dot"), nameLabel);
  if (member.accountId === state.account?.id) name.append(makeElement("small", "", "You"));
  else if (holidayRecordIds.has(member.accountId)) name.append(makeElement("small", "", "Demo"));
  row.append(name);
  for (const iso of week.days) {
    const cell = makeElement("div", "work-day-cell");
    if (iso === todayIso()) cell.classList.add("is-today");
    cell.append(workStatusNode(member, iso));
    row.append(cell);
  }
  return row;
}

function renderWorkSchedule() {
  const schedule = $("workSchedule");
  schedule.replaceChildren();
  if (!state.presence.members.length) {
    const empty = makeElement("section", "work-empty");
    empty.append(makeElement("h2", "", "No team accounts yet"), makeElement("p", "", "Each person appears here automatically after creating an account and logging in."));
    schedule.append(empty);
    return;
  }
  const dayFormatter = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const members = Object.freeze(
    [...state.presence.members]
      .sort((first, second) => {
        const firstIsCurrent = first.accountId === state.account?.id;
        const secondIsCurrent = second.accountId === state.account?.id;
        return firstIsCurrent === secondIsCurrent ? first.displayName.localeCompare(second.displayName) : firstIsCurrent ? -1 : 1;
      })
      .map((member) => Object.freeze({ ...member, officeDays: Object.freeze([...(member.officeDays || [])]), homeDays: Object.freeze([...(member.homeDays || [])]) })),
  );
  const holidayRecordIds = new Set(state.people.map((person) => person.id));
  twoWorkWeeks().forEach((week, weekIndex) => {
    const card = makeElement("section", "work-week-card");
    const heading = makeElement("div", "work-week-heading");
    const copy = makeElement("div");
    copy.append(makeElement("p", "eyebrow", weekIndex === 0 ? "In progress" : "Coming next"), makeElement("h2", "", weekIndex === 0 ? "This week" : "Next week"), makeElement("span", "", `${friendlyDate(week.start)} – ${fullFriendlyDate(week.end)}`));
    const memberCount = makeElement("span", "work-member-count");
    memberCount.append(makeElement("strong", "", String(members.length)), makeElement("small", "", members.length === 1 ? "person" : "people"));
    heading.append(copy, memberCount);
    card.append(heading);
    const scroller = makeElement("div", "work-table-scroll");
    const table = makeElement("div", "work-table");
    table.dataset.memberCount = String(members.length);
    table.setAttribute("aria-label", `${weekIndex === 0 ? "This week" : "Next week"}: ${members.length} team members`);
    const header = makeElement("div", "work-row work-table-header");
    header.append(makeElement("div", "work-person-cell", "Team member"));
    for (const iso of week.days) {
      const cell = makeElement("div", "work-day-heading", dayFormatter.format(new Date(`${iso}T12:00:00`)));
      if (iso === todayIso()) cell.classList.add("is-today");
      header.append(cell);
    }
    table.append(header, ...members.map((member) => workMemberRow(member, week, holidayRecordIds)));
    scroller.append(table);
    card.append(scroller);
    schedule.append(card);
  });
}

async function toggleOfficeDay(accountId, displayName, iso) {
  const admin = Boolean(state.adminToken);
  const ownRow = accountId === state.account?.id;
  if (state.busy || !state.account || (!ownRow && !admin) || isWeekendIso(iso)) return;
  if (holidayForAccountDay(state.people, displayName, iso)) return;
  state.busy = true;
  $("workMessage").textContent = "Saving your choice…";
  try {
    await commitPresenceMutation((latest) => {
      const member = latest.members.find((candidate) => candidate.accountId === accountId);
      if (!member) throw new UserMessageError("That team member's row is no longer available. Refresh and try again.");
      const currentlyOffice = isOfficeDay(member, state.config.officeDays, iso);
      if (currentlyOffice) {
        member.officeDays = member.officeDays.filter((day) => day !== iso);
        member.homeDays = [...member.homeDays.filter((day) => day !== iso), iso];
      } else {
        member.homeDays = member.homeDays.filter((day) => day !== iso);
        member.officeDays = state.config.officeDays.includes(iso)
          ? member.officeDays.filter((day) => day !== iso)
          : [...member.officeDays.filter((day) => day !== iso), iso];
      }
      return latest;
    }, { admin });
    $("workMessage").textContent = "Saved.";
    window.setTimeout(() => { if ($("workMessage").textContent === "Saved.") $("workMessage").textContent = ""; }, 1800);
  } catch (error) {
    $("workMessage").textContent = error instanceof UserMessageError || error instanceof ApiError ? error.message : "Your work location could not be saved.";
  } finally {
    state.busy = false;
  }
}

function activeHoliday(person, start, end = start) {
  return person.holidays.find((holiday) => rangesOverlapOnWorkingDay(start, end, holiday.start, holiday.end)) ?? null;
}

function renderPersonSummary(list, people, emptyMessage, { todayOnly = false, rangeStart = null, rangeEnd = null } = {}) {
  list.replaceChildren();
  if (!people.length) {
    list.append(makeElement("p", "list-empty", emptyMessage));
    return;
  }
  const weekStart = toIsoDate(startOfWeek());
  const weekEnd = toIsoDate(endOfWeek());
  for (const person of sortPeopleForCurrent(people)) {
    const row = makeElement("div", "person-row");
    if (isCurrentAccountPerson(person)) row.classList.add("is-current-user");
    row.style.setProperty("--person-hue", personHue(person.id));
    row.append(makeElement("span", "person-dot"));
    const copy = makeElement("div", "person-copy");
    copy.append(makeElement("p", "person-name", person.name));
    const holiday = rangeStart
      ? activeHoliday(person, rangeStart, rangeEnd ?? rangeStart)
      : activeHoliday(person, todayIso()) ?? activeHoliday(person, weekStart, weekEnd);
    if (holiday) copy.append(makeElement("p", "person-dates", todayOnly ? `Away today \u00b7 ${holidayLabel(holiday)}` : holidayLabel(holiday)));
    row.append(copy);
    if (isCurrentAccountPerson(person)) row.append(makeElement("span", "you-badge", "You"));
    list.append(row);
  }
}

function renderSummaries() {
  const today = todayIso();
  const weekEnd = toIsoDate(endOfWeek());
  const awayToday = peopleAwayOn(state.people, today);
  const awayWeek = peopleAwayBetween(state.people, today, weekEnd);
  $("awayTodayCount").textContent = String(awayToday.length);
  $("awayWeekCount").textContent = String(awayWeek.length);
  $("peopleCount").textContent = String(state.people.length);
  renderPersonSummary($("awayTodayList"), awayToday, "No one is away today.", { todayOnly: true, rangeStart: today, rangeEnd: today });
  renderPersonSummary($("awayWeekList"), awayWeek, "No one is away for the rest of this week.", { rangeStart: today, rangeEnd: weekEnd });

  const displayedYear = state.month.getFullYear();
  const displayedMonth = state.month.getMonth();
  const monthName = new Intl.DateTimeFormat("en-GB", { month: "long" }).format(state.month);
  const monthStart = toIsoDate(new Date(displayedYear, displayedMonth, 1));
  const monthEnd = toIsoDate(new Date(displayedYear, displayedMonth + 1, 0));
  const visibleStart = monthStart > today ? monthStart : today;
  const monthEntries = monthEnd < today
    ? []
    : state.people.map((person) => ({
      person,
      holidays: person.holidays.filter((holiday) => rangesOverlapOnWorkingDay(visibleStart, monthEnd, holiday.start, holiday.end)),
    })).filter((entry) => entry.holidays.length > 0);

  $("peopleCardTitle").textContent = `${monthName} holidays`;
  $("peopleCount").textContent = String(monthEntries.length);
  const teamList = $("peopleList");
  teamList.replaceChildren();
  if (!monthEntries.length) {
    teamList.append(makeElement("p", "list-empty", monthEnd < today ? `No upcoming holidays remain in ${monthName}.` : `No current or upcoming holidays in ${monthName}.`));
  } else {
    for (const person of sortPeopleForCurrent(monthEntries.map((entry) => entry.person))) {
      const holidayDays = countHolidayWeekdays(person.holidays, monthStart, monthEnd);
      const row = makeElement("div", "team-row");
      if (isCurrentAccountPerson(person)) row.classList.add("is-current-user");
      row.style.setProperty("--person-hue", personHue(person.id));
      row.append(makeElement("span", "person-dot"), makeElement("span", "person-name", person.name));
      if (isCurrentAccountPerson(person)) row.append(makeElement("span", "you-badge", "You"));
      row.append(makeElement("span", "holiday-total", `${holidayDays} ${holidayDays === 1 ? "day" : "days"}`));
      teamList.append(row);
    }
  }
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function officeDaysForMonth(date, source = state.config?.officeDays ?? []) {
  const prefix = `${monthKey(date)}-`;
  return source.filter((iso) => iso.startsWith(prefix)).sort();
}

function renderTeamOfficeDays() {
  const currentMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const officeDays = officeDaysForMonth(currentMonth);
  $("teamOfficeDaysMonth").textContent = new Intl.DateTimeFormat("en-GB", { month: "long" }).format(currentMonth);
  const slots = $("teamOfficeDaysSlots");
  slots.replaceChildren();
  for (let index = 0; index < 4; index += 1) {
    const iso = officeDays[index];
    const slot = makeElement("span", `team-office-day-slot${iso ? " is-set" : ""}`);
    if (iso) {
      slot.append(makeElement("small", "", friendlyDate(iso, { weekday: "short" })), makeElement("strong", "", friendlyDate(iso, { day: "numeric" })));
    } else {
      slot.append(makeElement("small", "", "Open"), makeElement("strong", "", "—"));
    }
    slots.append(slot);
  }
  const editable = Boolean(state.adminToken);
  $("teamOfficeDaysButton").classList.toggle("is-editable", editable);
  $("teamOfficeDaysButton").setAttribute("aria-controls", editable ? "teamOfficeDaysDialog" : "adminDialog");
  $("teamOfficeDaysButton").setAttribute("aria-label", editable ? "Edit this month's team office days" : "View this month's team office days. Admin can edit them.");
  $("teamOfficeDaysHint").textContent = editable ? "Select to edit" : officeDays.length ? "Set by Admin" : "No dates set yet";
}

function openTeamOfficeDays() {
  if (!state.adminToken) {
    openAdmin();
    return;
  }
  state.officeDaysMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  state.officeDaysDraft = [...(state.config.officeDays ?? [])];
  $("officeDaysMessage").textContent = "";
  renderOfficeDaysPicker();
  showDialog($("teamOfficeDaysDialog"));
}

function renderOfficeDaysPicker() {
  const year = state.officeDaysMonth.getFullYear();
  const month = state.officeDaysMonth.getMonth();
  const selected = new Set(officeDaysForMonth(state.officeDaysMonth, state.officeDaysDraft));
  $("officeDaysMonthTitle").textContent = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(state.officeDaysMonth);
  $("officeDaysSelectionCount").textContent = `${selected.size} of 4 selected`;
  const grid = $("officeDaysGrid");
  grid.replaceChildren();
  for (const cell of monthCells(year, month)) {
    const weekend = isWeekendIso(cell.iso);
    const day = makeElement("button", "date-picker-day office-days-day", String(cell.date.getDate()));
    day.type = "button";
    day.disabled = weekend || !cell.currentMonth;
    day.dataset.iso = cell.iso;
    day.setAttribute("aria-label", `${friendlyDate(cell.iso, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}${weekend ? ", weekend unavailable" : ""}`);
    if (!cell.currentMonth) day.classList.add("outside-month");
    if (selected.has(cell.iso)) {
      day.classList.add("is-selected");
      day.setAttribute("aria-pressed", "true");
    }
    if (cell.iso === todayIso()) day.classList.add("is-today");
    if (!day.disabled) day.addEventListener("click", () => toggleTeamOfficeDay(cell.iso));
    grid.append(day);
  }
}

function toggleTeamOfficeDay(iso) {
  const selected = officeDaysForMonth(state.officeDaysMonth, state.officeDaysDraft);
  if (selected.includes(iso)) state.officeDaysDraft = state.officeDaysDraft.filter((day) => day !== iso);
  else if (selected.length < 4) state.officeDaysDraft.push(iso);
  else {
    $("officeDaysMessage").textContent = "Choose no more than four office days for this month.";
    return;
  }
  $("officeDaysMessage").textContent = "";
  renderOfficeDaysPicker();
}

function changeOfficeDaysMonth(offset) {
  state.officeDaysMonth = new Date(state.officeDaysMonth.getFullYear(), state.officeDaysMonth.getMonth() + offset, 1);
  $("officeDaysMessage").textContent = "";
  renderOfficeDaysPicker();
}

function clearOfficeDaysMonth() {
  const prefix = `${monthKey(state.officeDaysMonth)}-`;
  state.officeDaysDraft = state.officeDaysDraft.filter((iso) => !iso.startsWith(prefix));
  $("officeDaysMessage").textContent = "";
  renderOfficeDaysPicker();
}

async function saveTeamOfficeDays() {
  if (state.busy || !state.adminToken) return;
  const button = $("saveOfficeDays");
  const desiredOfficeDays = [...state.officeDaysDraft].sort();
  const original = structuredClone(state.config);
  if (JSON.stringify(desiredOfficeDays) === JSON.stringify(original.officeDays ?? [])) {
    closeDialog($("teamOfficeDaysDialog"));
    return;
  }
  state.busy = true;
  setButtonBusy(button, true, "Saving…", "Save office days");
  let base = structuredClone(state.config);
  let meta = state.configMeta;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const desired = { ...original, officeDays: desiredOfficeDays };
      let next;
      try { next = mergeConfigChanges(original, base, desired); }
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
        closeDialog($("teamOfficeDaysDialog"));
        showToast("Team office days updated.");
        return;
      } catch (error) {
        if (error instanceof ApiError && error.status === 409 && error.details?.latest?.document) {
          base = assertConfigRecord(await decryptJson(error.details.latest.document, state.secrets));
          meta = error.details.latest;
          continue;
        }
        if (error instanceof ApiError && error.status === 401) clearAdminSession({ prompt: true });
        throw error;
      }
    }
    throw new UserMessageError("Team settings changed elsewhere. Reopen the office days and try again.");
  } catch (error) {
    $("officeDaysMessage").textContent = error.message || "The office days could not be saved.";
  } finally {
    state.busy = false;
    setButtonBusy(button, false, "Saving…", "Save office days");
  }
}

function isCurrentAccountPerson(person) {
  return Boolean(person && state.account?.displayName && canonicalName(person.name) === canonicalName(state.account.displayName));
}

function sortPeopleForCurrent(people) {
  return [...people].sort((first, second) => {
    const firstIsCurrent = isCurrentAccountPerson(first);
    const secondIsCurrent = isCurrentAccountPerson(second);
    return firstIsCurrent === secondIsCurrent ? first.name.localeCompare(second.name) : firstIsCurrent ? -1 : 1;
  });
}

function availableAccountNames() {
  const names = new Map();
  for (const member of state.presence.members) names.set(canonicalName(member.displayName), member.displayName);
  if (state.account?.displayName) names.set(canonicalName(state.account.displayName), state.account.displayName);
  return [...names.values()].sort((first, second) => first.localeCompare(second));
}

function makeAccountSelect(value = "", label = "Person") {
  const select = document.createElement("select");
  select.className = "feature-person-select";
  select.setAttribute("aria-label", label);
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select person";
  select.append(placeholder);
  const names = availableAccountNames();
  if (value && !names.some((name) => canonicalName(name) === canonicalName(value))) {
    const legacy = document.createElement("option");
    legacy.value = value;
    legacy.textContent = `${value} · unavailable`;
    select.append(legacy);
  }
  for (const name of names) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    select.append(option);
  }
  select.value = value;
  return select;
}

function syncAccountSelects(container) {
  const selects = [...container.querySelectorAll(".feature-person-select")];
  for (const select of selects) {
    const usedElsewhere = new Set(selects.filter((other) => other !== select).map((other) => canonicalName(other.value)).filter(Boolean));
    for (const option of select.options) option.disabled = Boolean(option.value && usedElsewhere.has(canonicalName(option.value)));
  }
}

function appendDirectShoutoutRow(value = "") {
  const container = $("directShoutoutPeople");
  const row = makeElement("div", "admin-feature-row feature-account-row");
  const select = makeAccountSelect(value, "Shoutout person");
  const remove = makeElement("button", "button button-secondary button-small admin-remove-row", "Remove");
  remove.type = "button";
  remove.addEventListener("click", () => { row.remove(); syncAccountSelects(container); });
  select.addEventListener("change", () => syncAccountSelects(container));
  row.append(select, remove);
  container.append(row);
  syncAccountSelects(container);
}

function appendDirectBirthdayRow(birthday = { name: "", date: "" }) {
  const container = $("directBirthdays");
  const row = makeElement("div", "admin-feature-row admin-birthday-row feature-account-row");
  const select = makeAccountSelect(birthday.name, "Birthday person");
  const date = document.createElement("input");
  date.className = "birthday-date";
  date.type = "date";
  date.value = birthday.date;
  date.setAttribute("aria-label", `Birthday date for ${birthday.name || "person"}`);
  const remove = makeElement("button", "button button-secondary button-small admin-remove-row", "Remove");
  remove.type = "button";
  remove.addEventListener("click", () => { row.remove(); syncAccountSelects(container); });
  select.addEventListener("change", () => syncAccountSelects(container));
  row.append(select, date, remove);
  container.append(row);
  syncAccountSelects(container);
}

function showMomReader() {
  renderHome();
  $("momReadView").hidden = false;
  $("momReadView").scrollTop = 0;
  $("momReadActions").hidden = false;
  $("momQuickForm").hidden = true;
  $("momQuickMessage").textContent = "";
}

function showMomEditor() {
  $("momReadView").hidden = true;
  $("momReadActions").hidden = true;
  $("momQuickForm").hidden = false;
  $("momQuickInput").value = state.config.mom;
  $("momQuickMessage").textContent = "";
  window.requestAnimationFrame(() => $("momQuickInput").focus());
}

function openMom() {
  if (state.adminToken && state.adminExpiresAt <= Date.now()) clearAdminSession();
  if (state.adminToken) showMomEditor();
  else showMomReader();
  showDialog($("momDialog"));
}

function openDirectShoutouts() {
  $("directShoutoutStart").value = state.config.shoutouts.start;
  $("directShoutoutEnd").value = state.config.shoutouts.end;
  $("shoutoutsFormMessage").textContent = "";
  $("directShoutoutPeople").replaceChildren();
  for (const name of state.config.shoutouts.people) appendDirectShoutoutRow(name);
  if (!state.config.shoutouts.people.length) appendDirectShoutoutRow();
  showDialog($("shoutoutsDialog"));
  window.requestAnimationFrame(() => $("directShoutoutStart").focus());
}

function openDirectBirthdays() {
  $("birthdaysFormMessage").textContent = "";
  $("directBirthdays").replaceChildren();
  for (const birthday of state.config.birthdays) appendDirectBirthdayRow(birthday);
  if (!state.config.birthdays.length) appendDirectBirthdayRow();
  showDialog($("birthdaysDialog"));
  window.requestAnimationFrame(() => $("directBirthdays").querySelector(".feature-person-select")?.focus());
}

function openDirectFeature(feature) {
  if (feature === "mom") {
    showMomEditor();
    showDialog($("momDialog"));
  } else if (feature === "shoutouts") openDirectShoutouts();
  else if (feature === "birthdays") openDirectBirthdays();
}

async function saveConfigFeature(field, value, { button, message, dialog, idleText, successText }) {
  let normalized;
  try { normalized = assertConfigRecord({ ...state.config, [field]: value })[field]; }
  catch (error) {
    message.textContent = error.message;
    return false;
  }
  const original = structuredClone(state.config);
  if (JSON.stringify(original[field]) === JSON.stringify(normalized)) {
    closeDialog(dialog);
    return true;
  }
  state.busy = true;
  setButtonBusy(button, true, "Saving…", idleText);
  let base = structuredClone(state.config);
  let meta = state.configMeta;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const desired = { ...original, [field]: normalized };
      let next;
      try { next = mergeConfigChanges(original, base, desired); }
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
        closeDialog(dialog);
        showToast(successText);
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.status === 409 && error.details?.latest?.document) {
          base = assertConfigRecord(await decryptJson(error.details.latest.document, state.secrets));
          meta = error.details.latest;
          continue;
        }
        if (error instanceof ApiError && error.status === 401) clearAdminSession({ prompt: true });
        throw error;
      }
    }
    throw new UserMessageError("This section changed elsewhere. Reopen it and try again.");
  } catch (error) {
    message.textContent = error.message || "The change could not be saved.";
    return false;
  } finally {
    state.busy = false;
    setButtonBusy(button, false, "Saving…", idleText);
  }
}

async function saveMomQuick(event) {
  event.preventDefault();
  if (state.busy || !state.adminToken) return;
  await saveConfigFeature("mom", $("momQuickInput").value.trim(), {
    button: $("saveMomQuick"), message: $("momQuickMessage"), dialog: $("momDialog"), idleText: "Save MOM", successText: "MOM updated.",
  });
}

async function saveDirectShoutouts(event) {
  event.preventDefault();
  if (state.busy || !state.adminToken) return;
  const value = {
    start: $("directShoutoutStart").value,
    end: $("directShoutoutEnd").value,
    people: [...$("directShoutoutPeople").querySelectorAll(".feature-person-select")].map((select) => normalizeName(select.value)).filter(Boolean),
  };
  await saveConfigFeature("shoutouts", value, {
    button: $("saveShoutouts"), message: $("shoutoutsFormMessage"), dialog: $("shoutoutsDialog"), idleText: "Save shoutouts", successText: "Shoutouts updated.",
  });
}

async function saveDirectBirthdays(event) {
  event.preventDefault();
  if (state.busy || !state.adminToken) return;
  const value = [...$("directBirthdays").querySelectorAll(".admin-birthday-row")].map((row) => ({
    name: normalizeName(row.querySelector(".feature-person-select").value),
    date: row.querySelector(".birthday-date").value,
  })).filter((birthday) => birthday.name || birthday.date);
  await saveConfigFeature("birthdays", value, {
    button: $("saveBirthdays"), message: $("birthdaysFormMessage"), dialog: $("birthdaysDialog"), idleText: "Save birthdays", successText: "Birthdays updated.",
  });
}

function openProfile() {
  if (!state.account) return;
  $("profileCurrentName").textContent = state.account.displayName;
  $("profileName").value = state.account.displayName;
  $("profilePassword").value = "";
  $("profileMessage").textContent = "";
  $("profileMessage").classList.remove("success");
  showDialog($("profileDialog"));
  window.requestAnimationFrame(() => $("profileName").focus());
}

async function saveProfile(event) {
  event.preventDefault();
  if (state.busy || !state.account) return;
  const currentName = state.account.displayName;
  const newName = normalizeName($("profileName").value);
  const password = $("profilePassword").value;
  const message = $("profileMessage");
  const button = $("saveProfileButton");
  message.classList.remove("success");
  message.textContent = "";
  if (!newName) message.textContent = "Enter a valid name.";
  else if (password.length < MIN_ACCOUNT_PASSWORD_LENGTH) message.textContent = `Enter your current password of at least ${MIN_ACCOUNT_PASSWORD_LENGTH} characters.`;
  const currentPerson = state.people.find(isCurrentAccountPerson) ?? null;
  const duplicate = state.people.find((person) => person.id !== currentPerson?.id && canonicalName(person.name) === canonicalName(newName));
  if (!message.textContent && duplicate) message.textContent = "That name already belongs to someone on the team.";
  if (message.textContent) return;

  state.busy = true;
  setButtonBusy(button, true, "Saving profile…", "Save profile");
  let accountRenamed = false;
  const syncWarnings = [];
  try {
    const lookup = await api.accountLookup(currentName);
    const accountSecrets = await deriveSecrets(password, lookup.kdf);
    const envelope = await encryptJson({ version: 1, accountId: state.account.id, displayName: newName, team: state.teamAccess }, accountSecrets);
    const response = await api.accountRename({ currentName, newName, verifier: accountSecrets.authToken, envelope }, state.sessionToken);
    accountRenamed = true;
    state.account.displayName = response.displayName;
    state.sessionToken = response.token;
    state.sessionExpiresAt = Date.now() + Number(response.expiresIn) * 1000;
    $("signedInName").textContent = response.displayName;
    $("profileCurrentName").textContent = response.displayName;
    $("profileName").value = response.displayName;
    scheduleAccountSessionTimers({ resetActivity: false });

    if (currentPerson && currentPerson.name !== response.displayName) {
      try {
        await commitPersonMutation(currentPerson.id, (latest) => ({ ...latest, name: response.displayName }));
      } catch { syncWarnings.push("holiday name"); }
    }
    try {
      await commitPresenceMutation((latest) => {
        const member = latest.members.find((candidate) => candidate.accountId === state.account.id);
        if (member) member.displayName = response.displayName;
        else latest.members.push({ accountId: state.account.id, displayName: response.displayName, officeDays: [], homeDays: [] });
        return latest;
      });
    } catch { syncWarnings.push("work-location name"); }

    renderAll();
    $("profilePassword").value = "";
    message.classList.add("success");
    message.textContent = syncWarnings.length ? `Profile saved. The ${syncWarnings.join(" and ")} will retry when you log in again.` : "Profile saved everywhere.";
    showToast(syncWarnings.length ? "Profile saved; one team view will resync shortly." : "Your profile has been updated.");
    window.setTimeout(() => closeDialog($("profileDialog")), syncWarnings.length ? 2600 : 1100);
  } catch (error) {
    message.textContent = accountRenamed
      ? "Your account name was saved, but one team view could not be updated yet. Log in with the new name."
      : (error instanceof ApiError && error.status === 401
        ? "Your current password is incorrect."
        : (error instanceof ApiError ? error.message : "Your profile could not be saved. Please try again."));
    $("profilePassword").select();
  } finally {
    state.busy = false;
    setButtonBusy(button, false, "Saving profile…", "Save profile");
  }
}

function canManageHoliday(person) {
  return Boolean(state.adminToken) || isCurrentAccountPerson(person);
}

function holidaysForDate(iso) {
  if (isWeekendIso(iso)) return [];
  const entries = [];
  for (const person of state.people) {
    for (const holiday of person.holidays) {
      if (holiday.start <= iso && holiday.end >= iso) entries.push({ person, holiday });
    }
  }
  return entries.sort((a, b) => {
    const aIsCurrent = isCurrentAccountPerson(a.person);
    const bIsCurrent = isCurrentAccountPerson(b.person);
    return aIsCurrent === bIsCurrent ? a.person.name.localeCompare(b.person.name) : aIsCurrent ? -1 : 1;
  });
}

function makeHolidayButton(person, holiday, className = "holiday-chip") {
  const editable = canManageHoliday(person);
  const button = makeElement(editable ? "button" : "div", `${className}${editable ? "" : " is-readonly"}`);
  if (editable) button.type = "button";
  if (isCurrentAccountPerson(person)) button.classList.add("is-current-user");
  button.style.setProperty("--person-hue", personHue(person.id));
  if (className === "holiday-chip") {
    button.append(makeElement("span", "holiday-chip-name", person.name));
    if (isCurrentAccountPerson(person)) button.append(makeElement("span", "you-badge", "You"));
    button.title = `${person.name}: ${holidayLabel(holiday)}`;
  } else {
    button.append(makeElement("strong", "", person.name), makeElement("span", "", holidayLabel(holiday)));
  }
  if (editable) button.addEventListener("click", (event) => {
    event.stopPropagation();
    openHolidayEditor(person.id, holiday.id);
  });
  return button;
}

function openDayHolidays(iso) {
  const entries = holidaysForDate(iso);
  $("dayHolidaysTitle").textContent = friendlyDate(iso, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const list = $("dayHolidaysList");
  list.replaceChildren();
  for (const { person, holiday } of entries) {
    const row = makeElement("article", "day-holiday-entry");
    if (isCurrentAccountPerson(person)) row.classList.add("is-current-user");
    row.style.setProperty("--person-hue", personHue(person.id));
    const identity = makeElement("div", "day-holiday-identity");
    identity.append(makeElement("span", "person-dot"));
    const copy = makeElement("div", "person-copy");
    copy.append(makeElement("strong", "person-name", person.name), makeElement("span", "person-dates", holidayLabel(holiday)));
    identity.append(copy);
    if (isCurrentAccountPerson(person)) identity.append(makeElement("span", "you-badge", "You"));
    row.append(identity);
    if (canManageHoliday(person)) {
      const edit = makeElement("button", "button button-secondary day-holiday-edit", "Edit");
      edit.type = "button";
      edit.addEventListener("click", () => {
        closeDialog($("dayHolidaysDialog"));
        openHolidayEditor(person.id, holiday.id);
      });
      row.append(edit);
    }
    list.append(row);
  }
  showDialog($("dayHolidaysDialog"));
}

function renderCalendar() {
  const year = state.month.getFullYear();
  const month = state.month.getMonth();
  $("monthTitle").textContent = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(state.month);
  $("calendarLoading").hidden = true;
  const hasHolidays = state.people.some((person) => person.holidays.some((holiday) => rangesOverlapOnWorkingDay(holiday.start, holiday.end, holiday.start, holiday.end)));
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
    const dayLabel = friendlyDate(cell.iso, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    day.setAttribute("aria-label", dayLabel);
    if (!cell.currentMonth) day.classList.add("outside-month");
    if (isWeekendIso(cell.iso)) {
      day.classList.add("is-weekend");
      day.setAttribute("aria-disabled", "true");
    }
    if (cell.iso === today) day.classList.add("is-today");
    const entries = holidaysForDate(cell.iso);
    const dayHeading = makeElement("div", "calendar-day-heading");
    dayHeading.append(makeElement("span", "day-number", String(cell.date.getDate())));
    if (entries.length > 2) {
      const compactMore = makeElement("span", "day-more-label is-compact", `+${entries.length - 2} more`);
      compactMore.setAttribute("aria-hidden", "true");
      dayHeading.append(compactMore);
    }
    if (entries.length > 3) {
      const wideMore = makeElement("span", "day-more-label is-wide", `+${entries.length - 3} more`);
      wideMore.setAttribute("aria-hidden", "true");
      dayHeading.append(wideMore);
    }
    day.append(dayHeading);
    const events = makeElement("div", "day-holidays");
    for (const { person, holiday } of entries.slice(0, 3)) events.append(makeHolidayButton(person, holiday));
    if (entries.length) {
      const peopleLabel = `${entries.length} ${entries.length === 1 ? "person" : "people"} away`;
      day.classList.add("has-holidays");
      day.tabIndex = 0;
      day.dataset.awayCount = String(entries.length);
      day.title = `View all ${peopleLabel.toLowerCase()}`;
      day.setAttribute("aria-label", `${dayLabel}: ${peopleLabel}. Open the complete list.`);
      day.setAttribute("aria-haspopup", "dialog");
      day.addEventListener("click", () => openDayHolidays(cell.iso));
      day.addEventListener("keydown", (event) => {
        if (event.target !== day || !["Enter", " "].includes(event.key)) return;
        event.preventDefault();
        openDayHolidays(cell.iso);
      });
    }
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
  renderHome();
  renderSummaries();
  renderCalendar();
  renderWorkSchedule();
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
  $("employeeName").readOnly = !state.adminToken;
  $("employeeName").value = state.account?.displayName ?? "";
  $("employeeNameHint").textContent = state.adminToken ? "Admin mode can add holidays for any team member." : "Your own account is selected automatically. Admin mode is required to add holidays for someone else.";
  const initialDate = nextWorkingDayIso(todayIso()) ?? todayIso();
  setHolidayDate("holidayStart", initialDate, false);
  setHolidayDate("holidayEnd", initialDate, false);
  $("holidayModalEyebrow").textContent = "New time away";
  $("holidayModalTitle").textContent = "Add holiday";
  $("deleteHolidayButton").hidden = true;
  $("saveHolidayButton").textContent = "Save holiday";
  $("holidayFormMessage").textContent = "";
  state.overlapConfirmation = null;
  showDialog($("holidayDialog"));
  (state.adminToken ? $("employeeName") : $("holidayStartButton")).focus();
}

function openHolidayEditor(personId, holidayId) {
  const person = state.people.find((candidate) => candidate.id === personId);
  const holiday = person?.holidays.find((candidate) => candidate.id === holidayId);
  if (!person || !holiday) return;
  if (!canManageHoliday(person)) {
    showToast("You can only change your own holidays. Use Admin mode to manage someone else.", "error");
    return;
  }
  $("editPersonId").value = personId;
  $("editHolidayId").value = holidayId;
  $("employeeName").value = person.name;
  $("employeeName").readOnly = true;
  setHolidayDate("holidayStart", holiday.start, false);
  setHolidayDate("holidayEnd", holiday.end, false);
  $("holidayModalEyebrow").textContent = "Adjust time away";
  $("holidayModalTitle").textContent = "Edit holiday";
  $("deleteHolidayButton").hidden = false;
  $("saveHolidayButton").textContent = "Save changes";
  state.overlapConfirmation = null;
  resetOverlapConfirmation();
  showDialog($("holidayDialog"));
  $("holidayStart").focus();
}

async function reloadPeople() {
  const repositoryState = await loadRepositoryState(state.secrets, state.sessionToken);
  state.people = repositoryState.people;
  state.personMeta = repositoryState.personMeta;
  state.config = repositoryState.config;
  state.configMeta = repositoryState.configMeta;
  state.presence = repositoryState.presence;
  state.presenceMeta = repositoryState.presenceMeta;
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
      if (error instanceof ApiError && error.status === 401 && admin) clearAdminSession({ prompt: true });
      throw error;
    }
  }
  throw new UserMessageError("Someone else changed this record at the same time. Reload and try once more.");
}

async function createPersonWithHoliday(input, { admin = false } = {}) {
  await reloadPeople();
  const existing = findPersonByName(state.people, input.name);
  if (existing) return addHolidayToExisting(existing, input, { admin });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const personId = crypto.randomUUID();
    const person = {
      id: personId,
      name: normalizeName(input.name),
      holidays: [{ id: crypto.randomUUID(), start: input.start, end: input.end }],
    };
    const document = await encryptJson(person, state.secrets);
    try {
      const response = admin
        ? await api.adminCreatePerson({ id: personId, document }, state.adminToken)
        : await api.createPerson({ id: personId, document }, state.sessionToken);
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

async function addHolidayToExisting(person, input, { admin = false } = {}) {
  const holiday = { id: crypto.randomUUID(), start: input.start, end: input.end };
  return commitPersonMutation(person.id, (latest) => {
    if (latest.holidays.some((item) => item.start === holiday.start && item.end === holiday.end)) throw new UserMessageError("This exact holiday range already exists.");
    latest.holidays.push(holiday);
    latest.holidays.sort((a, b) => a.start.localeCompare(b.start));
    return latest;
  }, { admin });
}

async function saveHoliday(event) {
  event.preventDefault();
  if (state.busy) return;
  const personId = $("editPersonId").value;
  const holidayId = $("editHolidayId").value;
  const input = { name: $("employeeName").value, start: $("holidayStart").value, end: $("holidayEnd").value };
  const person = personId ? state.people.find((candidate) => candidate.id === personId) : findPersonByName(state.people, input.name);
  const admin = Boolean(state.adminToken);
  if ((person && !canManageHoliday(person)) || (!person && !admin && canonicalName(input.name) !== canonicalName(state.account?.displayName ?? ""))) {
    $("holidayFormMessage").textContent = "You can only change your own holidays. Use Admin mode to manage someone else.";
    return;
  }
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
      }, { admin });
      showToast("Holiday updated and confirmed in GitHub.");
    } else if (person) {
      await addHolidayToExisting(person, input, { admin });
      showToast("Holiday added and confirmed in GitHub.");
    } else {
      await createPersonWithHoliday(input, { admin });
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
  if (!canManageHoliday(person)) {
    showToast("You can only delete your own holidays. Use Admin mode to manage someone else.", "error");
    return;
  }
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
    }, { admin: Boolean(state.adminToken) });
    showToast("Holiday deleted and confirmed in GitHub.");
  } catch (error) {
    showToast(error.message || "The holiday could not be deleted.", "error");
  }
}

function resetOverlapConfirmation() {
  state.overlapConfirmation = null;
  $("saveHolidayButton").textContent = $("editHolidayId").value ? "Save changes" : "Save holiday";
  const weekendSelected = [$("holidayStart").value, $("holidayEnd").value].some((value) => value && isWeekendIso(value));
  $("holidayFormMessage").textContent = weekendSelected ? "Holidays cannot start or end on Saturday or Sunday." : "";
}

function openAdmin(feature = null) {
  if (!apiConfigured()) {
    showToast("Admin controls need the secure write service.", "error");
    return;
  }
  state.pendingAdminFeature = feature;
  if (state.adminToken && state.adminExpiresAt <= Date.now()) clearAdminSession();
  $("adminLoginMessage").textContent = "";
  if (state.adminToken && feature) {
    state.pendingAdminFeature = null;
    openDirectFeature(feature);
    return;
  }
  if (state.adminToken) showAdminPanel();
  else {
    $("editHomeButton").hidden = true;
    $("adminLoginForm").hidden = false;
    $("adminPanel").hidden = true;
  }
  showDialog($("adminDialog"));
  if (!state.adminToken) $("adminPassword").focus();
}

function showAdminPanel() {
  $("adminLoginForm").hidden = true;
  $("adminPanel").hidden = false;
  $("editHomeButton").hidden = !state.adminToken;
  $("groupNameInput").value = state.config.groupName;
  renderAdminLinks();
  state.adminConfigBase = structuredClone(state.config);
  $("configFormMessage").textContent = "";
  renderAdminPeople();
}

function renderAdminLinks() {
  const editor = $("adminLinks");
  editor.replaceChildren();
  state.config.links.forEach((link, index) => {
    const row = makeElement("div", "admin-link-row");
    const number = makeElement("span", "admin-link-number", String(index + 1).padStart(2, "0"));
    const nameField = makeElement("label", "field");
    nameField.append(makeElement("span", "", "Button name"));
    const name = document.createElement("input");
    name.className = "link-label";
    name.maxLength = 40;
    name.value = link.label;
    name.placeholder = "e.g. Timesheets";
    nameField.append(name);
    const urlField = makeElement("label", "field");
    urlField.append(makeElement("span", "", "Link URL"));
    const url = document.createElement("input");
    url.className = "link-url";
    url.type = "url";
    url.maxLength = 500;
    url.value = link.url;
    url.placeholder = "https://…";
    urlField.append(url);
    row.append(number, nameField, urlField);
    editor.append(row);
  });
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
    const pendingFeature = state.pendingAdminFeature;
    beginAdminSession(response.token, response.expiresIn);
    $("adminPassword").value = "";
    if (pendingFeature) {
      state.pendingAdminFeature = null;
      closeDialog($("adminDialog"));
      openDirectFeature(pendingFeature);
    } else showAdminPanel();
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
    version: 2,
    groupName: normalizeName($("groupNameInput").value),
    mom: state.config.mom,
    shoutouts: structuredClone(state.config.shoutouts),
    birthdays: structuredClone(state.config.birthdays),
    officeDays: [...(state.config.officeDays ?? [])],
    links: [...$("adminLinks").querySelectorAll(".admin-link-row")].map((row) => ({
      label: row.querySelector(".link-label").value,
      url: row.querySelector(".link-url").value,
    })),
  };
  try {
    assertConfigRecord(changes);
  } catch (error) {
    $("configFormMessage").textContent = error.message;
    return;
  }
  const button = $("configForm").querySelector("button[type='submit']");
  const original = structuredClone(state.adminConfigBase ?? state.config);
  const changedFields = Object.keys(changes).filter((field) => JSON.stringify(changes[field]) !== JSON.stringify(original[field]));
  if (!changedFields.length) {
    $("configFormMessage").textContent = "There are no changes to save.";
    return;
  }
  state.busy = true;
  setButtonBusy(button, true, "Saving…", "Save homepage");
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
        $("configFormMessage").textContent = "Saved.";
        $("configFormMessage").classList.add("success");
        renderAdminLinks();
        showToast("Homepage updated.");
        return;
      } catch (error) {
        if (error instanceof ApiError && error.status === 409 && error.details?.latest?.document) {
          base = assertConfigRecord(await decryptJson(error.details.latest.document, state.secrets));
          meta = error.details.latest;
          continue;
        }
        if (error instanceof ApiError && error.status === 401) clearAdminSession({ prompt: true });
        throw error;
      }
    }
    throw new UserMessageError("The homepage changed elsewhere. Reopen Admin and try again.");
  } catch (error) {
    $("configFormMessage").classList.remove("success");
    $("configFormMessage").textContent = error.message || "The homepage could not be saved.";
  } finally {
    state.busy = false;
    setButtonBusy(button, false, "Saving…", "Save homepage");
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
    if (state.presence.members.some((member) => member.accountId === personId)) {
      await commitPresenceMutation((latest) => {
        const demoMember = latest.members.find((member) => member.accountId === personId);
        if (demoMember) demoMember.displayName = name;
        return latest;
      });
    }
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
  const demoScheduleMember = state.presence.members.find((member) => member.accountId === personId);
  const scheduleCopy = demoScheduleMember ? structuredClone(demoScheduleMember) : null;
  const scheduleMessage = demoScheduleMember ? " Their demo work-location row will also be removed." : "";
  const confirmed = await confirmAction("Delete this person?", `${person.name} and all ${person.holidays.length} of their holiday records will be removed.${scheduleMessage} This cannot be undone.`, "Delete person");
  if (!confirmed) return;
  let scheduleRemoved = false;
  try {
    if (demoScheduleMember) {
      await commitPresenceMutation((latest) => {
        latest.members = latest.members.filter((member) => member.accountId !== personId);
        return latest;
      });
      scheduleRemoved = true;
    }
    await api.adminDeletePerson(personId, state.adminToken);
    state.people = state.people.filter((candidate) => candidate.id !== personId);
    state.personMeta.delete(personId);
    renderAll();
    showToast(`${person.name} was deleted.`);
  } catch (error) {
    if (scheduleRemoved && scheduleCopy) {
      try {
        await commitPresenceMutation((latest) => {
          if (!latest.members.some((member) => member.accountId === personId)) latest.members.push(scheduleCopy);
          return latest;
        });
      } catch {}
    }
    if (error instanceof ApiError && error.status === 401) clearAdminSession({ prompt: true });
    showToast(error.message || "The person could not be deleted.", "error");
  }
}

function changeMonth(offset) {
  state.month = new Date(state.month.getFullYear(), state.month.getMonth() + offset, 1);
  renderSummaries();
  renderCalendar();
}

function bindEvents() {
  $("loginTab").addEventListener("click", () => switchAuthView("login"));
  $("createTab").addEventListener("click", () => switchAuthView("create"));
  $("loginForm").addEventListener("submit", loginAccount);
  $("createForm").addEventListener("submit", createAccount);
  $("brandHomeButton").addEventListener("click", () => setView("home"));
  $("navHome").addEventListener("click", () => setView("home"));
  $("navHolidays").addEventListener("click", () => setView("holidays"));
  $("navWork").addEventListener("click", () => setView("work"));
  $("momCardButton").addEventListener("click", openMom);
  $("shoutoutsCardButton").addEventListener("click", () => openAdmin("shoutouts"));
  $("birthdaysCardButton").addEventListener("click", () => openAdmin("birthdays"));
  $("momEditButton").addEventListener("click", () => { closeDialog($("momDialog")); openAdmin("mom"); });
  $("momQuickForm").addEventListener("submit", saveMomQuick);
  $("shoutoutsForm").addEventListener("submit", saveDirectShoutouts);
  $("birthdaysForm").addEventListener("submit", saveDirectBirthdays);
  $("directAddShoutoutPerson").addEventListener("click", () => appendDirectShoutoutRow());
  $("directAddBirthday").addEventListener("click", () => appendDirectBirthdayRow());
  $("profileButton").addEventListener("click", openProfile);
  $("profileForm").addEventListener("submit", saveProfile);
  $("editHomeButton").addEventListener("click", () => openAdmin());
  $("teamOfficeDaysButton").addEventListener("click", openTeamOfficeDays);
  $("lockButton").addEventListener("click", lockPlanner);
  $("addHolidayButton").addEventListener("click", openAddHoliday);
  $("emptyAddButton").addEventListener("click", openAddHoliday);
  $("holidayForm").addEventListener("submit", saveHoliday);
  $("holidayStartButton").addEventListener("click", () => openDatePicker("holidayStart"));
  $("holidayEndButton").addEventListener("click", () => openDatePicker("holidayEnd"));
  $("datePickerPrevious").addEventListener("click", () => changeDatePickerMonth(-1));
  $("datePickerNext").addEventListener("click", () => changeDatePickerMonth(1));
  $("datePickerCancel").addEventListener("click", closeDatePicker);
  $("datePickerGrid").addEventListener("keydown", handleDatePickerKeys);
  $("datePickerDialog").addEventListener("cancel", (event) => { event.preventDefault(); closeDatePicker(); });
  $("officeDaysPrevious").addEventListener("click", () => changeOfficeDaysMonth(-1));
  $("officeDaysNext").addEventListener("click", () => changeOfficeDaysMonth(1));
  $("clearOfficeDays").addEventListener("click", clearOfficeDaysMonth);
  $("saveOfficeDays").addEventListener("click", saveTeamOfficeDays);
  $("deleteHolidayButton").addEventListener("click", deleteHoliday);
  for (const id of ["employeeName", "holidayStart", "holidayEnd"]) $(id).addEventListener("input", resetOverlapConfirmation);
  $("adminButton").addEventListener("click", () => openAdmin());
  $("adminLoginForm").addEventListener("submit", adminLogin);
  $("configForm").addEventListener("submit", saveConfig);
  $("previousMonth").addEventListener("click", () => changeMonth(-1));
  $("nextMonth").addEventListener("click", () => changeMonth(1));
  $("todayButton").addEventListener("click", () => {
    state.month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    renderSummaries();
    renderCalendar();
  });
  $("confirmCancel").addEventListener("click", () => settleConfirmation(false));
  $("confirmAccept").addEventListener("click", () => settleConfirmation(true));
  $("confirmDialog").addEventListener("cancel", (event) => { event.preventDefault(); settleConfirmation(false); });
  $("adminDialog").addEventListener("close", () => { state.pendingAdminFeature = null; });
  for (const button of document.querySelectorAll("[data-close-dialog]")) {
    button.addEventListener("click", () => closeDialog($(button.dataset.closeDialog)));
  }
  const restoreViewFromUrl = () => { if (state.unlocked) setView(location.hash.replace(/^#/u, "") || "home", { updateHash: false }); };
  window.addEventListener("popstate", restoreViewFromUrl);
  window.addEventListener("hashchange", restoreViewFromUrl);
  window.addEventListener("pointerdown", recordAccountActivity, { passive: true });
  window.addEventListener("keydown", recordAccountActivity);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.unlocked) scheduleAccountSessionTimers({ resetActivity: false });
  });
}

clearLegacyStoredSession();
bindEvents();
