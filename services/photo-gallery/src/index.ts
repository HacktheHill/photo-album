import { AwsClient } from "aws4fetch";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

type Account = { id: string; email: string; role: "viewer" | "admin"; active: number };
type Session = Account & {
	tokenHash: string;
	csrfHash: string;
	expiresAt: number;
	licenceVersion: string | null;
};
type AccessIdentity = { sub: string; email: string; exp: number; raw: string; payload: JWTPayload };

const COOKIE = "photo_gallery_session";
const MAX_BODY = 128_000;
const OTP_TTL = 10 * 60 * 1000;
const OTP_RESEND = 60 * 1000;
const ATTENDEE_SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const DOWNLOAD_RETENTION = 90 * 24 * 60 * 60 * 1000;
const CASE_HISTORY_RETENTION = 365 * 24 * 60 * 60 * 1000;
const REPORT_ACCOUNT_LIMIT = 30;
const REPORT_PHOTO_LIMIT = 5;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const securityHeaders: Record<string, string> = {
	"Cache-Control": "private, no-store",
	"X-Content-Type-Options": "nosniff",
	"X-Robots-Tag": "noindex, nofollow, noarchive",
	"Referrer-Policy": "no-referrer",
	"Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
	const merged = new Headers(securityHeaders);
	merged.set("Content-Type", "application/json; charset=utf-8");
	if (headers) new Headers(headers).forEach((v, k) => merged.set(k, v));
	return new Response(JSON.stringify(value), { status, headers: merged });
}

function error(message: string, status: number): Response {
	return json({ error: message }, status);
}

class BadRequestError extends Error {
	constructor() {
		super("invalid request");
		this.name = "BadRequestError";
	}
}

class AccessAuthenticationError extends Error {
	constructor() {
		super("administrator authentication required");
		this.name = "AccessAuthenticationError";
	}
}

function requireSecret(value: string | undefined): string {
	if (!value || value.length < 32) throw new Error("missing secret");
	return value;
}

function randomBytes(size: number): Uint8Array {
	const bytes = new Uint8Array(size);
	crypto.getRandomValues(bytes);
	return bytes;
}

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function randomToken(size = 32): string {
	return base64url(randomBytes(size));
}

function normalizeEmail(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const email = value.trim().toLowerCase();
	if (email.length < 3 || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
	return email;
}

function language(value: unknown): "en" | "fr" {
	return value === "fr" ? "fr" : "en";
}

async function hmac(secret: string, value: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(requireSecret(secret)),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}

async function digest(value: string): Promise<string> {
	return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

async function equalSecret(left: string, right: string): Promise<boolean> {
	const [a, b] = await Promise.all([
		crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
		crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)),
	]);
	const av = new Uint8Array(a);
	const bv = new Uint8Array(b);
	let result = 0;
	for (let i = 0; i < av.length; i += 1) result |= av[i] ^ bv[i];
	return result === 0;
}

