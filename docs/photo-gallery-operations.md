# Photo album operations

The album is live at [photos.hackthehill.com](https://photos.hackthehill.com/). Astro and the Worker are deployed together; D1 holds application data and private R2 holds the photo variants. Configuration is in [`services/photo-gallery/wrangler.jsonc`](../services/photo-gallery/wrangler.jsonc).

## Verified launch state

As of 6 October 2026:

- 358 edited photos, 18 categories and 1,432 R2 objects; every object was verified against its SHA-256 hash.
- Every live thumbnail and preview was checked, along with licence enforcement and representative full/quick downloads.
- The initial import of 331 eligible addresses (298 attended applicants and 33 CTN members) was verified. Eligibility was later widened and reconciled; see [Album eligibility](#album-eligibility) for the current rule and count.
- Login-email receipt and production sign-in were confirmed.
- `/restore` redirects anonymous visitors to the dedicated CTN-only Google Workspace Access application, with a 30-minute session.

An isolated backup recovery drill, a complete live removal/restoration cycle and budget-alert checks remain to be verified. Automated tests cover moderation behaviour but do not replace those operational checks.

## Configuration

The default Wrangler target is staging; `--env production` selects production. Existing Worker, D1 and R2 names retain `photo-gallery`. Production uses the `photos.hackthehill.com` custom domain and has no public `workers.dev` route or public R2 bucket.

Staging has no `APP_ORIGIN`, `ACCESS_TEAM` or `ACCESS_AUD`, so restoration cannot be tested there: email links are relative and `/restore?action=case` always returns `403`. Configuring it would need a staging origin and its own Access application.

| Setting                        | Purpose                                                          |
| ------------------------------ | ---------------------------------------------------------------- |
| `APP_ORIGIN`                   | Origin for restoration email links                               |
| `CURRENT_LICENCE_VERSION`      | Must match `src/shared/photos.ts` and the current D1 licence row |
| `SES_REGION`, `SES_FROM_EMAIL` | `ca-central-1`, `info@ctn-rtc.org`                               |
| `MODERATOR_EMAILS`             | Removal notifications: `privacy@ctn-rtc.org`                     |
| `ACCESS_TEAM`, `ACCESS_AUD`    | Dedicated restoration application issuer and audience            |

Required secrets are `OTP_HMAC_SECRET`, `SESSION_HMAC_SECRET`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. Use dedicated SES credentials restricted to the configured sender and configuration set. Store secrets through Wrangler or the deployment secret store, not in Git or command arguments.

Cloudflare Access protects `/restore` and its descendants only. Its Google Workspace policy permits `@ctn-rtc.org` accounts. The Worker independently verifies the signed assertion and requires CSRF protection for restoration; attendee login does not grant restoration access.

## Album eligibility

Access is the union of attended hacker application rows, all addresses in the approved Devpost registrant/project and volunteer exports, CTN members, and explicitly approved addresses. An address in another approved source keeps access even if its hacker application is not marked attended. The live application Sheet supplies attendance; the CSV does not.

The 2026-10-06 reconciliation verified 530 active addresses and revoked 549 addresses included solely by non-attended hacker application rows. Source exports and the verification report remain private, outside Git. Imports are additive: reconcile sources before revoking access and revoke sessions with an excluded account.

## Local data

Wrangler development uses local D1/R2 state. From `services/photo-gallery/`, apply local migrations:

```sh
npx wrangler d1 migrations apply DB --local --config wrangler.jsonc
```

Put fresh local HMAC secrets in the ignored `services/photo-gallery/.dev.vars`. Do not copy production credentials or attendee records into development. For local media, use a synthetic image set prepared by the pipeline; the seeder reads its private `pipeline-inventory.json`, which includes the object keys (`browser-manifest.json` does not):

```sh
npm run seed:local -- /absolute/path/pipeline-inventory.json /absolute/path/asset-root
```

The seed tool is local-only. Local eligibility can be imported with `npm run import:eligibility -- /absolute/path/eligibility.json`, using the same local `OTP_HMAC_SECRET` in the tool's environment. End-to-end email testing needs a separately configured development sender; automated tests mock delivery.

## Deploy an update

From the repository root:

```sh
npm run verify
npm audit --audit-level=high
npm audit --prefix services/photo-gallery --audit-level=high
npm run deploy:dry-run
npm run deploy:production
```

For schema changes, back up D1 and apply reviewed migrations before deploying the dependent code. From `services/photo-gallery/`:

```sh
npx wrangler d1 migrations apply DB --remote --env production --config wrangler.jsonc
```

After deployment, verify the live sign-in page, authenticated album, representative media/downloads and anonymous restoration redirect. Record the deployed Worker version. Merging a PR runs CI but does not deploy production.

## Photos and eligibility

Follow the [photo pipeline guide](../scripts/photos/README.md) to prepare derivatives, upload them and verify the complete remote listing and every byte hash. Keep source images, inventories, generated SQL and reports outside Git. D1 IDs derive from category plus filename, so duplicate basenames in different categories are supported.

Eligibility follows the union described in [Album eligibility](#album-eligibility). The import format is `{ "accounts": [{ "email": "person@example.org", "eligible": true }] }`. Remote imports require `CONFIRM_PHOTO_GALLERY_REMOTE_IMPORT=yes`, the correct `OTP_HMAC_SECRET`, `--remote` and the explicit target environment. Import is additive: omitted accounts remain eligible. Use the separate `revoke:eligibility` tool for reviewed revocations; it also invalidates sessions. Remote revocation requires `CONFIRM_PHOTO_GALLERY_REMOTE_REVOKE=yes`, the same `OTP_HMAC_SECRET`, `--remote` and the explicit target environment.

Keep R2 private. Publication checks apply to each media/download request. Initial-import SQL preserves existing moderation state; replacing an edited photo requires a reviewed asset/publication update.

## Removal and rights follow-up

An explained removal request immediately hides the photo and queues an email to `privacy@ctn-rtc.org`. The email includes the information needed for review and a restoration link. After CTN sign-in, the organiser sees a small confirmation with a Restore button. Opening the link does not restore the photo; the explicit action checks the current version and records the organiser identity.

Hidden photos accept no further removal requests. A stale link (the photo version changed) cannot restore; use the latest notification. Restoring dismisses every pending request for that photo. Investigate unexpected state in D1 rather than overwriting photo status. Individual download records support manual rights follow-up for 90 days. Existing copies downloaded by attendees cannot be recalled through the site.

## Backups and monitoring

Keep a private backup of D1, the photo manifest, R2 inventory/hash report and current licence before schema or publication changes. Test recovery in an isolated environment, including quarantined/withdrawn photos, publication versions, pending cases and audit records. Do not restore by reseeding all photos as published.

Monitor Worker errors, D1/R2 usage, SES delivery signals, notification retries and resource budgets. Check the privacy mailbox regularly. The hourly job retries pending emails (undelivered removal emails are kept until sent), deletes individual download records after 90 days, and deletes resolved moderation history after one year while retaining unresolved cases. Browsing statistics remain aggregate; no identity-linked browsing history is kept.
