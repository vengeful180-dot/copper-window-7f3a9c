# Team Time Away

A small-team holiday planner whose public GitHub repository contains only anonymous identifiers, password verifiers protected by a Worker-only pepper, and AES-256-GCM ciphertext. The frontend is a static GitHub Pages site. A narrow Cloudflare Worker authenticates personal accounts and commits only permitted encrypted files back to GitHub.

The repository starts with **zero people**. The first holiday entered for a normalized name creates a UUID person record automatically; later capitalization or whitespace variations reuse that record.

## Architecture

```text
Browser on GitHub Pages
  ├─ creates or logs into a personal name + password account
  ├─ unwraps the shared AES-256 team key locally
  ├─ downloads and decrypts the anonymous holiday files
  └─ sends fresh ciphertext with a short-lived account session for writes

Cloudflare Worker
  ├─ maps normalized names to opaque HMAC identifiers
  ├─ verifies peppered password proofs and signs 8-hour sessions
  ├─ enforces exact-origin CORS, request limits, and authentication
  ├─ validates encrypted envelopes without decrypting them
  ├─ retries anonymous-index SHA conflicts with a UUID-set merge
  └─ commits only data/index.json, data/config.enc.json, and UUID person files

GitHub
  ├─ stores source and encrypted data
  ├─ keeps history as the backup log
  └─ deploys the static site through GitHub Actions / Pages
```

There is no SQL service or traditional database. Account records are files under `data/accounts/`; their filenames are opaque keyed hashes. Their names/team keys are encrypted with each person's password, and that entire envelope receives a second Worker-only AES-GCM layer before GitHub stores it. The Worker never receives decrypted employee names, dates, MOM, or announcements. A normalized name is visible to the Worker only during account lookup, registration, and login, and is never written to GitHub.

## Protected file format

`data/index.json` contains one key, `people`, whose values are random UUIDs. Each `data/people/<uuid>.enc.json` file and `data/config.enc.json` is an envelope containing:

- PBKDF2-SHA-256 metadata with a public 16-byte random salt and 310,000 iterations;
- AES-256-GCM ciphertext;
- a fresh random 96-bit GCM nonce for every save;
- an authenticated context string identifying this application and format version.

The original shared site password becomes the **team invite password**. It is needed only when creating an account and is never stored. Account creation wraps the existing team AES key in a separate AES-256-GCM envelope derived from the person's password. Login unwraps that key locally, so different personal passwords open the same encrypted calendar.

PBKDF2 derives 512 bits for each personal password: one 256-bit half encrypts the account envelope and the other becomes a high-entropy login proof. Before the proof is written to GitHub, the Worker peppers it with private HMAC key material. The Worker also encrypts the account envelope with a separate private storage key. Public account files therefore contain neither a usable verifier nor password-testable ciphertext. The separate Admin password is checked against an HMAC-SHA-256 verifier and exchanged for a signed 15-minute Admin session.

Decrypted calendar records remain in JavaScript memory only. The current tab may retain the signed session and derived team key in `sessionStorage` so a refresh does not log the person out; closing the tab or choosing **Log out** discards it. The app never uses persistent `localStorage` and never stores either password.

## Local development

Requirements: Node.js 22 or later.

```powershell
npm ci
npm run dev
```

The site opens at `http://127.0.0.1:5173`. In a second terminal, run the Worker at `http://127.0.0.1:8787`:

```powershell
npm run dev:worker
```

The generated, git-ignored `.dev.vars` already contains the password verifiers. Replace its GitHub placeholders with a fine-grained development token, owner, and repository before exercising real writes. Use the initial credentials stored in the git-ignored `.initial-credentials.txt`.

Run the complete local gate with:

```powershell
npm run check
```

## First deployment

1. Create a public repository with a non-obvious name and push `main`. A public repository is normally needed for no-cost GitHub Pages; encryption, not obscurity, protects the data.
2. In repository **Settings → Pages**, choose **GitHub Actions** as the source. The `Deploy GitHub Pages` workflow builds and deploys `dist/`.
3. Create a fine-grained GitHub token restricted to this one repository with only **Contents: Read and write** and **Metadata: Read**. Store it as the repository secret `PLANNER_DATA_TOKEN`; never place it in a file or frontend variable. The deployment maps it to the Worker's internal `GITHUB_DATA_TOKEN` binding.
4. Create a Cloudflare API token limited to the target account with **Workers Scripts: Edit**. Store `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub repository secrets.
5. Copy the generated verifier values from `.dev.vars` into GitHub secrets: `SITE_AUTH_TOKEN_HASH`, `ADMIN_PASSWORD_HASH`, `ADMIN_PASSWORD_SALT`, `ADMIN_SESSION_SECRET`, `ACCOUNT_LOOKUP_SECRET`, `ACCOUNT_SESSION_SECRET`, and `ACCOUNT_STORAGE_SECRET`.
6. Add repository variable `PAGES_ORIGIN` as the origin only, such as `https://owner.github.io` (no repository path). Run **Deploy secure write gateway** once.
7. The Worker workflow verifies `/health`, passes the resulting `https://…workers.dev` URL directly to a fresh Pages deployment, and connects the frontend automatically. Also store that stable URL as the repository variable `WORKER_API_URL` so later `main` pushes retain the connection. The frontend build points protected reads at the raw `main/data/` path for the current repository.

The Worker workflow uploads secrets after the initial script deployment; until that finishes, write routes fail closed. The frontend displays a clear read-only message when `WORKER_API_URL` is unset or unavailable.

For a custom Worker domain, also add that exact origin to the `connect-src` policy in `index.html`.

