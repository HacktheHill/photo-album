# Photo album Worker

The Worker serves the built Astro app and handles authentication, private photo delivery, downloads, removal requests and restoration. It uses D1 for application data, R2 for photo variants, AWS SES for email and Cloudflare Access for organiser restoration.

Application requests use `/` and `/restore` with query parameters. There is no `/api` prefix. The request formats are documented in the [request contract](../../docs/photo-api-contract.md).

## Commands

From this directory:

```sh
npm ci
npm run dev
npm run typecheck
npm test
npm run types       # Regenerate types after changing bindings
```

Deploy from the repository root with `npm run deploy:staging` or `npm run deploy:production` so the Astro build and Worker are released together.

## Configuration

[`wrangler.jsonc`](wrangler.jsonc) defines staging and the `production` environment, including D1, R2, Static Assets, the hourly cleanup job, SES settings and Access issuer/audience. The existing Cloudflare resource names retain `photo-gallery`; changing the repository name does not rename those resources.

Required secrets are `OTP_HMAC_SECRET`, `SESSION_HMAC_SECRET`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. Both HMAC secrets must contain at least 32 characters. Use `.dev.vars` for local-only values and Wrangler secrets for deployed values; never commit credentials.

The email sender is `info@ctn-rtc.org`; removal notifications go to `privacy@ctn-rtc.org`. Restoration requires the dedicated Cloudflare Access application, Google Workspace sign-in for `@ctn-rtc.org`, and a 30-minute session.

The `sharp` override uses the [patched 0.35.5 release](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) while Miniflare pins an older version.

Tests use synthetic data and cover login, private media, licence enforcement, removal limits, restoration races, notification handling and retention. They do not send real email.

See the [operations guide](../../docs/photo-gallery-operations.md) for local data, production deployment and maintenance.
