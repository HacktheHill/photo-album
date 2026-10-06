# Photo gallery Worker

This directory contains the Cloudflare Worker for the standalone gallery at `https://photos.hackthehill.com`. The root Astro build is attached as Worker Static Assets in the same deployment. The Worker owns the single internal `/api/*` prefix for authentication, media, downloads, and restore actions, while the `/` album and `/restore?case=<caseId>&version=<n>` confirmation route are served from the built Astro assets.

The Worker owns attendee OTP authentication, private R2 media delivery, licence acknowledgements, aggregate activity, removal cases, moderation audit, restricted rights follow-up, scheduled retention cleanup, and the notification outbox. It never exposes R2 object keys, a public bucket URL, the eligibility roster, or source editing metadata.

The standalone service has two user-facing routes: `/` and `/restore?case=<caseId>&version=<n>`.

## Package and local checks

The service package uses Wrangler, Vitest’s Cloudflare Workers pool, TypeScript, `jose`, and `aws4fetch`. From this directory:

```sh
npm ci
npm run types
npm run typecheck
npm test
npm run deploy:dry-run
```

The root package runs the local Worker through `npm run worker:dev`, checks it with `npm run worker:check`, and combines it with the Astro build through the root verification scripts. Local D1 migrations and synthetic fixtures may be used for tests. Do not point local tools at production bindings or real eligibility data.

The service test suite covers Access assertion validation, generic authentication responses, private media, licence gating, OTP expiry and lockout, atomic removal quotas, retention cleanup, download request binding, protected restore reads, and compare-and-set restore actions. Tests use synthetic data and do not send attendee email.

## Bindings and deployment

The default Wrangler configuration is the staging target:

| Binding       | Staging value                                                                  |
| ------------- | ------------------------------------------------------------------------------ |
| Worker        | `hack-the-hill-photo-gallery-staging`                                          |
| D1            | `hack-the-hill-photo-gallery-staging` (`f61bc64c-e938-4711-9b65-482d7682ffe5`) |
| R2            | `hack-the-hill-photo-gallery-staging`                                          |
| Static Assets | root `../../build`                                                             |

The production target is the standalone custom domain:

| Binding       | Production value/status                                                               |
| ------------- | ------------------------------------------------------------------------------------- |
| Worker        | `hack-the-hill-photo-gallery`                                                         |
| Custom domain | `photos.hackthehill.com`                                                              |
| D1            | ID `1b13a732-a526-4a53-b691-d74625919c8f`; binding/configuration pending owner review |
| R2            | `hack-the-hill-photo-gallery`; created, upload and verification pending               |
| Static Assets | root `../../build`                                                                    |

The Worker runs first for `/api/*`. The root build and Worker are therefore released together as one host deployment. This project does not use Cloudflare Pages for the gallery and does not alter the main website.

Do not deploy production with empty D1/R2 identifiers, staging bindings, an empty Access audience, an unreviewed eligibility source, or unprotected `/restore` and `/api/restore` routes. Production resource creation alone is not a release.

## Configuration and secrets

Required secrets are:

- `OTP_HMAC_SECRET` — keyed eligibility and challenge derivation.
- `SESSION_HMAC_SECRET` — session and CSRF derivation.
- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` — least-privilege SES access.

The two HMAC secrets must be at least 32 characters. Non-secret variables include `CURRENT_LICENCE_VERSION`, `SES_REGION`, `SES_FROM_EMAIL`, `MODERATOR_EMAILS`, `APP_ORIGIN`, `ACCESS_TEAM`, and `ACCESS_AUD`.

Production should use `APP_ORIGIN=https://photos.hackthehill.com`. The intended sender is `info@hackthehill.com`, and removal notifications are intended for `privacy@ctn-rtc.org`; SES configuration and the real delivery pilot are still pending. When SES is incomplete, the Worker leaves the notification outbox pending and retries later. Provider acceptance does not prove inbox delivery or readership.

Access-protected restore requests require a cryptographically verified JWT from the dedicated production application. Access protects `/restore` and its descendants together with `/api/restore` and its descendants. The Worker checks the signed issuer, audience, expiry, subject, and `@ctn-rtc.org` domain. Google Workspace-only identity selection is configured in Access rather than inferred from an unstable JWT provider claim; the restore application has its own one-hour session and preserves the aggregate metrics audience separately. Attendee OTP sessions do not grant restore access.

Never commit secrets, eligibility exports, private inventories, R2 credentials, OTPs, requester explanations, JWTs, or generated private reports. The Worker logs only bounded diagnostic types and never logs those values.

## Data and moderation invariants

The approved staging collection contains 358 edited photographs in 18 categories and 1,432 verified objects. The production R2 bucket must receive the reviewed manifest and complete object verification before publication.

`photos.version` is the moderation publication version, independent of the content/hash version used in R2 object paths. A photo is publishable only when its required variants exist and its status is `published`. The Worker checks publication state immediately before every attendee media and download response.

Migrations `0003_moderation_operation_tokens.sql`, `0004_case_retention.sql`, and `0005_aggregate_download_formats.sql` add compare-and-set mutation markers, case-retention timestamps, and durable full/quick aggregate counters. Apply reviewed migrations before deploying code that expects those columns.

Removal requests are limited atomically to 30 per account per hour and 5 per account for the same photo per hour. Idempotent retries return the existing case before quota evaluation. A removal report quarantines a photo and queues a notification; only an audited organiser action can resolve it, and restoration requires no pending reports.

The restore flow is case-scoped: the notification button opens `/restore?case=<caseId>&version=<n>` behind Access, and the shared gallery component shows only the filename and an explicit Restore button. It calls `GET /api/restore/<caseId>` for read-only state and `POST /api/restore/<caseId>` with `{ "expectedVersion": n }` for the explicit compare-and-set restore. The GET returns the filename, `canRestore`, current photo version, status, and CSRF token. It rejects stale links and other pending cases, then atomically dismisses all pending requests in the case and publishes the photo with the fixed audit reason and verified Access identity. GET never mutates. Individual download-request records are retained for 90 days for manual, owner-only rights follow-up in the database. There is no web rights lookup, bulk export, queue, or organiser dashboard.

The scheduled cleanup retains pending cases, removes individual download records after 90 days, and removes resolved case/report history and moderation audit after one year. It also retries the outbox. Aggregate totals remain available after individual rights records expire.

## Backup and restore

Before production publication, create a private backup package containing the D1 export, reviewed photo manifest, complete R2 inventory/hash verification, current licence, and moderation-state summary. Restore it into an isolated non-production target and verify photo status, publication versions, quarantined and withdrawn rows, pending cases, resolved cases, and audit records.

The restore drill must preserve moderation state. Do not reseed production from a fresh manifest in a way that republishes quarantined or withdrawn photos, resets `photos.version`, replaces controlled object keys, or discards pending cases. A successful restore drill is a release gate and should be recorded with aggregate counts and checksums, while the backup contents remain outside Git.

For the complete release sequence, including the real-team eligibility review, budget monitoring, owner response, and authorised pilot, see [`docs/photo-gallery-operations.md`](../../docs/photo-gallery-operations.md).
