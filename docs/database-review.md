# Database review

Reviewed on 2026-10-06. Migration `0006_simplify_schema.sql` implements the cleanup below. Applied to production on 6 October 2026 at 10:19 p.m. Toronto time, after the user moved the maintenance window forward.

The migration reduces the application schema from 14 tables and 106 columns to 12 tables and 87 columns. Existing eligibility, sessions, photo variants, download records, aggregate totals, notifications, and moderation history are preserved.

## Cleanup

- Removed unused `accounts.role`, the three photo object-key columns duplicated by `photo_variants`, unused download-format aggregate totals, and redundant email/language fields in login challenges.
- Combined `removal_cases` and `removal_reports` into `removal_requests`. The request ID is the previous case ID, so existing restoration links and audit references remain valid. The migration aborts if a case has multiple reports, missing reports, or inconsistent photo/status values.
- Removed unused album-visit tracking and its arrival event. Per-photo views and downloads remain.
- Removed redundant email-hash, download-binding, and moderation-operation indexes. Unique constraints, useful lookup/retention indexes, and moderation operation tokens remain.
- Renamed `moderation_audit.actor_account_id` to `actor_subject`, since it stores a Cloudflare Access identity rather than an attendee account.
- Made licence text snapshots immutable. A new licence requires a new version; local seeding can activate an existing version without replacing its text.

## Retained schema

| Table                 | Purpose and retained fields                                                                                                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accounts`            | Eligibility and contact: `id`, `email`, `email_hash`, `active`, `created_at`, `revoked_at`.                                                                                                                                 |
| `code_challenges`     | Single-use login codes and rate limits: `id`, `account_id`, `email_hash`, `code_hash`, `created_at`, `expires_at`, `resend_after`, `attempts`, `consumed_at`, `request_ip_hash`.                                            |
| `sessions`            | Login, CSRF, terms acknowledgement, and revocation: `token_hash`, `account_id`, `csrf_hash`, `created_at`, `expires_at`, `licence_version`, `revoked_at`.                                                                   |
| `photos`              | Publication and download naming: `id`, `category`, `filename`, `version`, `status`, `width`, `height`, `created_at`, `updated_at`, `moderation_operation_id`.                                                               |
| `photo_variants`      | R2 objects and validation: `photo_id`, `format`, `object_key`, `width`, `height`, `bytes`, `sha256`, `content_type`.                                                                                                        |
| `licence_versions`    | Immutable terms history: `version`, `en_json`, `fr_json`, `current`, `created_at`.                                                                                                                                          |
| `removal_requests`    | Removal, retry binding, restoration, and retention: `id`, `photo_id`, `requester_account_id`, `explanation`, `request_id`, `status`, `photo_version`, `created_at`, `updated_at`, `resolved_at`, `moderation_operation_id`. |
| `notification_outbox` | Email retries and concurrent delivery claims: `id`, `kind`, `payload_json`, `attempts`, `available_at`, `locked_until`, `sent_at`, `last_error`, `created_at`.                                                              |
| `moderation_audit`    | Restoration identity and outcome: `id`, `actor_subject`, `action`, `case_id`, `photo_id`, `reason`, `expected_version`, `created_at`.                                                                                       |
| `daily_aggregates`    | Visible per-photo counts: `day`, `photo_id`, `opens`, `downloads`.                                                                                                                                                          |
| `viewer_opens`        | Temporary view deduplication: `photo_id`, `session_key`, `opened_at`.                                                                                                                                                       |
| `download_requests`   | Idempotent downloads and 90-day rights follow-up: `request_id`, `account_id`, `photo_id`, `photo_version`, `format`, `created_at`.                                                                                          |

Cloudflare's `_cf_KV` and `d1_migrations` bookkeeping is unchanged. Foreign keys, uniqueness constraints, the automatic quarantine trigger, CSRF checks, restoration version checks, and operation tokens remain functional safeguards.

## Validation and remaining decisions

Fresh production backups taken during the cutover verified all 12 retained-data groups before and after migration, including 539 active accounts, 358 published photos, and 1,432 variants, with no foreign-key violations. Tests cover migration preservation, unsafe-merge rejection, login, removal retries/quotas, restoration races, and retention.

Per-photo counts still display the last 90 days. Changing that window or its label is a separate UI decision. View-deduplication keys remain temporary session-derived pseudonyms; making them photo-specific is a separate privacy improvement, not part of this schema migration. Eligibility source manifests stay private rather than copying registration profiles into D1.

See [schema maintenance](schema-maintenance.md) for the cutover and recovery procedure. Do not rewrite already-applied migrations or roll back Worker code independently of the database schema.
