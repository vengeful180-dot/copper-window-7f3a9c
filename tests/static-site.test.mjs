import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("public shell is unlisted and contains no protected seed content", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /noindex,nofollow,noarchive/u);
  assert.doesNotMatch(html, /John Smith|2026-08-20|Friday meeting moved/u);
  assert.match(html, /id="unlockView"/u);
  assert.match(html, /id="loginForm"/u);
  assert.match(html, /id="createForm"/u);
  assert.match(html, /id="appView"[^>]*hidden/u);
  assert.match(html, /id="homePage"/u);
  assert.match(html, /id="holidaysPage"[^>]*hidden/u);
  assert.match(html, /id="workPage"[^>]*hidden/u);
  assert.match(html, /id="quickLinks"/u);
  assert.doesNotMatch(html, /id="announcementValue"|id="weekLabelValue"/u);
});

test("frontend never uses persistent local storage or unsafe HTML insertion", async () => {
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /localStorage|\.innerHTML\s*=|insertAdjacentHTML/u);
  const sessionFields = app.match(/sessionStorage\.setItem\(SESSION_KEY,\s*JSON\.stringify\(\{([\s\S]*?)\}\)\);/u)?.[1];
  assert.ok(sessionFields);
  assert.doesNotMatch(sessionFields, /password|people|config/iu);
});

test("holiday fields use a weekday-only calendar instead of the native date picker", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="holidayStart"[^>]*type="hidden"/u);
  assert.match(html, /id="holidayEnd"[^>]*type="hidden"/u);
  assert.match(html, /id="holidayStartButton"[^>]*aria-controls="datePickerDialog"/u);
  assert.match(html, /id="datePickerDialog"/u);
  assert.doesNotMatch(html, /id="holiday(?:Start|End)"[^>]*type="date"/u);
  assert.match(app, /day\.disabled\s*=\s*weekend/u);
  assert.match(app, /if \(!weekend\) day\.addEventListener/u);
});

test("personal accounts use an eight-character minimum and cache-busted portal assets", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="loginPassword"[^>]*minlength="8"/u);
  assert.match(html, /id="createPassword"[^>]*minlength="8"/u);
  assert.match(html, /id="confirmPassword"[^>]*minlength="8"/u);
  assert.match(html, /Use at least 8 characters/u);
  assert.match(html, /assets\/app\.js\?v=/u);
  assert.match(html, /assets\/styles\.css\?v=/u);
  assert.match(html, /assets\/design-v3\.css\?v=20260812-imagen-controls-v1/u);
  assert.match(app, /MIN_ACCOUNT_PASSWORD_LENGTH\s*=\s*8/u);
  assert.match(app, /Your password was accepted, but this page was out of date/u);
});

