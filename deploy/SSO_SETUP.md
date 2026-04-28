# SSO setup (Enterprise)

urateam supports SSO via WorkOS AuthKit. This routes dashboard authentication
through your existing IdP (Okta, Azure AD, Google Workspace, OneLogin, ...).

## Prerequisites
- An Enterprise license
- A WorkOS account (https://workos.com)

## Steps

### 1. Create a WorkOS project
- Sign up / log in at https://dashboard.workos.com
- Create an environment (one per urateam deployment is fine)
- Note the API key (sk_live_... or sk_test_...) and Client ID (client_...)

### 2. Configure your IdP in WorkOS
- In the WorkOS dashboard, go to Authentication → AuthKit
- Add a Connection for your IdP
- Follow the WorkOS guide for your specific provider — they handle the SAML
  metadata exchange or OIDC discovery for you

### 3. Set environment variables
On the urateam host:
```
URATEAM_WORKOS_API_KEY=sk_live_...
URATEAM_SSO_STATE_SECRET=$(openssl rand -hex 32)
```

`URATEAM_SSO_STATE_SECRET` is used to sign the OAuth state parameter to prevent
CSRF. Generate a fresh 32-byte random string and keep it secret.

### 4. Update urateam config
Add the `sso` block to your urateam config (e.g. `config.yaml`):
```yaml
sso:
  enabled: true
  workosApiKey: ${URATEAM_WORKOS_API_KEY}
  workosClientId: client_xxxxxxxxxxxxxxxx
  redirectUri: https://urateam.acme.com/auth/callback
  allowedDomain: acme.com
  sessionDurationHours: 24
  stateSigningSecret: ${URATEAM_SSO_STATE_SECRET}
```

`allowedDomain` (optional) restricts which email addresses can complete login.
Omit to allow any email your IdP authenticates.

### 5. Add the redirect URI to WorkOS
- Back in the WorkOS dashboard, add `https://urateam.acme.com/auth/callback`
  as an allowed redirect URI for the connection.

> **When using DASHBOARD_BASE_PATH**
>
> If you serve the dashboard under a path prefix (e.g. `DASHBOARD_BASE_PATH=/ateam`),
> the SSO routes mount under that prefix too. Both `redirectUri` in your config
> AND the WorkOS-side allowed redirect URI must include the prefix:
> `https://urateam.acme.com/ateam/auth/callback`.
> Without this, post-login redirects 404 and you'll see a "page not found"
> instead of landing on the dashboard.

### 6. Restart urateam
- The dashboard should now redirect anonymous visitors to `/auth/login`,
  which forwards them through WorkOS to your IdP.

### Verification
- Hit `https://urateam.acme.com/runs` in a browser — you should be redirected
  through your IdP and back, and land on the dashboard with a session cookie.
- Check the audit log at `/audit` (if licensed) — you should see a
  `dashboard.login` event for the user who just logged in.

## Troubleshooting
- **400 Invalid login state:** the cookie or signing secret was rotated mid-flow.
  Try again from `/auth/login`.
- **403 Access denied for <email>:** the email's domain doesn't match
  `allowedDomain`. Either remove the restriction or use a different account.
- **503 SSO provider error:** WorkOS API is unreachable or returned an error.
  Check WorkOS status page and your API key.
- **Loop between /auth/login and the dashboard:** likely a cookie attribute
  problem (e.g. Secure=true on a non-HTTPS deployment). Set
  `sso.cookieSecure: false` in development only.

## Notes
- SSO replaces Basic Auth entirely when enabled. Make sure SSO is working
  before disabling your `DASHBOARD_USER`/`DASHBOARD_PASSWORD` fallback.
- Sessions are stored in the urateam database. Logging out invalidates the
  server-side session, not the WorkOS / IdP session — re-clicking login may
  silently reauthenticate via your IdP.
