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

test("frontend keeps credentials in memory only and avoids unsafe HTML insertion", async () => {
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /localStorage|\.innerHTML\s*=|insertAdjacentHTML/u);
  assert.doesNotMatch(app, /sessionStorage\.(?:setItem|getItem)/u);
  assert.match(app, /sessionStorage\.removeItem\(LEGACY_SESSION_KEY\)/u);
  assert.match(app, /SESSION_IDLE_TIMEOUT_MS\s*=\s*30 \* 60 \* 1000/u);
});

test("production shell is frame-blocked and connects only to the exact Worker", async () => {
  const [html, app, styles] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../assets/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /connect-src 'self' https:\/\/quiet-leave-gateway\.vengeful180\.workers\.dev/u);
  assert.doesNotMatch(html, /https:\/\/\*\.workers\.dev|connect-src[^"]*localhost|connect-src[^"]*127\.0\.0\.1/u);
  assert.match(html, /frame-src 'none'; child-src 'none'; worker-src 'none'/u);
  assert.match(html, /require-trusted-types-for 'script'; trusted-types 'none'/u);
  assert.match(app, /window\.top !== window\.self[\s\S]*?document\.body\.replaceChildren\(\)[\s\S]*?classList\.add\("is-top-level"\)/u);
  assert.match(styles, /html:not\(\.is-top-level\) body\s*\{[\s\S]*?visibility:\s*hidden !important/u);
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
  assert.match(html, /id="teamInvitePassword"[^>]*minlength="7"/u);
  assert.match(html, /Use at least 8 characters/u);
  assert.match(html, /assets\/app\.js\?v=/u);
  assert.match(html, /assets\/styles\.css\?v=/u);
  assert.match(html, /assets\/design-v3\.css\?v=20260825-mom-reader-v15/u);
  assert.match(app, /MIN_ACCOUNT_PASSWORD_LENGTH\s*=\s*8/u);
  assert.match(app, /MIN_TEAM_INVITE_PASSWORD_LENGTH\s*=\s*7/u);
  assert.doesNotMatch(html, /id="teamInvitePassword"[^>]*value=/u);
  assert.match(app, /Your password was accepted, but this page was out of date/u);
});

