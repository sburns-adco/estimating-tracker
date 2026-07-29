# ADCO Estimate Tracker — Azure Deployment

Multi-user electrical estimating tracker. Frontend is a single `index.html`; data is stored
as one JSON blob per project in Azure Blob Storage, accessed through the included Azure
Functions API (never directly from the browser).

```
adco-tracker-azure/
├── index.html                    # the app
├── staticwebapp.config.json      # Static Web Apps config (routing, Node 20 API)
└── api/                          # Azure Functions API (managed by Static Web Apps)
    ├── host.json
    ├── package.json
    └── src/functions/projects.js # GET/PUT/DELETE /api/projects[/{id}]
```

## Deploy (Azure Static Web Apps — free tier works)

### 1. Storage account
Use an existing storage account or create one (Portal → Storage accounts → Create,
Standard / LRS is fine). No container needed — the API creates a private container
named `estimates` on first use.

Copy a **connection string**: Storage account → *Security + networking* →
*Access keys* → Connection string.

### 2. Create the Static Web App
Portal → *Static Web Apps* → Create → Plan: **Free**.

Deployment options (pick one):

**A. GitHub (recommended — redeploys automatically on every commit)**
Push this folder to a repo, select it during creation, and set:
- App location: `/`
- Api location: `api`
- Output location: *(leave empty)*

**B. SWA CLI (no repo needed)**
Create the Static Web App with source "Other", then from this folder:
```bash
npm install -g @azure/static-web-apps-cli
cd api && npm install && cd ..
swa deploy . --api-location api --deployment-token <token>
```
Get the token from the Static Web App → *Overview* → *Manage deployment token*.

### 3. Configure the connection string
Static Web App → *Settings* → *Environment variables* (a.k.a. Configuration) → Add:

| Name | Value |
|---|---|
| `STORAGE_CONNECTION_STRING` | the connection string from step 1 |
| `ESTIMATES_CONTAINER` | *(optional)* container name, default `estimates` |

### 4. Open the URL
The Overview page shows the site URL (e.g. `https://happy-rock-123.azurestaticapps.net`).
Share it with the team. If the app shows "Could not load from the server", the
connection string setting is missing or wrong.

## How saving works
- Edits push to the API ~0.7 s after you stop typing ("Saved" shows in the header).
- Each save uses the blob's ETag: if a teammate saved the same project first, you get a
  banner, their version loads, and you re-enter your last change (no silent overwrites).
- **↻ Refresh** pulls teammates' latest saves; data also reloads on page load.

## Adding company sign-in later (Entra ID)
Static Web Apps has built-in Entra ID auth. To require login, add to
`staticwebapp.config.json`:
```json
"routes": [
  { "route": "/*", "allowedRoles": ["authenticated"] }
],
"responseOverrides": {
  "401": { "redirect": "/.auth/login/aad", "statusCode": 302 }
}
```
On the Free tier this allows any Microsoft account by invitation; restricting to your
tenant only ("custom authentication") requires the Standard tier (~$9/mo).

## Costs
Free tier Static Web App + a few KB of blob storage: effectively $0/month.
