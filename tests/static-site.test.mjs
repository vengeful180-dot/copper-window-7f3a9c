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
  assert.match(app, /MIN_ACCOUNT_PASSWORD_LENGTH\s*=\s*8/u);
  assert.match(app, /Your password was accepted, but this page was out of date/u);
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

test("homepage uses optimized architectural artwork over a resolution-independent CSS backdrop", async () => {
  const [html, styles] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /assets\/images\/dream-team-architecture\.webp/u);
  assert.match(html, /alt="Modern emerald-glass office buildings surrounded by landscaped trees"/u);
  assert.doesNotMatch(styles, /url\("images\/portal-green-background\.webp"\)/u);
  assert.match(styles, /\.app-shell\s*\{[^}]*repeating-radial-gradient[^}]*background-attachment:\s*fixed/u);
  assert.match(styles, /\.portal-hero-backdrop\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0[^}]*object-fit:\s*cover/u);
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
  assert.match(styles, /\.work-page \.page-heading\s*\{[^}]*linear-gradient/u);
  assert.match(styles, /@media \(min-width: 1181px\) and \(max-height: 1100px\)/u);
});

test("calendar and work schedule use dark integrated surfaces instead of white sheets and pills", async () => {
  const [html, styles] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /20260812-emerald-ui-v7/u);
  assert.match(styles, /\.calendar-card\s*\{[^}]*linear-gradient[^}]*color:\s*#f7fcf8/u);
  assert.match(styles, /\.calendar-day\s*\{[^}]*background:\s*rgba\(255,255,255,\.052\)/u);
  assert.match(styles, /\.work-legend span::before\s*\{/u);
  assert.match(styles, /\.work-status::before\s*\{/u);
  assert.match(styles, /\.work-status\.is-home\s*\{\s*color:/u);
  assert.doesNotMatch(styles, /\.work-status\.is-home\s*\{[^}]*linear-gradient/u);
});

test("dialogs use dark emerald surfaces and controls instead of white cards", async () => {
  const [html, styles] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /20260812-emerald-ui-v7/u);
  assert.match(styles, /\.modal-card\s*\{[^}]*linear-gradient[^}]*color:\s*#f7fcf8/u);
  assert.match(styles, /\.modal-card input, \.modal-card textarea\s*\{[^}]*background:\s*rgba\(255,255,255,\.075\)/u);
  assert.match(styles, /\.date-picker-trigger\s*\{[^}]*background:\s*rgba\(255,255,255,\.075\)/u);
  assert.match(styles, /\.date-picker-heading \.icon-button\s*\{[^}]*background:\s*rgba\(255,255,255,\.065\)/u);
  assert.match(styles, /\.modal-card \.button-primary\s*\{[^}]*linear-gradient/u);
  assert.match(styles, /\.admin-person\s*\{[^}]*background:\s*rgba\(255,255,255,\.055\)/u);
  assert.match(styles, /html:has\(dialog\[open\]\)\s*\{\s*overflow:\s*hidden/u);
});

test("account records remain server-side and are excluded from the Pages artifact", async () => {
  const build = await readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8");
  assert.match(build, /\["index\.html", "robots\.txt", "assets"\]/u);
  assert.match(build, /"presence\.enc\.json"/u);
  assert.doesNotMatch(build, /data[\\/]accounts/u);
  assert.doesNotMatch(build, /path\.join\(root, "data"\)(?!,)/u);
});
