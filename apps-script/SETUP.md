# Apps Script setup — one-time

This folder holds the web app that mediates between `practice-form.html` and
the practice spreadsheets + GitHub. Deploy it with [clasp](https://github.com/google/clasp).

## First-time deploy

```bash
# 1. Install clasp if you don't have it.
npm install -g @google/clasp

# 2. Log in as the Google account that owns the `dashboard raw data` folder.
clasp login

# 3. From the repo root, create the script project targeted at this folder.
#    This writes .clasp.json (gitignored) with the scriptId.
clasp create --type webapp --title "PerformDDS Pipeline" --rootDir ./apps-script

# 4. Push the code.
clasp push

# 5. Open the script editor.
clasp open
```

In the editor:

1. **Project Settings → Script Properties → Add script property** — add three:
   - `SHARED_SECRET` — paste the 32-char random hex string (see below).
   - `GITHUB_PAT` — fine-grained PAT with `Contents: write` on
     `Evenflow1212/performdds-assessment` only.
     [Create one here](https://github.com/settings/personal-access-tokens/new).
   - `GITHUB_REPO` — `Evenflow1212/performdds-assessment`

2. **Deploy → New deployment → Web app**
   - Execute as: **Me (dashboard@performdds.com or your owning account)**
   - Who has access: **Anyone**
   - Click Deploy, authorize the scopes it asks for.
   - Copy the web app URL.

3. Paste the web app URL into `practice-form.html` at the `APPS_SCRIPT_URL`
   placeholder near the top of the `<script>` block, and commit that one line.

## Generate SHARED_SECRET

Run this locally, paste the output into Script Properties, **do not commit it**:

```bash
openssl rand -hex 32
```

## Redeploying code

**Always update the existing deployment. Never create a new one** — the URL
changes if you do, and the form breaks until you update it.

```bash
clasp push
# In the editor: Deploy → Manage deployments → ✏️ edit the existing web app
# deployment → "New version" → Deploy.
```

Or from CLI:

```bash
clasp deploy --deploymentId <the-id-from-clasp-deployments>
```

## Files in this folder

- `Code.gs` — the handler, upsert, pivot, dispatch.
- `appsscript.json` — runtime manifest.
- `SETUP.md` — this file.

## Script Properties checklist

| Key | Purpose | Value |
|---|---|---|
| `SHARED_SECRET` | Write-side bot filter (client-side visible; speed bump, not auth) | 32-char hex |
| `GITHUB_PAT` | Triggers `repository_dispatch` on the repo | fine-grained PAT |
| `GITHUB_REPO` | Target repo path | `Evenflow1212/performdds-assessment` |

## Adding a practice

Edit `Code.gs`:

```javascript
const PRACTICE_SHEET_IDS = {
  murray:   '...',
  abas:     '...',
  pigneri:  '...',
  vanek:    'NEW_SHEET_ID_HERE',    // add here once Copy-of template exists
  bilbeisi: 'NEW_SHEET_ID_HERE',
};
```

Then `clasp push` and redeploy via the existing deployment (not new). Until a
practice is listed here, the web app returns a 200 JSON `{ ok: false, error:
"Practice '<name>' has no sheet configured yet..." }` rather than crashing.

## If pivot emits the wrong shape

Most likely the sheet's dimension labels for Doctor/Hygiene don't end in
` production` / ` days`. Open `Code.gs`, find `RAW_PIVOT_RULES`, and adjust
the `metrics` array for those categories. Or for a tab whose shape doesn't
match any existing mode, add a new `mode` branch in `pivotRows_`.
