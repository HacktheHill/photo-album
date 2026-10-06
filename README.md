# Hack the Hill photo gallery

This private repository contains the standalone attendee photo gallery for Hack the Hill III. The canonical album is served at [photos.hackthehill.com](https://photos.hackthehill.com/) and the attendee SPA also presents a minimal restore confirmation when an organiser follows a protected restore link.

The gallery is independent of the main Hack the Hill website. Astro builds the browser application, and the Cloudflare Worker serves that build through Worker Static Assets while handling the private API and media routes on the same origin. This project does not migrate, replace, or add routes to the main website.

## Canonical routes

- `/` — attendee album and email-code sign-in.
- `/restore?case=<caseId>&version=<n>` — minimal, Access-protected restore confirmation reached from a removal notification.
- Query-selected operations on `/` handle login, album, licence, events, photo viewing/downloads and removal reports; `/restore` handles protected case reads and restoration.

These are also the only application request paths; `action` query parameters select operations.

## Repository layout

```text
src/
  components/Photos/       React album, viewer, licence, and minimal restore confirmation UI
  layouts/GalleryLayout.astro
  locales/photos.ts        Typed English/French photo copy
  pages/index.astro        Album route
  pages/restore.astro      Restore confirmation route
  shared/                  Photo and licence contracts
  styles/                  Brand tokens and gallery-wide CSS
services/photo-gallery/
  src/index.ts             Cloudflare Worker API and asset gateway
  migrations/              D1 schema migrations
  tests/                   Workers-runtime tests
  tools/                   Local owner utilities
scripts/photos/            Private asset preparation and verification tools
docs/                      API and release operations
public/                    Logo, fonts, browser policy, and static assets
```

The Worker owns authentication, private R2 reads, downloads, licence acknowledgements, aggregate activity, removal cases, protected restore actions and audit, restricted owner rights follow-up, scheduled retention cleanup, and the notification outbox. R2 object keys, the attendee roster, source photographs, inventories, eligibility exports, checkpoints, and credentials remain outside the public build and outside Git.

The visual system uses the existing Hack the Hill Rubik and Coolvetica fonts and shared maroon, gold, coral, and warm-surface tokens in `src/styles/tokens.css`. The album keeps neutral image surfaces so the display does not shift the appearance of edited photographs, while actions and headings use the established brand roles. Attribution follows the conventions of the sibling Hack the Hill projects; no new third-party code licence is assumed. The separate photo licence is the approved event licence in `src/shared/photo-licence.json`.

## Tooling and local development

The root package requires Node `>=24 <25`. Install the root and Worker dependencies separately:

```sh
npm ci
npm --prefix services/photo-gallery ci
```

Run the Astro application at `http://localhost:4321` with:

```sh
npm run dev
```

During local development, `astro.config.mjs` proxies requests with an `action` query parameter to the local Worker at `http://127.0.0.1:8787`. It translates only a verified same-origin development request; cross-site requests remain unchanged so the Worker can reject them. In a second terminal, run the Worker with:

```sh
npm run worker:dev
```

Useful local checks are:

```sh
npm run format:check
npm run lint
npm run typecheck
npm run worker:check
npm run worker:test
npm run test:pipeline
npm run test:e2e
```

`npm run verify` runs the repository verification sequence. `npm run build` writes the Astro output to `build/`; the Worker configuration binds that directory as its Static Assets source.

The browser tests use synthetic fixtures. They do not establish production eligibility, send attendee email, or prove that an external provider accepted or delivered a message.

## Photo assets

The approved staging collection contains 358 edited photographs in 18 event categories and 1,432 verified R2 objects across thumbnails, previews, and download variants. The complete inventory, source images, eligibility input, generated SQL, uploader checkpoints, and verification reports are private owner artifacts. They must not be copied into `public/`, `build/`, or Git.

Use the tools under `scripts/photos/` to build derivatives, create a private manifest, verify every expected object, and generate idempotent D1 seed SQL. The initial full-byte verification must check every expected object and the complete remote listing. A sampled verification is not sufficient for a release claim.

The production bucket has been created as `hack-the-hill-photo-gallery`. Production publication still depends on the release gates in [the operations runbook](docs/photo-gallery-operations.md); the existence of the bucket does not mean that the collection is live or that production has been verified.

## Privacy and moderation boundaries

Attendee access is based on a reviewed eligibility import and a one-time eight-digit email code. The browser receives only the published photo manifest and session-scoped media routes. It never receives the roster, readable email hashes, R2 object keys, source editing notes, or internal publication data.

Album visits, photo opens, and download totals are recorded as aggregates without an identity-linked browsing history. Individual download request records are retained for 90 days for manual, owner-only rights follow-up. There is no browser rights lookup or bulk export. Resolved moderation cases, reports, and audit records are retained for one year; pending cases remain available. Scheduled Worker cleanup applies those limits and retries the notification outbox.

An attendee removal report immediately quarantines the affected photo and queues a notification. Organisers must resolve every pending report before restoring a photo. Restoration is a separate, audited action and must preserve the current moderation version and state. Existing copies outside this service cannot be recalled by changing the gallery.

The bilingual download licence is shown before a download is issued. Promotional, advertising, recruitment, and sponsor-promotion uses require the applicable consent or CTN confirmation described by the licence.

## Release status

Staging asset verification is complete for the collection described above. Production still requires the owner-controlled configuration and verification steps in [docs/photo-gallery-operations.md](docs/photo-gallery-operations.md), including the production D1 binding, dedicated Cloudflare Access application, SES configuration, reviewed real-team eligibility source, backup and restore drill, budget monitoring, and a real pilot with authorised recipients.

Do not describe this repository as live production, a completed attendee notification, or a delivered email until the corresponding external evidence has been recorded.

## Documentation

- [API contract](docs/photo-api-contract.md)
- [Operations and release runbook](docs/photo-gallery-operations.md)
- [Worker README](services/photo-gallery/README.md)
- [Private asset pipeline notes](scripts/photos/README.md)
