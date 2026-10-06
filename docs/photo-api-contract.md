# Photo gallery API contract

The canonical origin is `https://photos.hackthehill.com`. The browser application has two user-facing routes: `/` for the album and `/restore?case=<caseId>&version=<n>` for the minimal restore confirmation. Every protected API, media, download, and restore operation is under the single internal Worker prefix `/api`.

Responses are JSON unless the endpoint returns an image or download stream. JSON errors have the shape `{ "error": string }` and an HTTP status. Protected JSON and download responses use `Cache-Control: private, no-store`; published attendee media may use the short private revalidation policy returned by the Worker. Client mutation requests send JSON and `X-CSRF-Token` where a session exists. Authentication-code request and verification instead require a same-origin request before a session exists.

## Attendee endpoints

### `GET /api/auth/session`

Returns `{ authenticated: false }` for an anonymous browser. An active attendee session returns `PhotoSession`, including a session-scoped CSRF token, opaque account identifier, current acknowledged licence version, and expiry. The response never returns eligibility data.

### `POST /api/auth/request`

Request body:

```json
{ "email": "attendee@example.org", "language": "en" }
```

The response is `202 { "accepted": true }` for both eligible and unknown addresses so that eligibility cannot be enumerated. A valid request creates an eight-digit code challenge and queues delivery; the code is never returned in the API response. Rate limits return a generic error without revealing whether an address is eligible. `language` is `en` or `fr`; all other values use English.

### `POST /api/auth/verify`

Request body:

```json
{ "email": "attendee@example.org", "code": "01234567" }
```

Successful verification returns an authenticated `PhotoSession` and an `HttpOnly`, `Secure`, `SameSite=Strict` session cookie. Codes expire after ten minutes, are single-use, and allow at most five failed attempts. Invalid, expired, unknown, and already-consumed codes use the same error shape.

### `POST /api/auth/logout`

Accepts `{}`. When a session exists, the request must be same-origin and include its CSRF token. The session is revoked and the cookie is cleared. An anonymous logout still returns an accepted response.

### `GET /api/album`

Requires an active attendee session. Returns an `AlbumManifest` containing the current licence version and only published photos. Each photo includes its opaque ID, event category, filename, dimensions, thumbnail and preview media URLs, and full/quick download metadata. The manifest does not include R2 object keys, eligibility records, source paths, moderation notes, requester identities, or hidden photos.

### `POST /api/licence/acknowledge`

Requires an active session and CSRF token.

```json
{ "version": "2026-10-06" }
```

The version must match the current D1 licence row and Worker configuration. A successful request returns `{ "version": string }`. Downloads are blocked with `428` until the current version has been acknowledged.

### `POST /api/events`

Requires an active session and CSRF token.

```json
{ "photoIds": ["opaque-photo-id"], "albumVisit": true }
```

The Worker deduplicates photo opens per session and records only daily aggregate counts. `albumVisit` increments an aggregate album-visit counter. No identity-linked browsing history is created.

### `GET /api/photos/<id>/thumbnail` and `GET /api/photos/<id>/preview`

Require an active attendee session and return the corresponding published WebP/JPEG variant. The Worker rechecks publication state immediately before the R2 read, so a quarantined or withdrawn photo is no longer available even if its manifest was previously loaded. There is no public bucket URL and no full-size media endpoint at the thumbnail or preview paths.

### `GET /api/photos/<id>/download?format=full|quick&requestId=<uuid>`

Requires an active attendee session, the current licence acknowledgement, a valid UUID `requestId`, and `format=full` or `format=quick`. Returns an attachment from the private R2 bucket. The request ID binds retries and range requests to the same account, photo, and format; reuse with a different binding returns `409`. Published-state checks occur before the object is returned. Downloads record an aggregate total and a restricted individual request record.

Individual download request records are retained for 90 days for rights follow-up. The format totals remain in aggregate storage after those individual records expire.

### `POST /api/photos/<id>/removal-requests`

Requires an active session and CSRF token.

```json
{ "explanation": "Please hide this image because…", "requestId": "uuid" }
```

The explanation is trimmed and limited to 2,000 characters. A valid request atomically creates a pending case, quarantines the photo, and queues the moderator notification; it returns `202 { "caseId": string }`. An idempotent retry with the same account, photo, and request ID returns the existing case without consuming another quota slot. New reports are limited to 30 per account per hour and 5 per account for the same photo per hour. A rejected request cannot quarantine another photo or enqueue a notification.

## Organiser restore endpoint

Cloudflare Access protects `photos.hackthehill.com/restore` and its descendants, plus `photos.hackthehill.com/api/restore` and its descendants, with the dedicated CTN-only Google Workspace application, its configured audience (`ACCESS_AUD`), and a one-hour session. The Worker requires a cryptographically verified Access JWT with the configured issuer (`ACCESS_TEAM`), audience, expiry, subject, and an `@ctn-rtc.org` email. It does not trust an email header and does not grant organiser privileges to an attendee OTP session. The application has no organiser dashboard, sign-in page, case interface, or rights lookup page.

Removal notifications contain the photo and the request explanations snapshot needed for the decision. Their single button targets the Access-protected user route `/restore?case=<caseId>&version=<n>`. The shared gallery component shows only the small filename and an explicit Restore button. The page calls the internal API after Access verification; GET never mutates state.

### `GET /api/restore/<caseId>`

Returns the authenticated restore state:

```json
{
	"filename": "IMG_1234.jpg",
	"canRestore": true,
	"photoVersion": 3,
	"status": "quarantined",
	"csrfToken": "opaque-token"
}
```

The response is case-scoped and read-only. A supplied email-link `version` is checked against the current photo version; a stale link is rejected. `canRestore` is false when the photo is no longer eligible for this action or another pending case prevents an atomic restore.

### `POST /api/restore/<caseId>`

Requires the verified Access session, the returned CSRF token, same-origin request, and an explicit confirmation from the SPA. The body is:

```json
{ "expectedVersion": 3 }
```

The Worker compare-and-set checks the email-link version and `expectedVersion`, rejects stale links and other pending cases, then atomically dismisses all pending requests in the case and publishes the photo. It writes the fixed restore audit reason together with the verified Access identity. Replays or mismatched versions do not publish a photo. The operation is the only restore action exposed to the organiser.

Individual download request records remain available for 90 days for manual, owner-only rights follow-up in the database. There is no rights lookup page or bulk export in this service.

## Shared contracts and invariants

- TypeScript photo/session contracts live in `src/shared/photos.ts`.
- The exact bilingual licence text lives in `src/shared/photo-licence.json`.
- Frontend copy is typed in `src/locales/photos.ts`.
- The frontend never receives the attendee roster, email hashes, R2 object keys, source editing notes, or private moderation fields.
- The service owns dedicated D1 and R2 bindings and has no public media fallback.
- Protected JSON and downloads are private and non-cacheable. Attendee media may use only the short private revalidation policy returned by the Worker.
- Scheduled cleanup retains individual download requests for 90 days, keeps unresolved cases, and removes resolved case/report/audit history after one year.
