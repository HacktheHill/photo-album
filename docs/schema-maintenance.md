# Schema maintenance

The one-time production cutover is scheduled for **6 October 2026 at 11 p.m. America/Toronto**. No migration or Worker activation should run before then. The schema cleanup is in `0006_simplify_schema.sql`.

Production targets:

- Worker: `hack-the-hill-photo-gallery` at `photos.hackthehill.com`.
- D1: `hack-the-hill-photo-gallery`, ID `1b13a732-a526-4a53-b691-d74625919c8f`.
- Cloudflare account: `9cff4e4fc6be8b966eeae47806117336`.

Use the project-local Wrangler from `services/photo-gallery`. Every remote command must specify `--config wrangler.jsonc --env production`. The private handoff state records the tested commit, migration hash, current version, and uploaded replacement/maintenance versions. It is outside Git in the task's `photo-gallery-private/schema-maintenance-state.json` file.

## Cutover

1. Verify Cloudflare authentication, the expected production deployment, the tested commit, migration hash, and CI results. Uploads alone do not activate a Worker. Stop if a different operator has changed production or if the merge guard would fail.
2. Activate the prepared maintenance Worker at 100%. It returns a short bilingual 503 response with `Retry-After` and performs no database writes or scheduled jobs. Confirm it is active before starting the backup or migration. Record the start time.
3. Export a fresh private SQL backup with `wrangler d1 export hack-the-hill-photo-gallery --remote --output <private-file>`. Capture output privately: the export can print a temporary signed download URL. Keep backups and any personal data out of Git and chat.
4. Rehearse the migration against that fresh export locally and compare retained records. Require a one-to-one case/report mapping, matching photo/status values, and no foreign-key violations. Save baseline counts and retained-field hashes privately.
5. List pending production migrations. Require **only** `0006_simplify_schema.sql`; then run `wrangler d1 migrations apply hack-the-hill-photo-gallery --remote`. Wrangler applies a migration transactionally and records it in `d1_migrations`.
6. Verify the new schema, foreign keys, active-account counts, variants, aggregate totals, and removal/audit mappings. If additional rows arrived since the earlier rehearsal, compare against the fresh maintenance-window backup rather than fixed historical counts.
7. Activate the pre-uploaded replacement Worker at 100% using `wrangler versions deploy <replacement-version>@100 --yes`. Confirm the deployment and record the end time.
8. Check the live shell and session endpoint, anonymous rejection of attendee media/downloads, all eight public highlight images, and CTN Access protection on `/restore`. Do not send login or removal emails or create production test removals. Report duration and verification results, update the database-review status, and pause this one-time automation.

## Recovery

If the migration fails, Wrangler rolls it back. Confirm the old schema and retained records before reactivating the recorded previous Worker. If the migration succeeded, the previous Worker is incompatible: keep maintenance active and deploy a corrected Worker for the new schema. Do not blindly restore the old backup after reopening the service, since that could discard newer records.

The maintenance state and SQL backup provide the recovery evidence. D1 Time Travel is an additional recovery option; database recovery and Worker rollback must be coordinated. Check the current Cloudflare documentation before using it.

References: [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/), [Wrangler D1 commands](https://developers.cloudflare.com/d1/wrangler-commands/), [D1 foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/).
