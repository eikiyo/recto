# Runbook — Google Search Console OAuth setup
**Owner:** Eikiyo (manual, one-time)
**Estimated time:** 15 minutes
**Prerequisites:** Google account with billing enabled (free tier is fine)
**Output:** `GSC_CLIENT_ID` and `GSC_CLIENT_SECRET` set as Worker secrets on `recto-api`.

This is the one piece of D2 that cannot be automated — Google requires a human to click through the consent screen flow. The runbook is sequenced so you can do it once and never think about it again.

---

## 1. Create or pick a Google Cloud project

1. https://console.cloud.google.com/projectcreate
2. Project name: **recto-prod**.
3. Organization: leave as `No organization` if you do not have one.
4. Click **Create**, then switch to the new project from the top bar.

## 2. Enable the Search Console API

1. https://console.cloud.google.com/apis/library/searchconsole.googleapis.com
2. Click **Enable**.

That is the only API recto uses. **Do not** enable Search Indexing, Webmaster, or anything else — recto is read-only and will fail explicit-scope checks if granted more.

## 3. Configure the OAuth consent screen

1. https://console.cloud.google.com/apis/credentials/consent
2. User Type: **External**.
3. App name: `recto`.
4. User support email: your support address (the same `notes@recto.so` we use elsewhere is fine if you point it at yourself for now).
5. App logo: skip for v1.
6. App domain → Application home page: `https://recto.so`.
7. Authorized domains: add `recto.so`.
8. Developer contact: your email.
9. **Scopes**: click **Add or Remove Scopes** and add only:
   - `https://www.googleapis.com/auth/webmasters.readonly`
10. Save and continue.
11. Test users: add your own Google account and 2-3 friendly testers.
12. Save.

The app stays in **Testing** mode until you submit for verification. In Testing mode each Google account that authorizes recto must be on the Test Users list. **You do not need verification for the AppSumo launch** — Google requires verification only when more than ~100 accounts have authorized. By cohort 2 you will need to submit; budget a week for Google review.

## 4. Create the OAuth client

1. https://console.cloud.google.com/apis/credentials
2. **Create credentials** → **OAuth client ID**.
3. Application type: **Web application**.
4. Name: `recto-api (prod)`.
5. Authorized redirect URIs:
   - `https://recto.so/api/oauth/gsc/callback` (production)
   - `http://localhost:8787/api/oauth/gsc/callback` (local dev with `wrangler dev`)
   - `http://localhost:8765/api/oauth/gsc/callback` (local dev via Pages preview)
6. Click **Create**.
7. **Copy the Client ID and Client Secret immediately** — the secret is shown only once.

## 5. Set the Worker secrets

```bash
cd Knowledge/recto/apps/workers/api
wrangler secret put GSC_CLIENT_ID
# paste the client ID
wrangler secret put GSC_CLIENT_SECRET
# paste the client secret
```

For local dev, the values are already in `.dev.vars` as placeholders — replace them with the real ones if you want to test the live OAuth flow on `wrangler dev`.

## 6. Verify

```bash
# Boot the Worker
wrangler dev

# Get a session cookie (see runbook auth-local-dev.md for the magic flow)
# Then:
curl -i -H "Cookie: recto_session=…" \
  "http://localhost:8787/api/gsc/connect?siteId=01TESTSITE"
# Expect: 302 redirect to https://accounts.google.com/o/oauth2/v2/auth?...
```

If the redirect lands at Google's consent screen and asks for **read access to Search Console data**, the setup is correct.

## 7. When to revisit

- Before submitting to Google verification (around cohort 2): https://support.google.com/cloud/answer/9110914
- When rotating `GSC_CLIENT_SECRET` (yearly): repeat step 4 with a new client, swap the secret, delete the old client after 14 days.
- If a user's authorization breaks with `invalid_grant`: their refresh token was revoked at `myaccount.google.com`. recto surfaces this as `gsc_reauth_required` and walks them through `/api/gsc/connect` again.
