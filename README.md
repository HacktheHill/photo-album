# Hack the Hill photo album

The attendee photo album for Hack the Hill III is live at [photos.hackthehill.com](https://photos.hackthehill.com/), with 358 edited photos in 18 categories.

Eligible attendees sign in with an emailed code, browse in English or French, save favourites on their device, and download full-quality or quick-share JPEGs after reviewing the photo licence. Removal requests immediately hide a photo and notify organisers; restoration uses an email link protected by CTN-only Google Workspace sign-in.

## Development

Use Node.js 24 and Python 3 with Pillow for the pipeline tests.

```sh
npm ci
npm --prefix services/photo-gallery ci
```

Run these in separate terminals:

```sh
npm run dev          # Astro: http://localhost:4321
npm run worker:dev   # Local Worker: http://127.0.0.1:8787
```

Astro forwards application requests to the local Worker. Local authentication and media need local database fixtures, assets and secrets; see the [operations guide](docs/photo-gallery-operations.md#local-data). Browser tests supply synthetic fixtures and work without a running Worker or real email credentials.

## Checks and deployment

```sh
npx playwright install chromium firefox
npm run verify             # Formatting, lint, types, Worker/tools/pipeline/browser tests
npm run build              # Static application in build/
npm run deploy:dry-run     # Package the deployment without publishing
npm run deploy:staging
npm run deploy:production
```

Deployment builds the application and publishes it with the Worker. CI verifies pull requests and `main`; production deployment is an explicit command.

## Structure

| Directory                 | Purpose                                                             |
| ------------------------- | ------------------------------------------------------------------- |
| `src/`                    | Astro pages, React album/viewer, bilingual copy, styles and licence |
| `services/photo-gallery/` | Worker, D1 migrations, authentication, private media and moderation |
| `scripts/photos/`         | Photo variants, upload, inventory and verification tools            |
| `public/`                 | Logo and fonts                                                      |
| `docs/`                   | Operations and request contracts                                    |

The app uses Astro and React, Cloudflare Workers with private R2 and D1, and AWS SES for email. Pages and application requests use `/` and `/restore`; an `action` query parameter selects each operation. Assets and browser requests use relative URLs.

The main event website uses eight approved R2 previews through `/?action=highlight&photo=<id>`. The allowlist is in `services/photo-gallery/src/public-highlights.ts`; hiding a photo also stops serving its public preview. Full-size downloads still require sign-in and licence acknowledgement.

Source photos, private manifests, eligibility exports, backups and credentials stay outside Git and the public build. The exact photo licence is in [`src/shared/photo-licence.json`](src/shared/photo-licence.json).

## Documentation

- [Operations](docs/photo-gallery-operations.md): configuration, deployment, eligibility, moderation, backups and monitoring.
- [Request contract](docs/photo-api-contract.md): request bodies, responses and authentication.
- [Worker development](services/photo-gallery/README.md): package commands and dependency notes.
- [Photo pipeline](scripts/photos/README.md): derivatives, upload and complete object verification.

[Database review](docs/database-review.md) covers column purpose and recommended simplifications.
