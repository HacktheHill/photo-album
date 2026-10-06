# Photo gallery operations and release runbook

This repository is the standalone attendee gallery at `https://photos.hackthehill.com`. The root Astro application and the Cloudflare Worker are deployed together as one Worker Static Assets deployment on that subdomain. The Worker serves the built Astro assets and runs every protected API, media, download, and restore operation through query-selected operations on `/` and `/restore`. The two user-facing routes are `/` for the album and `/restore?case=<caseId>&version=<n>` for the minimal restore confirmation.

The main Hack the Hill website is outside this repository and is not modified by this service. The service uses only `/` and `/restore` for pages and application requests.

D1 stores keyed eligibility records, sessions, publication state, removal cases, moderation audit, aggregate activity, restricted download-request records, and the notification outbox. Private R2 stores the prepared photo variants. The browser receives neither the roster nor R2 object keys.

## Current status and ownership

The staging collection has 358 approved edited photos in 18 categories and 1,432 verified R2 objects. Staging asset verification is complete. The production R2 bucket has been created as `hack-the-hill-photo-gallery`, and the production D1 database has been created with ID `1b13a732-a526-4a53-b691-d74625919c8f`.

Production is deployed at photos.hackthehill.com with 358 photos, 18 categories, and 1,432 SHA-256-verified R2 objects. Live verification checked every thumbnail and preview (716 objects), licence enforcement and representative full/quick downloads. The recipient confirmed code receipt and completed production sign-in. Backup recovery, budget monitoring and a live removal/restoration pilot remain operational checks; do not represent configuration or unit tests as proof of that live moderation pilot.

The owner of the service is responsible for approving the asset manifest, production bindings, eligibility source, licence version, moderation policy, backup evidence, and final pilot. The privacy/rights mailbox is `privacy@ctn-rtc.org`; configuring a recipient variable does not prove that SES is usable or that a message was delivered.

## Organiser authentication

Create a dedicated Cloudflare Access application for `photos.hackthehill.com/restore` and its descendants. Use the approved Google Workspace identity configuration and an Allow policy restricted to `@ctn-rtc.org`. The final Access issuer and audience must be copied into the production Worker variables `ACCESS_TEAM` and `ACCESS_AUD` after the application is reviewed. Do not reuse the metrics application audience or silently broaden its policy. The application uses its own 30-minute session and preserves the aggregate album metrics audience separately. Do not protect the whole root album with this application.

The Worker verifies the Access JWT signature, issuer, audience, expiry, subject, and email domain on every organiser request. It accepts the signed assertion header or the platform's `CF_Authorization` cookie; it does not trust a user-supplied email header. Access sessions are limited to 30 minutes by the application; Worker CSRF tokens are bound to the authenticated Access session. Attendee OTP sessions do not grant organiser privileges.

The production Access application is `a5802520-d237-46f1-9ccd-cd20659a124c`, using the existing Only CTN Emails policy and Google Workspace only. Its dedicated audience is configured in the production Worker. Anonymous restoration requests redirect to Access; attendee login does not grant restoration rights.

`MODERATOR_EMAILS=privacy@ctn-rtc.org` identifies the intended privacy/rights mailbox; it does not grant organiser access or send mail to every CTN account.

## Collection, assets, and eligibility

The approved collection contains 358 edited photos across 18 event categories. The staging inventory covers 1,432 objects across thumbnails, previews, full-quality JPEGs, and quick-share JPEGs. Full and quick JPEG downloads are copied byte for byte from the approved attendee-distribution masters. The pipeline generates 640px WebP thumbnails and 1600px WebP previews, retains ICC profiles, removes derivative location metadata, and records hashes. Originals and prior edit candidates stay outside this repository.

Run the pipeline and uploader described in `scripts/photos/`. Keep output, checkpoints, eligibility exports, credentials, manifests, SQL, and verification reports outside Git. Use the manifest to seed D1; do not manually reconstruct IDs from basenames because categories can contain duplicate filenames. Only published photos are returned to attendees. Media routes check current publication state on every request.

Eligibility is an owner-controlled, private import. Use the reviewed real-team eligibility source selected for this standalone service; an RSVP alone is not an attendance decision. Do not copy application answers into the gallery, commit the source, or expose the roster to browsers. The approved source is applicants marked Attended plus every email in the CTN Members sheet. The verified import contains 331 unique eligible emails: 298 attendees and 33 members, with no overlap. One attended row had no usable email.

## Resources and deployment model

Resources prepared in the Hack the Hill Cloudflare account `9cff4e4fc6be8b966eeae47806117336`:

| Resource          | Staging value                              |
| ----------------- | ------------------------------------------ |
| Worker            | `hack-the-hill-photo-gallery-staging`      |
| Private R2 bucket | `hack-the-hill-photo-gallery-staging`      |
| D1 database       | `hack-the-hill-photo-gallery-staging`      |
| D1 ID             | `f61bc64c-e938-4711-9b65-482d7682ffe5`     |
| SES region        | `ca-central-1`                             |
| Access team       | `https://hackthehill.cloudflareaccess.com` |

Planned production values and status:

| Resource              | Production value/status                                                            |
| --------------------- | ---------------------------------------------------------------------------------- |
| Worker                | `hack-the-hill-photo-gallery`                                                      |
| Custom domain         | `photos.hackthehill.com`                                                           |
| Private R2 bucket     | `hack-the-hill-photo-gallery` (created; release verification pending)              |
| D1 database           | ID `1b13a732-a526-4a53-b691-d74625919c8f` (created; binding/configuration pending) |
| Access application    | CTN-only Google Workspace application configured                                   |
| SES                   | configured; login email receipt confirmed                                          |
| Real-team eligibility | 331 reviewed eligible accounts imported and verified                               |

