# RBAC setup (Enterprise)

urateam supports three dashboard roles:
- **admin** — full access, including /config and /users
- **operator** — full read access, can retry failed runs
- **viewer** — read-only access to /runs, /tokens, /errors

RBAC is gated by the `rbac` feature flag and requires the SSO feature (4.1).

## Prerequisites
- Enterprise license with `rbac` feature enabled
- SSO configured (see `deploy/SSO_SETUP.md`)

## Bootstrapping the first admin

Set `URATEAM_ADMIN_EMAILS` (comma-separated, case-insensitive) before starting urateam:
```
URATEAM_ADMIN_EMAILS=alice@acme.com,bob@acme.com
```

When alice or bob logs in via SSO, their role is automatically promoted to `admin`. All other users default to `viewer`.

The env var can be safely removed after initial setup — existing admins keep their role.

## Managing roles

### Via dashboard
Admins see a "Users" nav entry. Go to `/users` to list users and change roles via the dropdown.

### Via CLI
On the host:
```
ura admin list
ura admin grant <email> --role operator
ura admin revoke <email>
```

`revoke` sets the role to `viewer` — the minimum privilege, not deletion.

## Emergency recovery

If the dashboard UI is broken or the last admin is locked out, use the CLI:
```
ura admin grant recovery@acme.com --role admin
```

## Guardrails

- Admins cannot demote themselves (self-lockout protection)
- The last remaining admin cannot be demoted (last-admin protection)
- Every role change writes a `dashboard.manual_action` audit event

## Troubleshooting

- **"RBAC is an Enterprise feature"** → your license does not include the `rbac` flag. Upgrade or contact sales.
- **Admin promotion didn't happen on first login** → check `URATEAM_ADMIN_EMAILS` is set and the email matches exactly (case-insensitive). Check logs for audit events.
- **"403 Forbidden" on a route you should have access to** → check your assigned role via `ura admin list`. If the role is wrong, an admin needs to update it.