## Required Worker configuration

| Name | Purpose | Secret |
| --- | --- | --- |
| `SITE_AUTH_TOKEN_HASH` | Verifies ordinary encrypted writes | Yes |
| `ADMIN_PASSWORD_HASH` | Verifies the Admin password | Yes |
| `ADMIN_PASSWORD_SALT` | Private key material for the Admin verifier | Yes |
| `ADMIN_SESSION_SECRET` | Signs short-lived Admin sessions | Yes |
| `ACCOUNT_LOOKUP_SECRET` | Hides normalized account names and peppers password proofs | Yes |
| `ACCOUNT_SESSION_SECRET` | Signs short-lived personal account sessions | Yes |
| `ACCOUNT_STORAGE_SECRET` | Adds Worker-only encryption around account envelopes | Yes |
| `GITHUB_DATA_TOKEN` | Commits permitted files | Yes |
| `GITHUB_OWNER` | Repository owner | Treat as runtime configuration |
| `GITHUB_REPO` | Repository name | Treat as runtime configuration |
| `GITHUB_BRANCH` | Data branch; defaults to `main` | No |
| `ALLOWED_ORIGIN` | Exact GitHub Pages origin | No |
| `DEV_ORIGIN` | Optional local origin | No |

Do not grant the data token access to other repositories, workflows, issues, pull requests, administration, or secrets.

## Password changes

### Team invite password

Use a short maintenance window because the ciphertext and Worker verifier must move together. Start from a clean, current checkout and set the old and new passwords only in the current process environment:

```powershell
$env:OLD_SITE_PASSWORD='old value'
$env:NEW_SITE_PASSWORD='new value of at least 20 characters'
npm run data:rotate-password
Remove-Item Env:OLD_SITE_PASSWORD, Env:NEW_SITE_PASSWORD
```

This decrypts locally, creates a new random KDF salt, and re-encrypts every protected holiday file with fresh nonces. It writes the new `SITE_AUTH_TOKEN_HASH` to the git-ignored `.rotation-secrets.txt`. Existing personal account envelopes wrap the old team key, so rotate or recreate the accounts during the same maintenance window before switching the encrypted data. Never commit either password or the rotation file.

### Personal account passwords

Personal passwords are intentionally unrecoverable: the service never stores them. If a person forgets one, an Admin should remove that opaque account file and the person can create the account again with the team invite password. Their holiday record is separate and remains intact. A self-service password-change flow is not included in this small deployment.

### Admin password

```powershell
$env:NEW_ADMIN_PASSWORD='new value of at least 20 characters'
npm run secrets:admin-password
Remove-Item Env:NEW_ADMIN_PASSWORD
```

Update the Worker `ADMIN_PASSWORD_HASH` and `ADMIN_PASSWORD_SALT` from the git-ignored `.rotation-secrets.txt`. Changing the Admin password does not re-encrypt holiday data.

## Backup and restore

Git history is the primary audit and backup trail. Periodically clone or mirror the repository somewhere access-controlled. To restore a mistaken edit, restore the affected encrypted file and, if needed, `data/index.json` from a known-good commit, then push a normal corrective commit. A restored file still requires the site password used when that snapshot was encrypted.

Never restore `data/index.json` without checking that its UUIDs match the intended person files. Missing index entries make encrypted records undiscoverable; references to missing files produce a load error rather than exposing or fabricating data.

## Recovering a damaged anonymous index

From a clean checkout containing the intended encrypted person files:

```powershell
npm run data:rebuild-index
npm run test:security
```

The recovery script scans only UUID-shaped `*.enc.json` filenames and recreates `{ "people": [...] }`; it never decrypts or extracts a name. Review the resulting diff and commit it. Orphaned encrypted files are reintroduced; remove any known-unwanted ciphertext file before rebuilding.

## Conflict behavior

Every encrypted update includes a digest of the version the browser decrypted. The Worker fetches the current GitHub blob and SHA, rejects stale versions with HTTP 409, and returns the latest ciphertext. The browser decrypts that version locally, replays a safe holiday addition, and retries with fresh ciphertext. An edit or delete aborts when the same holiday changed concurrently, avoiding silent overwrites. Anonymous UUID additions are merged server-side and retried against the newest index SHA.

## Security notes

- The Pages URL is intentionally unlisted with `noindex,nofollow,noarchive` and a deny-all `robots.txt`; this does **not** make the URL private.
- The HTML shell contains no protected values. Wrong account names and passwords return the same generic error.
- Account names are normalized case-insensitively, transformed into Worker-keyed opaque filenames, and encrypted inside the account envelope.
- Account lookup and login attempts are rate limited; personal sessions expire after eight hours and Admin sessions after 15 minutes.
- The Worker requires HTTPS in production, exact-origin CORS, bounded JSON bodies, strict UUID paths, known encrypted-envelope fields, and short-lived Admin sessions.
- Admin password attempts are limited to five per 15-minute window per observed IP in each Worker isolate. Cloudflare account-level rate limiting/WAF can add a globally coordinated layer without changing application data storage.
- The application creates DOM nodes with `textContent`; it does not inject user-controlled HTML.
- The included security check scans for credential patterns, unsafe DOM insertion, persistent local browser storage, plaintext protected data, and unexpected person/account envelope shapes.

## Data layout

```text
index.html
assets/
data/
  index.json
  config.enc.json
  people/
    <uuid>.enc.json
  accounts/
    <opaque-hmac>.json
worker/
  src/
  wrangler.toml
.github/workflows/
  pages.yml
  worker.yml
```