test("team totals are plain metadata without generic or decorative counter shapes", async () => {
  const [html, app, design] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../assets/design-v3.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /assets\/app\.js\?v=20260825-security-v1/u);
  assert.match(app, /memberCount\.append\(makeElement\("strong"[\s\S]*?makeElement\("small"/u);
  assert.match(design, /\.count-badge\s*\{[\s\S]*?border-radius:\s*0/u);
  assert.match(html, /id="awayTodayCount"[^>]*data-label="away"/u);
  assert.match(html, /id="peopleCount"[^>]*data-label="people"/u);
  assert.match(design, /\.count-badge::before\s*\{\s*content:\s*none/u);
  assert.match(design, /\.count-badge::after\s*\{[\s\S]*?content:\s*attr\(data-label\)/u);
  assert.match(design, /\.work-week-heading \.work-member-count\s*\{[\s\S]*?justify-content:\s*center[\s\S]*?border:\s*0/u);
  assert.match(design, /\.work-week-heading \.work-member-count strong\s*\{/u);
  assert.doesNotMatch(design, /\.work-week-heading \.work-member-count::after/u);
  assert.doesNotMatch(design, /\.work-week-heading \.work-member-count\s*\{[^}]*border-radius:\s*999px/u);
});

test("official Lucide arrows provide one professional icon system", async () => {
  const [design, chevron, right, upRight, license] = await Promise.all([
    readFile(new URL("../assets/design-v3.css", import.meta.url), "utf8"),
    readFile(new URL("../assets/icons/lucide-chevron-right.svg", import.meta.url), "utf8"),
    readFile(new URL("../assets/icons/lucide-arrow-right.svg", import.meta.url), "utf8"),
    readFile(new URL("../assets/icons/lucide-arrow-up-right.svg", import.meta.url), "utf8"),
    readFile(new URL("../assets/icons/LUCIDE-LICENSE.txt", import.meta.url), "utf8"),
  ]);
  assert.match(design, /\.profile-chevron\s*\{[\s\S]*?lucide-chevron-right\.svg/u);
  assert.match(design, /\.action-arrow\s*\{[\s\S]*?lucide-arrow-right\.svg/u);
  assert.match(design, /\.mom-card-arrow\s*\{[\s\S]*?lucide-arrow-up-right\.svg/u);
  assert.match(chevron, /stroke-linecap="round"[\s\S]*?m9 18 6-6-6-6/u);
  assert.match(right, /M5 12h14[\s\S]*?m12 5 7 7-7 7/u);
  assert.match(upRight, /M7 7h10v10[\s\S]*?M7 17 17 7/u);
  assert.match(license, /ISC License[\s\S]*?The MIT License/u);
  assert.doesNotMatch(design, /forward-gem-v1\.png/u);
});

test("monthly team office days are Admin-owned defaults with personal Home overrides", async () => {
  const [html, app, model, design] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../assets/model.js", import.meta.url), "utf8"),
    readFile(new URL("../assets/design-v3.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="teamOfficeDaysButton"[^>]*aria-controls="teamOfficeDaysDialog"/u);
  assert.match(html, /id="officeDaysGrid"/u);
  assert.match(app, /function saveTeamOfficeDays\(\)/u);
  assert.match(app, /isOfficeDay\(member, state\.config\.officeDays, iso\)/u);
  assert.match(app, /function workStatusNode[\s\S]*?if \(holiday\)[\s\S]*?return status;[\s\S]*?isOfficeDay/u);
  assert.match(app, /member\.homeDays = \[\.\.\.member\.homeDays\.filter/u);
  assert.match(app, /state\.config\.officeDays\.includes\(iso\)[\s\S]*?member\.officeDays\.filter/u);
  assert.match(model, /MONTHLY_OFFICE_DAY_LIMIT = 4/u);
  assert.match(model, /export function isOfficeDay/u);
  assert.match(design, /\.team-office-days\s*\{/u);
  assert.match(design, /\.office-days-modal\s*\{[^}]*width:\s*min\(calc\(100% - 28px\), 760px\)[^}]*overflow-x:\s*hidden/u);
  assert.match(design, /\.office-days-card\s*\{[^}]*width:\s*100%[^}]*max-width:\s*100%[^}]*box-sizing:\s*border-box[^}]*overflow-x:\s*hidden/u);
});

test("architectural background grid stays visibly defined", async () => {
  const design = await readFile(new URL("../assets/design-v3.css", import.meta.url), "utf8");
  assert.match(design, /\.app-shell::after\s*\{[\s\S]*?radial-gradient\(circle at 1px 1px,[\s\S]*?\.15[\s\S]*?linear-gradient\(rgba\(122, 184, 194, \.085\)/u);
  assert.match(design, /background-size:\s*72px 72px, 72px 72px, 72px 72px, auto/u);
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
  const [html, api, app, styles, design] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/api.js", import.meta.url), "utf8"),
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../assets/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../assets/design-v3.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="momCardButton"[^>]*aria-controls="momDialog"/u);
  assert.match(html, /id="momDialog"/u);
  assert.match(html, /id="momQuickForm"[^>]*hidden/u);
  assert.match(html, /id="momQuickInput"[^>]*maxlength="1200"/u);
  assert.match(html, /id="momReadView"[^>]*aria-label="Full meeting notes"[^>]*tabindex="0"/u);
  assert.match(html, /id="profileButton"[^>]*aria-controls="profileDialog"/u);
  assert.match(html, /id="profilePassword"[^>]*minlength="8"/u);
  assert.doesNotMatch(html, /portal-hero-meta|Holiday planning|Work rhythm|Team links/u);
  assert.match(api, /accountRename:\s*\(body, sessionToken\)/u);
  assert.match(app, /api\.accountRename/u);
  assert.match(app, /function openMom\(\)/u);
  assert.match(app, /\$\("momReadView"\)\.scrollTop\s*=\s*0/u);
  assert.match(app, /function saveMomQuick\(event\)/u);
  assert.match(app, /function saveProfile\(event\)/u);
  assert.match(styles, /\.mom-title\s*\{[^}]*1\.72rem/u);
  assert.match(styles, /\.mom-viewer-content\s*\{[^}]*linear-gradient/u);
  assert.match(styles, /\.account-chip:hover/u);
  assert.match(design, /\.home-feature-card\s*\{[^}]*min-height:\s*432px/u);
  assert.match(design, /\.mom-viewer-card\s*\{[^}]*height:\s*min\(760px,[^}]*overflow:\s*hidden/u);
  assert.match(design, /\.mom-viewer-content\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/u);
});

test("homepage uses optimized red-panda artwork over a resolution-independent CSS backdrop", async () => {
  const [html, styles] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /assets\/images\/dream-team-red-pandas\.webp/u);
  assert.match(html, /alt="Six red pandas gathered together on mossy branches in a forest"/u);
  assert.doesNotMatch(styles, /url\("images\/portal-green-background\.webp"\)/u);
  assert.match(styles, /\.app-shell::before\s*\{[^}]*position:\s*fixed[^}]*dream-team-site-background-v2\.webp[^}]*cover no-repeat/u);
  assert.doesNotMatch(styles, /hero-sheen|\.portal-hero::after\s*\{[^}]*animation:/u);
  assert.match(styles, /\.portal-hero-backdrop\s*\{[^}]*position:\s*absolute[^}]*object-fit:\s*cover/u);
  assert.doesNotMatch(html, /portal-hero-visual/u);
});

test("emerald art direction replaces flat homepage and work surfaces", async () => {
  const [html, styles, design] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../assets/design-v3.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /Your team, in rhythm/u);
  const heroStart = html.indexOf('<div class="portal-hero">');
  const shortcuts = html.indexOf('id="quickLinks"');
  const highlights = html.indexOf('<div class="home-highlights">');
  assert.ok(heroStart >= 0 && shortcuts > heroStart && shortcuts < highlights, "Team shortcuts should live inside the hero.");
  assert.equal(html.match(/id="quickLinks"/gu)?.length, 1);
  assert.match(html, /<section class="quick-links-card hero-shortcuts" aria-label="Team shortcuts">/u);
  assert.doesNotMatch(html, /One click away|quickLinksTitle|6 spaces/u);
  assert.match(html, /id="momCardButton"[\s\S]*?id="shoutoutsTitle"[^>]*>Shoutouts[\s\S]*?id="birthdaysTitle"[^>]*>Birthdays/u);
  assert.match(html, /assets\/images\/home-mom\.webp/u);
  assert.match(html, /assets\/images\/home-shoutouts\.webp/u);
  assert.match(html, /assets\/images\/home-birthdays\.webp/u);
  assert.match(design, /\.home-feature-media\s*\{[^}]*flex:\s*0 0 132px/u);
  assert.doesNotMatch(html, /id="homeHolidaysButton"|id="homeWorkButton"/u);
  assert.match(design, /\.home-highlights\s*\{[^}]*repeat\(3, minmax\(0, 1fr\)\)/u);
  assert.match(styles, /\.quick-links-card\s*\{[^}]*linear-gradient/u);
  assert.doesNotMatch(html, /class="page-heading"[^>]*>[\s\S]*?Where we work/u);
  assert.match(styles, /@media \(min-width: 1181px\) and \(max-height: 1100px\)/u);
});

test("calendar and work schedule use dark integrated surfaces instead of white sheets and pills", async () => {
  const [html, styles] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /20260825-security-v1/u);
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
  assert.match(html, /20260825-security-v1/u);
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
  assert.match(html, /20260825-security-v1/u);
  assert.match(styles, /\.calendar-card\s*\{[^}]*linear-gradient\(118deg[^}]*linear-gradient\(145deg/u);
  assert.match(styles, /\.calendar-card::before\s*\{/u);
  assert.match(styles, /\.calendar-card::after\s*\{/u);
  assert.match(styles, /\.calendar-day\s*\{[^}]*linear-gradient/u);
  assert.match(styles, /\.holiday-chip\s*\{[^}]*linear-gradient/u);
  assert.doesNotMatch(styles, /\.(?:summary-card|calendar-card|calendar-grid|holiday-chip)\s*\{[^}]*backdrop-filter/u);
  assert.match(styles, /@media \(min-width: 1081px\)[\s\S]*?\.sidebar\s*\{[^}]*max-height:\s*calc\(100vh - 126px\)[^}]*overflow-y:\s*auto[^}]*contain:\s*paint/u);
});

test("work-location controls fill the entire day cell and carry their status tint", async () => {
  const [app, styles, design] = await Promise.all([
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../assets/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../assets/design-v3.css", import.meta.url), "utf8"),
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
  assert.match(design, /\.work-row\.is-current-user::after\s*\{[^}]*border:\s*3px solid #8f7467[^}]*border-left:\s*4px solid #c08d72/u);
  assert.match(design, /\.work-day-heading\.is-today,\s*\.work-day-cell\.is-today\s*\{[^}]*color:\s*inherit[^}]*background:\s*transparent[^}]*box-shadow:\s*none/u);
  assert.match(design, /\.work-day-heading\.is-today\s*\{[^}]*flex-direction:\s*column[^}]*rgba\(221, 159, 116, \.88\)[^}]*#18313d/u);
  assert.match(design, /\.work-day-heading\.is-today::before\s*\{[^}]*content:\s*"TODAY"[^}]*letter-spacing:\s*\.2em/u);
  assert.match(design, /\.work-day-heading\.is-today::after,\s*\.work-day-cell\.is-today::after\s*\{[^}]*border-left:\s*3px solid #7d9ba8[^}]*border-right:\s*3px solid #7d9ba8[^}]*filter:\s*none/u);
  assert.doesNotMatch(design, /\.work-(?:row\.is-current-user|day-(?:heading|cell)\.is-today)::after\s*\{[^}]*repeating-linear-gradient/u);
  assert.match(design, /\.work-status\.is-home\s*\{[^}]*color:\s*#78caff[^}]*rgba\(48, 143, 211, \.28\)/u);
  assert.match(design, /\.work-status\.is-office\s*\{[^}]*color:\s*#ffd166[^}]*rgba\(226, 169, 49, \.3\)/u);
  assert.match(design, /\.work-status\.is-holiday\s*\{[^}]*color:\s*#ff747d[^}]*rgba\(211, 62, 75, \.3\)/u);
  assert.match(design, /button\.work-status\s*\{[^}]*cursor:\s*pointer[^}]*transition:[^}]*transform/u);
  assert.match(design, /button\.work-status\.is-home:hover\s*\{[^}]*rgba\(57, 165, 235, \.5\)[^}]*inset 0 0 0 2px rgba\(145, 218, 255, \.82\)/u);
  assert.match(design, /button\.work-status\.is-office:hover\s*\{[^}]*rgba\(239, 187, 72, \.5\)[^}]*inset 0 0 0 2px rgba\(255, 218, 126, \.84\)/u);
  assert.doesNotMatch(design, /(?:button\.)?work-status\.is-holiday:hover/u);
  assert.match(design, /\.work-day-cell:has\(> \.work-status\)\s*\{[^}]*background:\s*transparent/u);
  assert.doesNotMatch(design, /\.work-day-cell\.is-today\s*>\s*\.work-status\s*\{[^}]*background-image:\s*none/u);
  assert.match(design, /\.work-day-cell\.is-today\s*>\s*\.work-status\.is-home\s*\{[^}]*rgba\(48, 143, 211, \.28\)/u);
  assert.match(design, /\.work-day-cell\.is-today\s*>\s*\.work-status\.is-office\s*\{[^}]*rgba\(226, 169, 49, \.3\)/u);
  assert.match(design, /\.work-day-cell\.is-today\s*>\s*\.work-status\.is-holiday\s*\{[^}]*rgba\(211, 62, 75, \.3\)/u);
  assert.doesNotMatch(styles, /\.(?:work-week-card|work-empty)\s*\{[^}]*backdrop-filter/u);
  assert.match(app, /holidayRecordIds\.has\(member\.accountId\)[\s\S]*?"Demo"/u);
  assert.match(app, /latest\.members = latest\.members\.filter\(\(member\) => member\.accountId !== personId\)/u);
  assert.match(styles, /\.work-day-heading\.is-today\s*\{[^}]*linear-gradient[^}]*inset 2px 0/u);
  assert.match(styles, /\.work-day-cell\.is-today\s*\{[^}]*linear-gradient[^}]*inset 2px 0/u);
  assert.match(styles, /\.work-row\.is-current-user\s*\{[^}]*linear-gradient[^}]*box-shadow/u);
});

test("summary cards show people whose holidays include today or the rest of this week", async () => {
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  assert.match(app, /peopleAwayBetween,[\s\S]*?peopleAwayOn,/u);
  assert.match(app, /const awayToday = peopleAwayOn\(state\.people, today\)/u);
  assert.match(app, /const awayWeek = peopleAwayBetween\(state\.people, today, weekEnd\)/u);
  assert.match(app, /activeHoliday\(person, rangeStart, rangeEnd \?\? rangeStart\)/u);
  assert.match(app, /Away today/u);
  assert.match(app, /No one is away today\./u);
  assert.doesNotMatch(app, /peopleStartingBetween|holidayStartingBetween|No holidays start today/u);
});

test("holiday-record people follow the displayed month and exclude elapsed dates", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="peopleCardTitle">This month</u);
  assert.match(app, /const monthStart = toIsoDate\(new Date\(displayedYear, displayedMonth, 1\)\)/u);
  assert.match(app, /const monthEnd = toIsoDate\(new Date\(displayedYear, displayedMonth \+ 1, 0\)\)/u);
  assert.match(app, /const visibleStart = monthStart > today \? monthStart : today/u);
  assert.match(app, /monthEnd < today[\s\S]*?rangesOverlapOnWorkingDay\(visibleStart, monthEnd, holiday\.start, holiday\.end\)/u);
  assert.match(app, /\$\("peopleCardTitle"\)\.textContent = `\$\{monthName\} holidays`/u);
  assert.match(app, /const holidayDays = countHolidayWeekdays\(person\.holidays, monthStart, monthEnd\)/u);
  assert.match(app, /`\$\{holidayDays\} \$\{holidayDays === 1 \? "day" : "days"\}`/u);
  assert.match(app, /function changeMonth\(offset\)[\s\S]*?renderSummaries\(\);[\s\S]*?renderCalendar\(\);/u);
  assert.match(app, /\$\("todayButton"\)\.addEventListener[\s\S]*?renderSummaries\(\);[\s\S]*?renderCalendar\(\);/u);
});

test("holiday ownership, whole-day disclosure, and responsive crowded-day limits are wired into the UI", async () => {
  const [html, api, app, styles, design] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/api.js", import.meta.url), "utf8"),
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../assets/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../assets/design-v3.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="dayHolidaysDialog"/u);
  assert.match(html, /20260825-security-v1/u);
  assert.match(api, /adminCreatePerson:\s*\(body, adminToken\)/u);
  assert.match(app, /function canManageHoliday\(person\)/u);
  assert.match(app, /const editable = canManageHoliday\(person\)/u);
  assert.match(app, /openDayHolidays\(cell\.iso\)/u);
  assert.match(app, /day\.classList\.add\("has-holidays"\)/u);
  assert.match(app, /day\.addEventListener\("click", \(\) => openDayHolidays\(cell\.iso\)\)/u);
  assert.match(app, /day\.setAttribute\("aria-haspopup", "dialog"\)/u);
  assert.match(app, /event\.stopPropagation\(\);[\s\S]*?openHolidayEditor/u);
  assert.doesNotMatch(app, /holiday-overflow/u);
  assert.match(app, /day-more-label is-compact[^\n]*entries\.length - 2/u);
  assert.match(app, /day-more-label is-wide[^\n]*entries\.length - 3/u);
  assert.match(app, /sortPeopleForCurrent/u);
  assert.match(app, /name\.dataset\.fullName = member\.displayName/u);
  assert.match(styles, /\.holiday-chip\.is-current-user/u);
  assert.match(styles, /\.day-holiday-entry\.is-current-user/u);
  assert.match(styles, /\.you-badge/u);
  assert.match(design, /@media \(min-width: 761px\) and \(max-width: 1920px\) and \(max-height: 1200px\)[\s\S]*?\.holiday-chip:nth-child\(n \+ 3\)\s*\{\s*display:\s*none/u);
  assert.match(design, /@media \(min-width: 761px\) and \(max-width: 1920px\) and \(max-height: 1200px\)[\s\S]*?\.day-more-label\.is-wide\s*\{\s*display:\s*none;?\s*\}[\s\S]*?\.day-more-label\.is-compact\s*\{\s*display:\s*inline-flex/u);
  assert.match(design, /\.day-holiday-entry \.person-copy\s*\{[^}]*gap:\s*8px/u);
  assert.match(design, /\.calendar-day\.has-holidays:hover,[\s\S]*?box-shadow:/u);
  assert.match(design, /\.work-person-cell\[data-full-name\]::after\s*\{[\s\S]*?content:\s*attr\(data-full-name\)/u);
  assert.match(design, /\.work-person-cell\[data-full-name\]:hover::after\s*\{[\s\S]*?opacity:\s*1/u);
  assert.match(design, /\.hero-shortcuts\s*\{[\s\S]*?position:\s*absolute[\s\S]*?display:\s*block/u);
  assert.match(design, /\.hero-shortcuts \.quick-links\s*\{[^}]*repeat\(6, minmax\(0, 1fr\)\)/u);
});

test("Admin-managed shoutouts and monthly birthdays use encrypted homepage settings", async () => {
  const [html, app, model, design] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../assets/model.js", import.meta.url), "utf8"),
    readFile(new URL("../assets/design-v3.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="shoutoutsCardButton"[^>]*aria-controls="shoutoutsDialog"/u);
  assert.match(html, /id="birthdaysCardButton"[^>]*aria-controls="birthdaysDialog"/u);
  assert.match(html, /id="directShoutoutStart"[^>]*type="date"/u);
  assert.match(html, /id="directShoutoutEnd"[^>]*type="date"/u);
  assert.match(html, /id="directShoutoutPeople"/u);
  assert.match(html, /id="directBirthdays"/u);
  assert.doesNotMatch(html, /id="adminShoutoutPeople"|id="adminBirthdays"|id="momInput"/u);
  assert.match(app, /state\.config\.shoutouts/u);
  assert.match(app, /state\.config\.birthdays\.filter\(\(birthday\) => birthday\.date\.slice\(5, 7\) === currentMonth\)/u);
  assert.match(app, /function availableAccountNames\(\)[\s\S]*?state\.presence\.members/u);
  assert.match(app, /function makeAccountSelect\(value = "", label = "Person"\)/u);
  assert.match(app, /directAddShoutoutPerson[\s\S]*?appendDirectShoutoutRow/u);
  assert.match(app, /directAddBirthday[\s\S]*?appendDirectBirthdayRow/u);
  assert.match(app, /function saveConfigFeature\(field, value/u);
  assert.match(model, /for \(const field of \["groupName", "mom", "shoutouts", "birthdays", "links", "officeDays"\]\)/u);
  assert.match(design, /\.shoutouts-card\s*\{[\s\S]*?\.birthdays-card\s*\{/u);
  assert.match(design, /\.modal-card select\s*\{[^}]*background:\s*rgba\(255,255,255,\.075\)/u);
});

test("all protected records remain server-side and are excluded from the Pages artifact", async () => {
  const [build, api, runtime, html] = await Promise.all([
    readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8"),
    readFile(new URL("../assets/api.js", import.meta.url), "utf8"),
    readFile(new URL("../assets/runtime-config.js", import.meta.url), "utf8"),
    readFile(new URL("../index.html", import.meta.url), "utf8"),
  ]);
  assert.match(build, /\["index\.html", "robots\.txt", "assets"\]/u);
  assert.doesNotMatch(build, /path\.join\(root, "data"/u);
  assert.doesNotMatch(`${build}\n${api}\n${runtime}\n${html}`, /raw\.githubusercontent\.com|DATA_BASE_URL|dataBaseUrl/u);
  assert.match(api, /bootstrapConfig:\s*\(siteToken\)[\s\S]*?siteToken/u);
  assert.doesNotMatch(api, /fetchDataJson/u);
});