The R2 bucket's public access must remain disabled. Production resources and routes are separate from staging. Never deploy with placeholder bindings, staging IDs, unreviewed eligibility, an empty Access audience, or an unprotected restore API.

The root `npm run build` writes `build/`. The Worker configuration binds that directory as Static Assets and runs the Worker first for `/`, `/restore` and `/restore/`. Static pages and protected service routes therefore share one origin. Website Pages deployment is not part of this project.

## Configuration and secrets

Set `APP_ORIGIN=https://photos.hackthehill.com` only in the reviewed production Worker configuration so removal notification buttons can point to the protected relative `/restore?case=<caseId>&version=<n>` route. Browser assets and application requests remain relative. Set `CURRENT_LICENCE_VERSION` to the exact `LICENCE_VERSION` in `src/shared/photos.ts` and the current D1 licence row. The bilingual text comes from `src/shared/photo-licence.json`.

The sender is `Hack the Hill <info@ctn-rtc.org>` and removal notifications go to `privacy@ctn-rtc.org`. Both sender identities are verified and domain DKIM succeeds. The dedicated IAM user can only send email from this address through its existing configuration set. Production login emails were accepted by SES, the recipient confirmed receipt, and a real code was successfully verified. Use dedicated, least-privilege credentials in the protected deployment secret store; never commit them, put them in command arguments, or print them in verification logs. Required secret names are `OTP_HMAC_SECRET`, `SESSION_HMAC_SECRET`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY`. Non-secret variables include `SES_REGION`, `SES_FROM_EMAIL`, `MODERATOR_EMAILS`, `APP_ORIGIN`, `ACCESS_TEAM`, and `ACCESS_AUD`.

The service leaves the outbox pending when SES is incomplete. A configured sender or provider acceptance is not evidence of inbox delivery or human readership. The real pilot must verify the expected code path with authorised recipients and record delivery evidence without committing personal message data.

## Backup, restore, and release gates

For release and ongoing operations, maintain evidence for the following checks:

1. Run root formatting, lint, type checks, Worker tests, owner-tool tests, pipeline tests, and browser tests from a clean review state.
2. Apply all reviewed D1 migrations to staging and verify the migration version. Do not use production bindings for local development.
3. Verify the complete staging inventory: all 1,432 expected objects, byte hashes for every object, content types, metadata hashes, and the complete remote key listing. Confirm the R2 bucket is private.
4. Build a private backup package containing the D1 export, photo manifest, R2 inventory/hash report, current licence, and moderation-state summary. Store it outside Git in the approved owner-controlled location.
5. Restore that package into an isolated non-production D1/R2 test target. Verify photo publication status, moderation version, quarantine/withdrawn rows, pending cases, resolved cases, and audit records. Restoration must preserve moderation state; do not run a fresh seed that republishes photos or resets versions.
6. Configure the production D1 ID, production R2 bucket, custom domain route, Access audience/issuer, SES variables/secrets, licence version, and scheduled cleanup only after each value is reviewed.
7. Re-run complete object verification against production. Uploading or creating the bucket alone is insufficient. Confirm no public R2 access, unexpected keys, source files, or private manifests are exposed.
8. Import only the reviewed real-team eligibility source. Record the source version and aggregate counts in the owner release record; keep the source and personal data outside Git.
9. Complete a real pilot with authorised attendees and organisers: code request and receipt, verification, session expiry/revocation, licence acknowledgement, thumbnail/preview, full and quick download, share link, removal request, the protected restore flow, retention cleanup, and failed notification handling.
10. Verify the live host from signed-out and authorised browsers. Record the Worker revision, D1/R2 bindings, collection counts, Access result, media denial, response headers, and pilot evidence before announcing the album.

A successful build, dry run, bucket upload, SES provider acceptance, or Access configuration does not by itself establish a live production release.

## Moderation, retention, monitoring, and owner response

Explained attendee reports immediately quarantine the photo and create a durable notification. The notification includes the photo and every request explanation snapshot needed for the decision, with one button targeting `/restore?case=<caseId>&version=<n>`. After Access verifies the organiser, the shared gallery component shows only the small filename and an explicit Restore button. There is no dashboard, sign-in page, case form, or rights lookup. Every mutation is an authenticated POST; a GET never changes state. Existing copies outside this service cannot be recalled by changing the gallery.

New removal reports have account and per-photo hourly limits; idempotent retries do not consume another report allowance. The restore GET returns the filename, current eligibility, photo version, status, and CSRF token. The explicit POST supplies `expectedVersion`; compare-and-set rejects a stale email version or another pending case, then atomically dismisses all pending requests in the case and publishes the photo with a fixed audit reason and verified Access identity. Individual download records are retained for 90 days for audited, manual owner rights follow-up in the database. There is no web rights lookup, bulk export, queue pagination, or organiser stats surface. Album visits and photo opens remain aggregate and identity-free; the album may show aggregate `views` and `downloadRequests` totals to eligible attendees. The outbox temporarily contains delivery payloads, including an unsent OTP, and erases the payload after successful delivery or expiry; removal payloads have a 90-day cap. Do not add facial recognition, behavioural profiles, or marketing analytics.

The Worker cron performs retention cleanup and retries the outbox. The owner must monitor Worker errors, D1/R2 health, outbox failures, SES cost and delivery signals, and Cloudflare resource budgets. Configure budget alerts before production and assign an owner who can investigate and respond to alerts. Privacy and rights questions route to `privacy@ctn-rtc.org`; monitor that mailbox and record moderation follow-up without copying personal records into Git.

The exact bilingual licence is shown before downloads. There are no ZIP downloads, licence page, licence TXT file, or duplicate licence in an internal Drive folder.