async function boundedJson(request: Request): Promise<Record<string, unknown>> {
	if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new BadRequestError();
	const reader = request.body?.getReader();
	if (!reader) throw new BadRequestError();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			length += next.value.byteLength;
			if (length > MAX_BODY) {
				await reader.cancel();
				throw new BadRequestError();
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new BadRequestError();
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequestError();
	return value as Record<string, unknown>;
}

function sameOrigin(request: Request, url: URL): boolean {
	return request.headers.get("origin") === url.origin && request.headers.get("sec-fetch-site") !== "cross-site";
}

function sameSite(request: Request, url: URL): boolean {
	const origin = request.headers.get("origin");
	return (!origin || origin === url.origin) && request.headers.get("sec-fetch-site") !== "cross-site";
}

function parseCookies(request: Request): Record<string, string> {
	const output: Record<string, string> = {};
	for (const part of request.headers.get("cookie")?.split(";") ?? []) {
		const index = part.indexOf("=");
		if (index <= 0) continue;
		try {
			output[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
		} catch {
			// A malformed client cookie is equivalent to an invalid credential.
		}
	}
	return output;
}

function cookie(value: string, maxAge: number): string {
	return `${COOKIE}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

function clearCookie(): string {
	return `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

function photoId(value: string | undefined): boolean {
	return !!value && ID_RE.test(value);
}

function requestId(value: unknown): string | null {
	return typeof value === "string" && UUID_RE.test(value) ? value.toLowerCase() : null;
}

function configuredOrigin(env: Env): string | null {
	const configured = String(env.APP_ORIGIN).trim();
	if (!configured) return null;
	try {
		return new URL(configured).origin;
	} catch {
		return null;
	}
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

async function accountForEmail(env: Env, email: string): Promise<Account | null> {
	return env.DB.prepare("SELECT id,email,role,active FROM accounts WHERE email_hash=? AND active=1 LIMIT 1")
		.bind(await hmac(env.OTP_HMAC_SECRET, email))
		.first<Account>();
}

async function currentLicence(env: Env): Promise<string> {
	const row = await env.DB.prepare(
		"SELECT version FROM licence_versions WHERE current=1 ORDER BY created_at DESC LIMIT 1",
	).first<{ version: string }>();
	const configured = String(env.CURRENT_LICENCE_VERSION ?? "").trim();
	if (!row?.version || !configured || row.version !== configured) throw new Error("licence configuration mismatch");
	return row.version;
}

async function sessionForRequest(request: Request, env: Env): Promise<Session | null> {
	const token = parseCookies(request)[COOKIE];
	if (!token) return null;
	const tokenHash = await hmac(env.SESSION_HMAC_SECRET, token);
	const row = await env.DB.prepare(
		"SELECT s.token_hash as tokenHash,s.csrf_hash as csrfHash,s.expires_at as expiresAt,s.licence_version as licenceVersion,a.id,a.email,a.role,a.active FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.revoked_at IS NULL LIMIT 1",
	)
		.bind(tokenHash)
		.first<Session>();
	if (!row || !row.active || row.expiresAt <= Date.now()) return null;
	return row;
}

async function attendeeSession(request: Request, env: Env): Promise<{ session: Session; token: string } | null> {
	const session = await sessionForRequest(request, env);
	if (!session) return null;
	const token = parseCookies(request)[COOKIE];
	return token ? { session, token } : null;
}

async function requireCsrf(request: Request, env: Env, session: Session): Promise<boolean> {
	const supplied = request.headers.get("x-csrf-token");
	return !!supplied && (await equalSecret(await hmac(env.SESSION_HMAC_SECRET, supplied), session.csrfHash));
}

async function issueOtp(email: string): Promise<string> {
	const max = Math.floor(0xffffffff / 100000000) * 100000000;
	let number: number;
	do number = new DataView(randomBytes(4).buffer).getUint32(0);
	while (number >= max);
	return String(number % 100000000).padStart(8, "0");
}

async function sendSes(env: Env, to: string[], subject: string, text: string, html?: string): Promise<void> {
	if (!env.SES_REGION || !env.SES_FROM_EMAIL || !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY)
		throw new Error("SES is not configured");
	const body = new URLSearchParams({
		Action: "SendEmail",
		Version: "2010-12-01",
		Source: env.SES_FROM_EMAIL,
		"Message.Subject.Data": subject,
		"Message.Subject.Charset": "UTF-8",
		"Message.Body.Text.Data": text,
		"Message.Body.Text.Charset": "UTF-8",
		...(html ? { "Message.Body.Html.Data": html, "Message.Body.Html.Charset": "UTF-8" } : {}),
	});
	for (const [index, address] of to.entries()) body.set(`Destination.ToAddresses.member.${index + 1}`, address);
	const client = new AwsClient({
		accessKeyId: env.AWS_ACCESS_KEY_ID,
		secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
		region: env.SES_REGION,
		service: "ses",
	});
	const response = await client.fetch(`https://email.${env.SES_REGION}.amazonaws.com/`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
		body: body.toString(),
	});
	if (!response.ok) throw new Error(`SES ${response.status}`);
}

async function processOutbox(env: Env): Promise<void> {
	if (!env.SES_REGION || !env.SES_FROM_EMAIL || !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) return;
	const now = Date.now();
	const rows = await env.DB.prepare(
		"SELECT id,kind,payload_json as payloadJson,attempts FROM notification_outbox WHERE sent_at IS NULL AND available_at<=? AND (locked_until IS NULL OR locked_until<?) AND (kind='removal' OR created_at>?) ORDER BY created_at LIMIT 10",
	)
		.bind(now, now, now - OTP_TTL)
		.all<{ id: string; kind: string; payloadJson: string; attempts: number }>();
	for (const row of rows.results) {
		const lock = await env.DB.prepare(
			"UPDATE notification_outbox SET locked_until=? WHERE id=? AND sent_at IS NULL AND (locked_until IS NULL OR locked_until<?) RETURNING id",
		)
			.bind(now + 60_000, row.id, now)
			.first<{ id: string }>();
		if (!lock) continue;
		try {
			let payload = JSON.parse(row.payloadJson) as {
				caseId?: string;
				to: string | string[];
				subject: string;
				text: string;
				html?: string;
			};
			if (row.kind === "removal" && payload.caseId) {
				const hydrated = await removalNotification(env, payload.caseId);
				if (!hydrated) {
					await env.DB.prepare(
						"UPDATE notification_outbox SET sent_at=?,payload_json='{}',locked_until=NULL,last_error=NULL WHERE id=?",
					)
						.bind(Date.now(), row.id)
						.run();
					continue;
				}
				payload = hydrated;
			}
			const recipients = Array.isArray(payload.to)
				? payload.to
				: payload.to
						.split(",")
						.map(value => value.trim())
						.filter(Boolean);
			if (!recipients.length) throw new Error("SES recipients are not configured");
			await sendSes(env, recipients, payload.subject, payload.text, payload.html);
			// OTP and removal payloads contain personal data. Keep delivery status for
			// diagnostics, but erase the body as soon as the message is accepted.
			await env.DB.prepare(
				"UPDATE notification_outbox SET sent_at=?,payload_json='{}',locked_until=NULL,last_error=NULL WHERE id=?",
			)
				.bind(Date.now(), row.id)
				.run();
		} catch (caught) {
			const attempt = row.attempts + 1;
			const delay = Math.min(24 * 60 * 60 * 1000, 60_000 * 2 ** Math.min(attempt, 10));
			await env.DB.prepare(
				"UPDATE notification_outbox SET attempts=?,available_at=?,locked_until=NULL,last_error=? WHERE id=?",
			)
				.bind(
					attempt,
					Date.now() + delay,
					caught instanceof Error ? caught.message.slice(0, 200) : "send_failed",
					row.id,
				)
				.run();
		}
	}
}

async function removalNotification(
	env: Env,
	caseId: string,
): Promise<{
	to: string;
	subject: string;
	text: string;
	html: string;
} | null> {
	const row = await env.DB.prepare(
		"SELECT c.id,c.photo_id as photoId,p.filename,p.category,p.version FROM removal_cases c JOIN photos p ON p.id=c.photo_id WHERE c.id=? AND c.status='pending' LIMIT 1",
	)
		.bind(caseId)
		.first<{ id: string; photoId: string; filename: string; category: string; version: number }>();
	if (!row) return null;
	const reports = await env.DB.prepare(
		"SELECT explanation FROM removal_reports WHERE case_id=? AND status='pending' ORDER BY created_at,id",
	)
		.bind(caseId)
		.all<{ explanation: string }>();
	const reasons = reports.results.map(report => report.explanation.trim()).filter(Boolean);
	const origin = configuredOrigin(env);
	const reviewUrl = `${origin ?? ""}/restore?case=${encodeURIComponent(caseId)}&version=${encodeURIComponent(String(row.version))}`;
	const reasonText = reasons.length ? reasons.join("\n\n") : "(No reason supplied.)";
	const reasonHtml = reasons.length
		? reasons.map(reason => `<p>${escapeHtml(reason)}</p>`).join("")
		: "<p>(No reason supplied.)</p>";
	const subject = `Photo removal request / Demande de retrait ${caseId}`;
	return {
		to: String(env.MODERATOR_EMAILS),
		subject,
		text: `Photo removal request / Demande de retrait\nCase / Dossier: ${caseId}\nPhoto / Photo: ${row.filename}\nCategory / Catégorie: ${row.category}\nReason / Motif:\n${reasonText}\nRestore / Restaurer: ${reviewUrl}`,
		html: `<p>Photo removal request / Demande de retrait</p><p>Case / Dossier: <strong>${escapeHtml(caseId)}</strong></p><p>Photo / Photo: ${escapeHtml(row.filename)}</p><p>Category / Catégorie: ${escapeHtml(row.category)}</p><p>Reason / Motif:</p>${reasonHtml}<p><a href="${escapeHtml(reviewUrl)}">Restore photo / Restaurer la photo</a></p>`,
	};
}

async function accessIdentity(request: Request, env: Env): Promise<AccessIdentity> {
	try {
		const teamSetting = String(env.ACCESS_TEAM);
		const audience = String(env.ACCESS_AUD);
		if (!teamSetting || !audience) throw new Error("access not configured");
		const raw = request.headers.get("cf-access-jwt-assertion") ?? parseCookies(request).CF_Authorization;
		if (!raw) throw new Error("access token");
		const team = teamSetting.replace(/\/$/, "");
		const jwks = createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`));
		const verified = await jwtVerify(raw, jwks, { issuer: team, audience, algorithms: ["RS256"] });
		const email = normalizeEmail(verified.payload.email);
		const sub = typeof verified.payload.sub === "string" ? verified.payload.sub : null;
		if (
			!email ||
			!sub ||
			!email.endsWith("@ctn-rtc.org") ||
			!verified.payload.exp ||
			verified.payload.exp * 1000 <= Date.now()
		)
			throw new Error("access identity");
		// The Google-only identity-provider policy is enforced by the Cloudflare Access
		// application. Access JWTs do not expose one stable provider claim, so the
		// Worker relies on the signed issuer/audience/domain/expiry checks above.
		return { sub, email, exp: verified.payload.exp, raw, payload: verified.payload };
	} catch {
		throw new AccessAuthenticationError();
	}
}

async function adminCsrf(identity: AccessIdentity, env: Env): Promise<string> {
	return hmac(env.SESSION_HMAC_SECRET, `admin:${identity.sub}:${identity.exp}:${String(env.ACCESS_AUD)}`);
}

async function requireAdminCsrf(request: Request, identity: AccessIdentity, env: Env): Promise<boolean> {
	const supplied = request.headers.get("x-csrf-token");
	return !!supplied && (await equalSecret(supplied, await adminCsrf(identity, env)));
}

async function album(env: Env): Promise<Response> {
	const version = await currentLicence(env);
	const photos = await env.DB.prepare(
		"SELECT p.id,p.category,p.filename,p.version,p.width,p.height,t.width as thumbnailWidth,t.height as thumbnailHeight,t.bytes as thumbnailBytes,pr.width as previewWidth,pr.height as previewHeight,pr.bytes as previewBytes,f.width as fullWidth,f.height as fullHeight,f.bytes as fullBytes,q.width as quickWidth,q.height as quickHeight,q.bytes as quickBytes FROM photos p JOIN photo_variants t ON t.photo_id=p.id AND t.format='thumbnail' JOIN photo_variants pr ON pr.photo_id=p.id AND pr.format='preview' JOIN photo_variants f ON f.photo_id=p.id AND f.format='full' LEFT JOIN photo_variants q ON q.photo_id=p.id AND q.format='quick' WHERE p.status='published' ORDER BY p.category,p.filename",
	).all<Record<string, string | number>>();
	const activityRows = await env.DB.prepare(
		"SELECT photo_id as photoId,COALESCE(SUM(CASE WHEN day>=date('now','-90 day') THEN opens ELSE 0 END),0) as views,COALESCE(SUM(CASE WHEN day>=date('now','-90 day') THEN downloads ELSE 0 END),0) as downloadRequests FROM daily_aggregates GROUP BY photo_id",
	).all<{ photoId: string; views: number; downloadRequests: number }>();
	const activityByPhoto = new Map(
		activityRows.results.map(row => [
			row.photoId,
			{ views: Number(row.views), downloadRequests: Number(row.downloadRequests) },
		]),
	);
	const activity = { views: 0, downloadRequests: 0 };
	return json({
		version,
		photos: photos.results.map(row => {
			const photoActivity = activityByPhoto.get(String(row.id)) ?? { views: 0, downloadRequests: 0 };
			activity.views += photoActivity.views;
			activity.downloadRequests += photoActivity.downloadRequests;
			return {
				id: row.id,
				category: row.category,
				filename: row.filename,
				version: String(row.version),
				width: row.width,
				height: row.height,
				thumbnail: {
					url: `/api/photos/${row.id}/thumbnail`,
					width: row.thumbnailWidth,
					height: row.thumbnailHeight,
					bytes: row.thumbnailBytes,
				},
				preview: {
					url: `/api/photos/${row.id}/preview`,
					width: row.previewWidth,
					height: row.previewHeight,
					bytes: row.previewBytes,
				},
				downloads: {
					full: { width: row.fullWidth, height: row.fullHeight, bytes: row.fullBytes },
					quick: {
						width: row.quickWidth ?? row.previewWidth,
						height: row.quickHeight ?? row.previewHeight,
						bytes: row.quickBytes ?? row.previewBytes,
					},
				},
				activity: photoActivity,
			};
		}),
		activity,
	});
}

async function imageResponse(
	request: Request,
	env: Env,
	id: string,
	format: "thumbnail" | "preview",
): Promise<Response> {
	const row = await env.DB.prepare(
		"SELECT p.id,p.status,p.filename,v.object_key as objectKey,v.content_type as contentType,v.bytes,v.sha256 FROM photos p JOIN photo_variants v ON v.photo_id=p.id AND v.format=? WHERE p.id=? AND p.status='published' LIMIT 1",
	)
		.bind(format, id)
		.first<{
			id: string;
			status: string;
			filename: string;
			objectKey: string;
			contentType: string;
			bytes: number;
			sha256: string | null;
		}>();
	if (!row) return error("Not found.", 404);
	const object = await env.PHOTO_BUCKET.get(row.objectKey);
	if (!object?.body) return error("Not found.", 404);
	const headers = new Headers({
		...securityHeaders,
		"Content-Type": row.contentType || "image/jpeg",
		"Content-Length": String(row.bytes),
		"Cache-Control": "private, max-age=60, must-revalidate",
	});
	if (row.sha256) headers.set("ETag", `"${row.sha256}"`);
	if (
		request.headers.get("if-none-match") &&
		row.sha256 &&
		request.headers.get("if-none-match") === `"${row.sha256}"`
	)
		return new Response(null, { status: 304, headers });
	return new Response(object.body, { headers });
}

function rangeHeader(value: string | null, size: number): { start: number; end: number } | null {
	if (!value || !value.startsWith("bytes=") || value.includes(",")) return null;
	const [startText, endText] = value.slice(6).split("-");
	if (!startText && !endText) return null;
	const suffix = !startText ? Number(endText) : null;
	if (suffix !== null) {
		if (!Number.isInteger(suffix) || suffix <= 0) return null;
		return { start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(startText);
	const end = endText ? Number(endText) : size - 1;
	if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) return null;
	return { start, end: Math.min(end, size - 1) };
}

async function downloadResponse(request: Request, env: Env, id: string): Promise<Response> {
	const sessionResult = await attendeeSession(request, env);
	if (!sessionResult) return error("Authentication required.", 401);
	const current = await currentLicence(env);
	if (sessionResult.session.licenceVersion !== current)
		return error("Please acknowledge the current licence before downloading.", 428);
	const format = new URL(request.url).searchParams.get("format");
	if (format !== "full" && format !== "quick") return error("Invalid download format.", 400);
	const reqId = requestId(new URL(request.url).searchParams.get("requestId"));
	if (!reqId) return error("A valid requestId is required.", 400);
	const row = await env.DB.prepare(
		"SELECT p.id,p.version,p.filename,p.status,v.object_key as objectKey,v.content_type as contentType,v.bytes,v.sha256 FROM photos p JOIN photo_variants v ON v.photo_id=p.id AND v.format=? WHERE p.id=? AND p.status='published' LIMIT 1",
	)
		.bind(format, id)
		.first<{
			id: string;
			version: number;
			filename: string;
			status: string;
			objectKey: string;
			contentType: string;
			bytes: number;
			sha256: string | null;
		}>();
	if (!row) return error("Not found.", 404);
	const requestedRange = request.headers.get("range");
	const etag = row.sha256 ? `"${row.sha256}"` : `"${row.version}-${row.bytes}"`;
	const ifRange = request.headers.get("if-range");
	const useRange = requestedRange && (!ifRange || ifRange === etag);
	const range = useRange ? rangeHeader(requestedRange, row.bytes) : null;
	if (requestedRange && useRange && !range)
		return new Response(null, {
			status: 416,
			headers: { ...securityHeaders, "Content-Range": `bytes */${row.bytes}` },
		});
	const prior = await env.DB.prepare(
		"SELECT account_id as accountId,photo_id as photoId,format,photo_version as photoVersion FROM download_requests WHERE request_id=? LIMIT 1",
	)
		.bind(reqId)
		.first<{ accountId: string; photoId: string; format: string; photoVersion: number }>();
	if (prior && (prior.accountId !== sessionResult.session.id || prior.photoId !== id || prior.format !== format))
		return error("That requestId is already bound to another download.", 409);
	const object = await env.PHOTO_BUCKET.get(
		row.objectKey,
		range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined,
	);
	if (!object?.body) return error("Not found.", 404);
	const publication = await env.DB.prepare("SELECT status FROM photos WHERE id=? LIMIT 1")
		.bind(id)
		.first<{ status: string }>();
	if (!publication || publication.status !== "published") return error("Not found.", 404);
	const inserted = await env.DB.prepare(
		"INSERT OR IGNORE INTO download_requests(request_id,account_id,photo_id,photo_version,format,created_at) VALUES(?,?,?,?,?,?)",
	)
		.bind(reqId, sessionResult.session.id, id, row.version, format, Date.now())
		.run();
	if (!inserted.meta.changes) {
		const binding = await env.DB.prepare(
			"SELECT account_id as accountId,photo_id as photoId,format FROM download_requests WHERE request_id=? LIMIT 1",
		)
			.bind(reqId)
			.first<{ accountId: string; photoId: string; format: string }>();
		if (
			!binding ||
			binding.accountId !== sessionResult.session.id ||
			binding.photoId !== id ||
			binding.format !== format
		)
			return error("That requestId is already bound to another download.", 409);
	}
	if (inserted.meta.changes > 0) {
		const day = new Date().toISOString().slice(0, 10);
		const full = format === "full" ? 1 : 0;
		const quick = format === "quick" ? 1 : 0;
		await env.DB.prepare(
			"INSERT INTO daily_aggregates(day,photo_id,downloads,full_downloads,quick_downloads) VALUES(?,?,1,?,?) ON CONFLICT(day,photo_id) DO UPDATE SET downloads=downloads+1,full_downloads=full_downloads+excluded.full_downloads,quick_downloads=quick_downloads+excluded.quick_downloads",
		)
			.bind(day, id, full, quick)
			.run();
	}
	const headers = new Headers({
		...securityHeaders,
		"Cache-Control": "private, no-store",
		"Content-Type": row.contentType || "image/jpeg",
		"Content-Disposition": `attachment; filename="${row.filename.replace(/[\"\r\n]/g, "_")}"`,
		"Accept-Ranges": "bytes",
		ETag: etag,
	});
	if (range) {
		headers.set("Content-Length", String(range.end - range.start + 1));
		headers.set("Content-Range", `bytes ${range.start}-${range.end}/${row.bytes}`);
		return new Response(object.body, { status: 206, headers });
	}
	headers.set("Content-Length", String(row.bytes));
	return new Response(object.body, { headers });
}

async function removal(request: Request, env: Env, id: string, ctx: ExecutionContext): Promise<Response> {
	const sessionResult = await attendeeSession(request, env);
	if (!sessionResult) return error("Authentication required.", 401);
	if (!(await requireCsrf(request, env, sessionResult.session))) return error("Invalid CSRF token.", 403);
	const body = await boundedJson(request);
	if (body.albumVisit !== undefined && typeof body.albumVisit !== "boolean") return error("Invalid albumVisit.", 400);
	const explanation = typeof body.explanation === "string" ? body.explanation.trim() : "";
	const reqId = requestId(body.requestId);
	if (!explanation || explanation.length > 2000 || !reqId)
		return error("A nonblank explanation and valid requestId are required.", 400);
	const photo = await env.DB.prepare("SELECT id,category,filename,status,version FROM photos WHERE id=? LIMIT 1")
		.bind(id)
		.first<{ id: string; category: string; filename: string; status: string; version: number }>();
	if (!photo) return error("Not found.", 404);
	const caseId = (await digest(`case:${sessionResult.session.id}:${id}:${reqId}`)).slice(0, 42);
	const existing = await env.DB.prepare(
		"SELECT case_id as caseId FROM removal_reports WHERE photo_id=? AND requester_account_id=? AND request_id=? LIMIT 1",
	)
		.bind(id, sessionResult.session.id, reqId)
		.first<{ caseId: string }>();
	if (existing) return json({ caseId: existing.caseId }, 202);
	const outboxId = (await digest(`outbox:${caseId}`)).slice(0, 42);
	const now = Date.now();
	const reviewOrigin = configuredOrigin(env);
	const reviewUrl = `${reviewOrigin ?? ""}/restore?case=${encodeURIComponent(caseId)}&version=${encodeURIComponent(String(photo.version + 1))}`;
	const reportId = await digest(`report:${caseId}`);
	const outboxPayload = JSON.stringify({
		to: String(env.MODERATOR_EMAILS),
		subject: `Photo removal request / Demande de retrait ${caseId}`,
		caseId,
		text: `Photo removal request / Demande de retrait\nCase / Dossier: ${caseId}\nPhoto / Photo: ${photo.filename}\nCategory / Catégorie: ${photo.category}\nReason / Motif:\n${explanation}\nRestore / Restaurer: ${reviewUrl}`,
		html: `<p>Photo removal request / Demande de retrait <strong>${escapeHtml(caseId)}</strong></p><p>Photo / Photo: ${escapeHtml(photo.filename)}</p><p>Category / Catégorie: ${escapeHtml(photo.category)}</p><p>Reason / Motif:</p><p>${escapeHtml(explanation)}</p><p><a href=\"${escapeHtml(reviewUrl)}\">Restore photo / Restaurer la photo</a></p>`,
	});
	const hourAgo = now - 60 * 60 * 1000;
	// The conditional INSERT is the quota gate. It runs in the same D1 batch as
	// report creation, so parallel requests cannot both pass a pre-count.
	const results = await env.DB.batch([
		env.DB.prepare(
			"INSERT OR IGNORE INTO removal_cases(id,photo_id,requester_account_id,explanation,status,photo_version,cross_channel_reviewed,created_at,updated_at) SELECT ?,?,?,?,'pending',?,0,?,? WHERE (SELECT COUNT(*) FROM removal_reports WHERE requester_account_id=? AND created_at>=?) < ? AND (SELECT COUNT(*) FROM removal_reports WHERE requester_account_id=? AND photo_id=? AND created_at>=?) < ?",
		).bind(
			caseId,
			id,
			sessionResult.session.id,
			explanation,
			photo.version + 1,
			now,
			now,
			sessionResult.session.id,
			hourAgo,
			REPORT_ACCOUNT_LIMIT,
			sessionResult.session.id,
			id,
			hourAgo,
			REPORT_PHOTO_LIMIT,
		),
		env.DB.prepare(
			"INSERT OR IGNORE INTO removal_reports(id,case_id,photo_id,requester_account_id,explanation,request_id,status,photo_version,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM removal_cases WHERE id=? AND status='pending')",
		).bind(
			reportId,
			caseId,
			id,
			sessionResult.session.id,
			explanation,
			reqId,
			"pending",
			photo.version + 1,
			now,
			caseId,
		),
		env.DB.prepare(
			"INSERT OR IGNORE INTO notification_outbox(id,kind,payload_json,attempts,available_at,created_at) SELECT ?,'removal',?,0,?,? WHERE EXISTS (SELECT 1 FROM removal_reports WHERE id=? AND status='pending')",
		).bind(outboxId, outboxPayload, now, now, reportId),
	]);
	if (!results[1]?.meta.changes) {
		const raced = await env.DB.prepare(
			"SELECT case_id as caseId FROM removal_reports WHERE photo_id=? AND requester_account_id=? AND request_id=? LIMIT 1",
		)
			.bind(id, sessionResult.session.id, reqId)
			.first<{ caseId: string }>();
		if (raced) return json({ caseId: raced.caseId }, 202);
		return error("Removal request limit reached. Please try again later.", 429);
	}
	ctx.waitUntil(processOutbox(env));
	return json({ caseId }, 202);
}

async function events(request: Request, env: Env): Promise<Response> {
	const sessionResult = await attendeeSession(request, env);
	if (!sessionResult) return error("Authentication required.", 401);
	if (!(await requireCsrf(request, env, sessionResult.session))) return error("Invalid CSRF token.", 403);
	const body = await boundedJson(request);
	if (
		!Array.isArray(body.photoIds) ||
		body.photoIds.length > 50 ||
		body.photoIds.some(id => !photoId(typeof id === "string" ? id : undefined))
	)
		return error("Invalid photoIds.", 400);
	const now = Date.now();
	const viewerKey = await hmac(env.SESSION_HMAC_SECRET, `viewer-session:${sessionResult.session.tokenHash}`);
	const statements: D1PreparedStatement[] = [];
	for (const id of [...new Set(body.photoIds as string[])]) {
		const inserted = await env.DB.prepare(
			"INSERT OR IGNORE INTO viewer_opens(photo_id,session_key,opened_at) SELECT id,?,? FROM photos WHERE id=? AND status='published'",
		)
			.bind(viewerKey, now, id)
			.run();
		if (inserted.meta.changes > 0)
			statements.push(
				env.DB.prepare(
					"INSERT INTO daily_aggregates(day,photo_id,opens) VALUES(?,?,1) ON CONFLICT(day,photo_id) DO UPDATE SET opens=opens+1",
				).bind(new Date(now).toISOString().slice(0, 10), id),
			);
	}
	if (statements.length) await env.DB.batch(statements);
	if (body.albumVisit === true)
		await env.DB.prepare(
			"INSERT INTO album_visits(day,visits) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET visits=visits+1",
		)
			.bind(new Date(now).toISOString().slice(0, 10))
			.run();
	return json({ accepted: true });
}

async function restoreCase(request: Request, env: Env, identity: AccessIdentity, caseId: string): Promise<Response> {
	const versionValue = new URL(request.url).searchParams.get("version");
	const version = versionValue && /^\d+$/.test(versionValue) ? Number(versionValue) : Number.NaN;
	if (!Number.isSafeInteger(version) || version < 1) return error("Invalid version.", 400);
	const row = await env.DB.prepare(
		"SELECT c.id,c.status,c.photo_id as photoId,p.filename,p.version as photoVersion,p.status as photoStatus FROM removal_cases c JOIN photos p ON p.id=c.photo_id WHERE c.id=? LIMIT 1",
	)
		.bind(caseId)
		.first<{
			id: string;
			status: string;
			photoId: string;
			filename: string;
			photoVersion: number;
			photoStatus: string;
		}>();
	if (!row) return error("Not found.", 404);
	const blockers = await env.DB.prepare(
		"SELECT (SELECT COUNT(*) FROM removal_reports WHERE photo_id=? AND status='pending' AND case_id<>?) as reportCount,(SELECT COUNT(*) FROM removal_cases WHERE photo_id=? AND status='pending' AND id<>?) as caseCount",
	)
		.bind(row.photoId, caseId, row.photoId, caseId)
		.first<{ reportCount: number; caseCount: number }>();
	const canRestore =
		row.status === "pending" &&
		row.photoStatus === "quarantined" &&
		row.photoVersion === version &&
		Number(blockers?.reportCount ?? 0) === 0 &&
		Number(blockers?.caseCount ?? 0) === 0;
	return json({
		filename: row.filename,
		canRestore,
		photoVersion: row.photoVersion,
		csrfToken: await adminCsrf(identity, env),
		status: row.status,
	});
}

async function restoreCaseAction(
	request: Request,
	env: Env,
	identity: AccessIdentity,
	caseId: string,
): Promise<Response> {
	if (!(await requireAdminCsrf(request, identity, env)) || !sameOrigin(request, new URL(request.url)))
		return error("Invalid CSRF token.", 403);
	const body = await boundedJson(request);
	const expectedVersion = typeof body.expectedVersion === "number" ? body.expectedVersion : Number.NaN;
	if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return error("Invalid version.", 400);
	const row = await env.DB.prepare(
		"SELECT c.photo_id as photoId,c.status,p.version as photoVersion,p.status as photoStatus FROM removal_cases c JOIN photos p ON p.id=c.photo_id WHERE c.id=? LIMIT 1",
	)
		.bind(caseId)
		.first<{ photoId: string; status: string; photoVersion: number; photoStatus: string }>();
	if (!row) return error("Not found.", 404);
	if (row.status !== "pending" || row.photoStatus !== "quarantined" || row.photoVersion !== expectedVersion)
		return error("The restoration link is no longer current.", 409);
	const blockers = await env.DB.prepare(
		"SELECT (SELECT COUNT(*) FROM removal_reports WHERE photo_id=? AND status='pending' AND case_id<>?) as reportCount,(SELECT COUNT(*) FROM removal_cases WHERE photo_id=? AND status='pending' AND id<>?) as caseCount",
	)
		.bind(row.photoId, caseId, row.photoId, caseId)
		.first<{ reportCount: number; caseCount: number }>();
	if (Number(blockers?.reportCount ?? 0) !== 0 || Number(blockers?.caseCount ?? 0) !== 0)
		return error("Another pending removal request must be resolved first.", 409);
	const operationId = crypto.randomUUID();
	const now = Date.now();
	const fixedReason = "Restoration approved from removal notification";
	const results = await env.DB.batch([
		env.DB.prepare(
			"UPDATE photos SET status='published',version=version+1,moderation_operation_id=?,updated_at=? WHERE id=? AND version=? AND status='quarantined' AND EXISTS (SELECT 1 FROM removal_cases WHERE id=? AND status='pending') AND EXISTS (SELECT 1 FROM removal_reports WHERE case_id=? AND status='pending') AND NOT EXISTS (SELECT 1 FROM removal_reports WHERE photo_id=? AND status='pending' AND case_id<>?) AND NOT EXISTS (SELECT 1 FROM removal_cases WHERE photo_id=? AND status='pending' AND id<>?)",
		).bind(
			operationId,
			now,
			row.photoId,
			expectedVersion,
			caseId,
			caseId,
			row.photoId,
			caseId,
			row.photoId,
			caseId,
		),
		env.DB.prepare(
			"UPDATE removal_reports SET status='dismissed',resolved_at=? WHERE case_id=? AND status='pending' AND EXISTS (SELECT 1 FROM photos WHERE id=? AND status='published' AND version=? AND moderation_operation_id=?)",
		).bind(now, caseId, row.photoId, expectedVersion + 1, operationId),
		env.DB.prepare(
			"UPDATE removal_cases SET status='dismissed',moderation_operation_id=?,updated_at=? WHERE id=? AND status='pending' AND EXISTS (SELECT 1 FROM photos WHERE id=? AND status='published' AND version=? AND moderation_operation_id=?)",
		).bind(operationId, now, caseId, row.photoId, expectedVersion + 1, operationId),
		env.DB.prepare(
			"INSERT INTO moderation_audit(id,actor_account_id,action,case_id,photo_id,reason,expected_version,created_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM removal_cases WHERE id=? AND status='dismissed' AND moderation_operation_id=? AND EXISTS (SELECT 1 FROM photos WHERE id=? AND status='published' AND version=? AND moderation_operation_id=?))",
		).bind(
			crypto.randomUUID(),
			identity.sub,
			"restore",
			caseId,
			row.photoId,
			fixedReason,
			expectedVersion,
			now,
			caseId,
			operationId,
			row.photoId,
			expectedVersion + 1,
			operationId,
		),
	]);
	if (
		!results[0]?.meta.changes ||
		!results[1]?.meta.changes ||
		!results[2]?.meta.changes ||
		!results[3]?.meta.changes
	)
		return error("The restoration link is no longer current.", 409);
	return json({ restored: true, status: "dismissed", version: expectedVersion + 1 });
}

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	if (request.method === "OPTIONS") return error("Method not allowed.", 405);

	if (url.pathname === "/api/auth/session" && request.method === "GET") {
		const session = await sessionForRequest(request, env);
		if (!session) return json({ authenticated: false });
		return json({
			authenticated: true,
			csrfToken: await hmac(env.SESSION_HMAC_SECRET, `${session.tokenHash}:${session.expiresAt}`),
			accountId: session.id,
			administrator: false,
			licenceVersion: session.licenceVersion ?? undefined,
			expiresAt: session.expiresAt,
		});
	}
	if (url.pathname === "/api/auth/request" && request.method === "POST") {
		if (!sameOrigin(request, url)) return error("Same-origin request required.", 403);
		try {
			const body = await boundedJson(request);
			const email = normalizeEmail(body.email);
			if (!email) return json({ accepted: true }, 202);
			const account = await accountForEmail(env, email);
			const emailHash = await hmac(env.OTP_HMAC_SECRET, email);
			const ipHash = await hmac(env.OTP_HMAC_SECRET, request.headers.get("cf-connecting-ip") ?? "unknown-ip");
			const code = await issueOtp(email);
			const now = Date.now();
			const challengeId = crypto.randomUUID();
			const emailHourAgo = now - 60 * 60 * 1000;
			const ipWindowAgo = now - 10 * 60 * 1000;
			const statements: D1PreparedStatement[] = [
				env.DB.prepare(
					"INSERT INTO code_challenges(id,account_id,email,email_hash,code_hash,language,created_at,expires_at,resend_after,request_ip_hash) SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM code_challenges WHERE email_hash=? AND consumed_at IS NULL AND resend_after>?) AND (SELECT COUNT(*) FROM code_challenges WHERE request_ip_hash=? AND created_at>?) < 10 AND (SELECT COUNT(*) FROM code_challenges WHERE email_hash=? AND created_at>?) < 5",
				).bind(
					challengeId,
					account?.id ?? null,
					email,
					emailHash,
					await hmac(env.OTP_HMAC_SECRET, `${email}:${code}`),
					language(body.language),
					now,
					now + OTP_TTL,
					now + OTP_RESEND,
					ipHash,
					emailHash,
					now,
					ipHash,
					ipWindowAgo,
					emailHash,
					emailHourAgo,
				),
				env.DB.prepare(
					"UPDATE code_challenges SET consumed_at=? WHERE email_hash=? AND consumed_at IS NULL AND id<>? AND EXISTS (SELECT 1 FROM code_challenges WHERE id=? AND consumed_at IS NULL)",
				).bind(now, emailHash, challengeId, challengeId),
			];
			if (account) {
				const french = language(body.language) === "fr";
				const payload = french
					? {
							to: email,
							subject: "Code de connexion à la galerie photo Hack the Hill",
							text: `Votre code de connexion est ${code}. Il expire dans dix minutes.`,
						}
					: {
							to: email,
							subject: "Hack the Hill photo gallery sign-in code",
							text: `Your sign-in code is ${code}. It expires in ten minutes.`,
						};
				statements.push(
					env.DB.prepare(
						"INSERT INTO notification_outbox(id,kind,payload_json,attempts,available_at,created_at) SELECT ?, 'otp', ?, 0, ?, ? WHERE EXISTS (SELECT 1 FROM code_challenges WHERE id=? AND consumed_at IS NULL)",
					).bind(crypto.randomUUID(), JSON.stringify(payload), now, now, challengeId),
				);
			}
			const results = await env.DB.batch(statements);
			if (!results[0]?.meta.changes) return error("Please wait before requesting another code.", 429);
			if (account) ctx.waitUntil(processOutbox(env));
			return json({ accepted: true }, 202);
		} catch (caught) {
			if (caught instanceof BadRequestError) return error("Invalid request.", 400);
			console.error(
				JSON.stringify({
					code: "photo_gallery_auth_request_failed",
					type: caught instanceof Error ? caught.name : "unknown",
				}),
			);
			return error("The request could not be completed.", 500);
		}
	}
	if (url.pathname === "/api/auth/verify" && request.method === "POST") {
		if (!sameOrigin(request, url)) return error("Same-origin request required.", 403);
		try {
			const body = await boundedJson(request);
			const email = normalizeEmail(body.email);
			const code = typeof body.code === "string" && /^\d{8}$/.test(body.code) ? body.code : null;
			if (!email || !code) return error("Invalid code.", 401);
			const emailHash = await hmac(env.OTP_HMAC_SECRET, email);
			const challenge = await env.DB.prepare(
				"SELECT id,account_id,code_hash,expires_at as expiresAt,attempts,consumed_at as consumedAt FROM code_challenges WHERE email_hash=? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1",
			)
				.bind(emailHash)
				.first<{
					id: string;
					account_id: string;
					code_hash: string;
					expiresAt: number;
					attempts: number;
					consumedAt: number | null;
				}>();
			if (!challenge || challenge.expiresAt <= Date.now() || challenge.attempts >= 5)
				return error("Invalid code.", 401);
			const hash = await hmac(env.OTP_HMAC_SECRET, `${email}:${code}`);
			const accepted = await env.DB.prepare(
				"UPDATE code_challenges SET consumed_at=? WHERE id=? AND code_hash=? AND consumed_at IS NULL AND attempts<5 AND expires_at>? RETURNING account_id",
			)
				.bind(Date.now(), challenge.id, hash, Date.now())
				.first<{ account_id: string }>();
			if (!accepted) {
				await env.DB.prepare(
					"UPDATE code_challenges SET attempts=attempts+1 WHERE id=? AND consumed_at IS NULL AND attempts<5",
				)
					.bind(challenge.id)
					.run();
				return error("Invalid code.", 401);
			}
			const account = await env.DB.prepare(
				"SELECT id,email,role,active FROM accounts WHERE id=? AND active=1 LIMIT 1",
			)
				.bind(accepted.account_id)
				.first<Account>();
			if (!account) return error("Invalid code.", 401);
			const rawToken = randomToken();
			const expiresAt = Date.now() + ATTENDEE_SESSION_TTL;
			const tokenHash = await hmac(env.SESSION_HMAC_SECRET, rawToken);
			const csrf = await hmac(env.SESSION_HMAC_SECRET, `${tokenHash}:${expiresAt}`);
			await env.DB.prepare(
				"INSERT INTO sessions(token_hash,account_id,csrf_hash,created_at,expires_at) VALUES(?,?,?,?,?)",
			)
				.bind(tokenHash, account.id, await hmac(env.SESSION_HMAC_SECRET, csrf), Date.now(), expiresAt)
				.run();
			return json(
				{ authenticated: true, csrfToken: csrf, accountId: account.id, administrator: false, expiresAt },
				200,
				{ "Set-Cookie": cookie(rawToken, ATTENDEE_SESSION_TTL / 1000) },
			);
		} catch (caught) {
			if (caught instanceof BadRequestError) return error("Invalid request.", 400);
			console.error(
				JSON.stringify({
					code: "photo_gallery_auth_verify_failed",
					type: caught instanceof Error ? caught.name : "unknown",
				}),
			);
			return error("The request could not be completed.", 500);
		}
	}
	if (url.pathname === "/api/auth/logout" && request.method === "POST") {
		const session = await sessionForRequest(request, env);
		if (session) {
			if (!sameOrigin(request, url) || !(await requireCsrf(request, env, session)))
				return error("Invalid CSRF token.", 403);
			await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE token_hash=?")
				.bind(Date.now(), session.tokenHash)
				.run();
		}
		return json({ accepted: true }, 200, { "Set-Cookie": clearCookie() });
	}
	if (url.pathname === "/api/album" && request.method === "GET") {
		if (!(await attendeeSession(request, env))) return error("Authentication required.", 401);
		return album(env);
	}
	if (url.pathname === "/api/licence/acknowledge" && request.method === "POST") {
		const session = await sessionForRequest(request, env);
		if (!session) return error("Authentication required.", 401);
		if (!(await requireCsrf(request, env, session))) return error("Invalid CSRF token.", 403);
		const body = await boundedJson(request);
		const current = await currentLicence(env);
		if (body.version !== current) return error("That licence version is no longer current.", 409);
		await env.DB.prepare("UPDATE sessions SET licence_version=? WHERE token_hash=? AND revoked_at IS NULL")
			.bind(current, session.tokenHash)
			.run();
		return json({ version: current });
	}
	if (url.pathname === "/api/events" && request.method === "POST") return events(request, env);
	if (/^\/api\/photos\/[^/]+\/removal-requests$/.test(url.pathname) && request.method === "POST") {
		const id = url.pathname.split("/")[3];
		if (!photoId(id)) return error("Not found.", 404);
		return removal(request, env, id, ctx);
	}
	const restoreMatch = url.pathname.match(/^\/api\/restore\/([A-Za-z0-9_-]{1,128})$/);
	if (restoreMatch && (request.method === "GET" || request.method === "POST")) {
		let identity: AccessIdentity;
		try {
			identity = await accessIdentity(request, env);
		} catch (caught) {
			if (caught instanceof AccessAuthenticationError)
				return error("Administrator authentication required.", 403);
			throw caught;
		}
		const caseId = restoreMatch[1];
		return request.method === "GET"
			? restoreCase(request, env, identity, caseId)
			: restoreCaseAction(request, env, identity, caseId);
	}
	if (/^\/api\/photos\/[^/]+\/download$/.test(url.pathname) && request.method === "GET") {
		const id = url.pathname.split("/")[3];
		return id && photoId(id) ? downloadResponse(request, env, id) : error("Not found.", 404);
	}
	const mediaMatch = url.pathname.match(/^\/api\/photos\/([A-Za-z0-9_-]{1,128})\/(thumbnail|preview)$/);
	if (mediaMatch && request.method === "GET") {
		const id = mediaMatch[1];
		const format = mediaMatch[2] as "thumbnail" | "preview";
		if (!(await attendeeSession(request, env))) return error("Authentication required.", 401);
		return imageResponse(request, env, id, format);
	}
	return error("Not found.", 404);
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		try {
			return await handle(request, env, ctx);
		} catch (caught) {
			if (caught instanceof BadRequestError) return error("Invalid request.", 400);
			console.error(
				JSON.stringify({
					code: "photo_gallery_request_failed",
					type: caught instanceof Error ? caught.name : "unknown",
				}),
			);
			return error("The request could not be completed.", 500);
		}
	},
	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(
			(async () => {
				const cutoff = Date.now() - DOWNLOAD_RETENTION;
				const caseCutoff = Date.now() - CASE_HISTORY_RETENTION;
				await env.DB.batch([
					env.DB.prepare("DELETE FROM download_requests WHERE created_at<?").bind(cutoff),
					env.DB.prepare("DELETE FROM viewer_opens WHERE opened_at<?").bind(
						Date.now() - ATTENDEE_SESSION_TTL,
					),
					env.DB.prepare("DELETE FROM sessions WHERE expires_at<? OR revoked_at<?").bind(Date.now(), cutoff),
					env.DB.prepare("DELETE FROM code_challenges WHERE expires_at<? OR consumed_at<?").bind(
						Date.now(),
						cutoff,
					),
					env.DB.prepare("DELETE FROM notification_outbox WHERE kind='otp' AND created_at<?").bind(
						Date.now() - OTP_TTL,
					),
					env.DB.prepare("DELETE FROM notification_outbox WHERE kind='removal' AND created_at<?").bind(
						cutoff,
					),
					env.DB.prepare(
						"DELETE FROM removal_reports WHERE status!='pending' AND resolved_at IS NOT NULL AND resolved_at<?",
					).bind(caseCutoff),
					env.DB.prepare(
						"DELETE FROM removal_cases WHERE status!='pending' AND updated_at<? AND NOT EXISTS (SELECT 1 FROM removal_reports WHERE case_id=removal_cases.id)",
					).bind(caseCutoff),
					env.DB.prepare("DELETE FROM moderation_audit WHERE created_at<?").bind(caseCutoff),
				]);
				await processOutbox(env);
			})(),
		);
	},
} satisfies ExportedHandler<Env>;
