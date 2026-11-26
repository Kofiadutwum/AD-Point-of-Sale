# Phase 2-6 hand-over: platform support sessions

Spec 4.29, 6.47.

## What was built

- **Schema** (migrations 0042, 0043): `support_sessions` (tenant, granted_by owner or admin_id for emergency, reason, emergency flag, starts/expires, revoked_at). RLS.
- `src/server/support.ts`: `grantSupportAccess` (owner, `manage_shop_settings`, 1–72 hours, reason), `revokeSupportAccess`, `supportHistory` (sessions plus every support action from the shop's audit log), `currentSupportSession`, `openEmergencyAccess` (platform admin, reason of 20+ characters, 2 hours, owner emailed at once, audited), `supportView` (needs an active session; read-only counts and the latest 20 sales; writes `platform_support_view` with the admin's name to the shop's audit log; no hashes or card data).
- **Screens**: owner settings "Platform support access" (grant, end now, what support did); admin shop page "Support access" (link to the view, or emergency form); `/admin/shops/[id]/support` (the logged view).

## Tests

`tests/server/support.test.ts` (2).

## Not done / notes

- The support view is an overview, not the full shop app; deeper read-only pages can be added on the same session check.
- The admin layout has a pre-existing lint error (`<a>` instead of `<Link>`), not touched here.