test("team totals are plain metadata without generic or decorative counter shapes", async () => {
  const [html, app, design] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../assets/design-v3.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /assets\/app\.js\?v=20260812-imagen-controls-v1/u);
  assert.match(app, /memberCount\.append\(makeElement\("strong"[\s\S]*?makeElement\("small"/u);
  assert.match(design, /\.count-badge\s*\{[\s\S]*?border-radius:\s*0/u);
  assert.match(design, /\.count-badge::before\s*\{\s*content:\s*none/u);
  assert.match(design, /\.work-week-heading \.work-member-count\s*\{[\s\S]*?justify-content:\s*center[\s\S]*?border:\s*0/u);
  assert.match(design, /\.work-week-heading \.work-member-count strong\s*\{/u);
  assert.doesNotMatch(design, /\.work-week-heading \.work-member-count::after/u);
  assert.doesNotMatch(design, /\.work-week-heading \.work-member-count\s*\{[^}]*border-radius:\s*999px/u);
});

test("custom Imagen controls replace generic circular arrows", async () => {
  const design = await readFile(new URL("../assets/design-v3.css", import.meta.url), "utf8");
  assert.match(design, /\.profile-chevron\s*\{[\s\S]*?profile-forward-gem-v1\.png[\s\S]*?border-radius:\s*0/u);
  assert.match(design, /\.action-arrow\s*\{[\s\S]*?action-forward-gem-v1\.png[\s\S]*?border-radius:\s*0/u);
  assert.match(design, /\.account-chip:hover \.profile-chevron\s*\{[\s\S]*?profile-forward-gem-v1\.png/u);
  assert.match(design, /\.portal-action-card:hover \.action-arrow\s*\{[\s\S]*?action-forward-gem-v1\.png/u);
});

test("header navigation stays truly centered and stable between pages", async () => {
  const [html, app, styles] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../assets/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(styles, /grid-template-columns:\s*minmax\(0, 1fr\) auto minmax\(0, 1fr\)/u);
  assert.match(styles, /\.app-nav\s*\{[^}]*justify-self:\s*center/u);
  assert.match(styles, /grid-template-areas:\s*"brand actions" "nav nav"/u);
  assert.match(styles, /html\s*\{[^}]*overflow-y:\s*auto[^}]*scrollbar-gutter:\s*stable/u);
  assert.match(html, /id="addHolidayButton"[^>]*type="button"(?![^>]*hidden)/u);
  assert.doesNotMatch(app, /\$\("addHolidayButton"\)\.hidden/u);
});

test("homepage editing is visible only during a live Admin session", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="editHomeButton"[^>]*hidden/u);
  assert.match(app, /function clearAdminSession[\s\S]*?\$\("editHomeButton"\)\.hidden = true;/u);
  assert.match(app, /function beginAdminSession[\s\S]*?\$\("editHomeButton"\)\.hidden = false;/u);
  assert.match(app, /setTimeout\(\(\) => clearAdminSession\(\{ prompt: true \}\), lifetimeMs\)/u);
});

test("midnight prism design system brings a balanced multicolor identity to every surface", async () => {
  const [html, design] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/design-v3.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /theme-color" content="#081923"/u);
  assert.match(design, /--green:\s*#39c6a0/u);
  assert.match(design, /--coral:\s*#ff806c/u);
  assert.match(design, /--blue:\s*#70a7ff/u);
  assert.match(design, /\.holidays-action\s*\{[\s\S]*?rgba\(133, 48, 74/u);
  assert.match(design, /\.work-action\s*\{[\s\S]*?rgba\(17, 91, 99/u);
  assert.match(design, /\.modal-card\s*\{[\s\S]*?#3ac6a0/u);
  assert.match(design, /@media \(max-height: 900px\) and \(min-width: 700px\)/u);
});

test("MOM and the encrypted personal profile are interactive polished controls", async () => {
  const [html, api, app, styles] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/api.js", import.meta.url), "utf8"),
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../assets/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="momCardButton"[^>]*aria-controls="momDialog"/u);
  assert.match(html, /id="momDialog"/u);
  assert.match(html, /id="momEditButton"[^>]*hidden/u);
  assert.match(html, /id="profileButton"[^>]*aria-controls="profileDialog"/u);
  assert.match(html, /id="profilePassword"[^>]*minlength="8"/u);
  assert.doesNotMatch(html, /portal-hero-meta|Holiday planning|Work rhythm|Team links/u);
  assert.match(api, /accountRename:\s*\(body, sessionToken\)/u);
  assert.match(app, /api\.accountRename/u);
  assert.match(app, /function openMom\(\)/u);
  assert.match(app, /function saveProfile\(event\)/u);
  assert.match(styles, /\.mom-title\s*\{[^}]*1\.72rem/u);
  assert.match(styles, /\.mom-viewer-content\s*\{[^}]*linear-gradient/u);
  assert.match(styles, /\.account-chip:hover/u);
});

test("homepage uses optimized architectural artwork over a resolution-independent CSS backdrop", async () => {
  const [html, styles] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /assets\/images\/dream-team-architecture\.webp/u);
  assert.match(html, /alt="Modern emerald-glass office buildings surrounded by landscaped trees"/u);
  assert.doesNotMatch(styles, /url\("images\/portal-green-background\.webp"\)/u);
  assert.match(styles, /\.app-shell::before\s*\{[^}]*position:\s*fixed[^}]*dream-team-site-background-v2\.webp[^}]*cover no-repeat/u);
  assert.doesNotMatch(styles, /hero-sheen|\.portal-hero::after\s*\{[^}]*animation:/u);
  assert.match(styles, /\.portal-hero-backdrop\s*\{[^}]*position:\s*absolute[^}]*object-fit:\s*cover/u);
  assert.doesNotMatch(html, /portal-hero-visual/u);
});

test("emerald art direction replaces flat homepage and work surfaces", async () => {
  const [html, styles] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /Your team, in rhythm/u);
  assert.match(styles, /\.holidays-action\s*\{[^}]*linear-gradient/u);
  assert.match(styles, /\.quick-links-card\s*\{[^}]*linear-gradient/u);
  assert.doesNotMatch(html, /class="page-heading"[^>]*>[\s\S]*?Where we work/u);
  assert.match(styles, /@media \(min-width: 1181px\) and \(max-height: 1100px\)/u);
});

test("calendar and work schedule use dark integrated surfaces instead of white sheets and pills", async () => {
  const [html, styles] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /20260812-background-v2/u);
  assert.match(styles, /\.calendar-card\s*\{[^}]*linear-gradient[^}]*color:\s*#f7fcf8/u);
  assert.match(styles, /\.calendar-day\s*\{[^}]*linear-gradient/u);
  assert.doesNotMatch(html, /class="work-legend"/u);
  assert.match(styles, /\.work-status::before\s*\{/u);
  assert.match(styles, /\.work-status\.is-home\s*\{\s*color:/u);
  assert.match(styles, /button\.work-status\.is-home\s*\{[^}]*linear-gradient/u);
});

test("dialogs use dark emerald surfaces and controls instead of white cards", async () => {
  const [html, styles] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /20260812-background-v2/u);
  assert.match(styles, /\.modal-card\s*\{[^}]*linear-gradient[^}]*color:\s*#f7fcf8/u);
  assert.match(styles, /\.modal-card input, \.modal-card textarea\s*\{[^}]*background:\s*rgba\(255,255,255,\.075\)/u);
  assert.match(styles, /\.date-picker-trigger\s*\{[^}]*background:\s*rgba\(255,255,255,\.075\)/u);
  assert.match(styles, /\.date-picker-heading \.icon-button\s*\{[^}]*background:\s*rgba\(255,255,255,\.065\)/u);
  assert.match(styles, /\.modal-card \.button-primary\s*\{[^}]*linear-gradient/u);
  assert.match(styles, /\.admin-person\s*\{[^}]*background:\s*rgba\(255,255,255,\.055\)/u);
  assert.match(styles, /html:has\(dialog\[open\]\)\s*\{\s*overflow:\s*hidden/u);
});

test("holiday calendar keeps its layered glass treatment without scroll-flickering blur layers", async () => {
  const [html, styles] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /20260812-background-v2/u);
  assert.match(styles, /\.calendar-card\s*\{[^}]*linear-gradient\(118deg[^}]*linear-gradient\(145deg/u);
  assert.match(styles, /\.calendar-card::before\s*\{/u);
  assert.match(styles, /\.calendar-card::after\s*\{/u);
  assert.match(styles, /\.calendar-day\s*\{[^}]*linear-gradient/u);
  assert.match(styles, /\.holiday-chip\s*\{[^}]*linear-gradient/u);
  assert.doesNotMatch(styles, /\.(?:summary-card|calendar-card|calendar-grid|holiday-chip)\s*\{[^}]*backdrop-filter/u);
  assert.match(styles, /@media \(min-width: 1081px\)[\s\S]*?\.sidebar\s*\{[^}]*max-height:\s*calc\(100vh - 126px\)[^}]*overflow-y:\s*auto[^}]*contain:\s*paint/u);
});

test("work-location controls fill the entire day cell and carry their status tint", async () => {
  const [app, styles] = await Promise.all([
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../assets/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(styles, /button\.work-status\s*\{[^}]*width:\s*100%[^}]*min-height:\s*58px/u);
  assert.match(styles, /button\.work-status\.is-home\s*\{[^}]*linear-gradient/u);
  assert.match(styles, /button\.work-status\.is-office\s*\{[^}]*linear-gradient/u);
  assert.match(styles, /\.work-day-cell:has\(> button\.work-status\)\s*\{\s*padding:\s*0/u);
  assert.match(styles, /button\.work-status:focus-visible\s*\{/u);
  assert.match(app, /const members = Object\.freeze\(/u);
  assert.match(app, /table\.dataset\.memberCount = String\(members\.length\)/u);
  assert.match(app, /table\.append\(header, \.\.\.members\.map\(\(member\) => workMemberRow/u);
  assert.match(app, /const editable = ownRow \|\| Boolean\(state\.adminToken\)/u);
  assert.match(app, /toggleOfficeDay\(member\.accountId, member\.displayName, iso\)/u);
  assert.match(app, /api\.adminUpdatePresence/u);
  assert.match(styles, /\.work-schedule\s*\{[^}]*align-items:\s*start/u);
  assert.match(styles, /\.work-table\s*\{[^}]*display:\s*grid[^}]*contain:\s*layout paint/u);
  assert.match(styles, /\.work-table\s*\{[^}]*grid-auto-rows:\s*58px/u);
  assert.match(styles, /\.work-row\s*\{[^}]*height:\s*58px/u);
  assert.match(styles, /\.work-day-cell\.is-today\s*\{[^}]*padding:\s*0/u);
  assert.doesNotMatch(styles, /\.(?:work-week-card|work-empty)\s*\{[^}]*backdrop-filter/u);
  assert.match(app, /holidayRecordIds\.has\(member\.accountId\)[\s\S]*?"Demo"/u);
  assert.match(app, /latest\.members = latest\.members\.filter\(\(member\) => member\.accountId !== personId\)/u);
  assert.match(styles, /\.work-day-heading\.is-today\s*\{[^}]*linear-gradient[^}]*inset 2px 0/u);
  assert.match(styles, /\.work-day-cell\.is-today\s*\{[^}]*linear-gradient[^}]*inset 2px 0/u);
  assert.match(styles, /\.work-row\.is-current-user\s*\{[^}]*linear-gradient[^}]*box-shadow/u);
});

test("summary cards begin at today instead of repeating holidays that started earlier", async () => {
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  assert.match(app, /const awayToday = peopleStartingBetween\(state\.people, today, today\)/u);
  assert.match(app, /const awayWeek = peopleStartingBetween\(state\.people, today, weekEnd\)/u);
  assert.match(app, /Away today/u);
  assert.doesNotMatch(app, /const awayToday = peopleAwayOn/u);
});

test("holiday ownership controls, current-user accents, and crowded-day disclosure are wired into the UI", async () => {
  const [html, api, app, styles] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/api.js", import.meta.url), "utf8"),
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../assets/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="dayHolidaysDialog"/u);
  assert.match(html, /20260812-background-v2/u);
  assert.match(api, /adminCreatePerson:\s*\(body, adminToken\)/u);
  assert.match(app, /function canManageHoliday\(person\)/u);
  assert.match(app, /const editable = canManageHoliday\(person\)/u);
  assert.match(app, /openDayHolidays\(cell\.iso\)/u);
  assert.match(app, /sortPeopleForCurrent/u);
  assert.match(styles, /\.holiday-chip\.is-current-user/u);
  assert.match(styles, /\.day-holiday-entry\.is-current-user/u);
  assert.match(styles, /\.you-badge/u);
});

test("account records remain server-side and are excluded from the Pages artifact", async () => {
  const build = await readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8");
  assert.match(build, /\["index\.html", "robots\.txt", "assets"\]/u);
  assert.match(build, /"presence\.enc\.json"/u);
  assert.doesNotMatch(build, /data[\\/]accounts/u);
  assert.doesNotMatch(build, /path\.join\(root, "data"\)(?!,)/u);
});
