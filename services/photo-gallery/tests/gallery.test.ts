import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { publicHighlights } from "../src/public-highlights";

const email = "attendee@example.org";
const secret = "local-test-secret-that-is-long-enough-123456";

function encoded(value: string | Uint8Array): string {
	const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function accessFixture(overrides: Record<string, unknown> = {}): Promise<{ token: string; restore: () => void }> {
	// Access rotates keys under new key IDs; reusing one ID with a new key is not realistic.
	const kid = `gallery-test-key-${crypto.randomUUID()}`;
	const pair = await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	);
	const publicJwk = {
		...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
		kid,
		alg: "RS256",
		use: "sig",
	};
	const now = Math.floor(Date.now() / 1000);
	const payload = {
		sub: "admin-subject",
		email: "organizer@ctn-rtc.org",
		iat: now,
		exp: now + 3600,
		aud: "gallery-test-audience",
		iss: "https://access.test",
		...overrides,
	};
	const signingInput = `${encoded(JSON.stringify({ alg: "RS256", typ: "JWT", kid }))}.${encoded(JSON.stringify(payload))}`;
	const signature = await crypto.subtle.sign(
		{ name: "RSASSA-PKCS1-v1_5" },
		pair.privateKey,
		new TextEncoder().encode(signingInput),
	);
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const target = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
		if (target === "https://access.test/cdn-cgi/access/certs")
			return new Response(JSON.stringify({ keys: [publicJwk] }), {
				headers: { "content-type": "application/json" },
			});
		return originalFetch(input, init);
	};
	return {
		token: `${signingInput}.${encoded(new Uint8Array(signature))}`,
		restore: () => {
			globalThis.fetch = originalFetch;
		},
	};
}

async function hmac(value: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function requestCode(language: "en" | "fr" = "en"): Promise<string> {
	const response = await SELF.fetch("https://gallery.test/?action=request-code", {
		method: "POST",
		headers: { origin: "https://gallery.test", "content-type": "application/json" },
		body: JSON.stringify({ email, language }),
	});
	expect(response.status).toBe(202);
	const outbox = await env.DB.prepare(
		"SELECT payload_json as payload FROM notification_outbox ORDER BY created_at DESC LIMIT 1",
	).first<{ payload: string }>();
	return (JSON.parse(outbox?.payload ?? "{}") as { text: string }).text.match(/\d{8}/)?.[0] ?? "";
}

async function seed(): Promise<void> {
	await env.DB.batch([
		env.DB.prepare("INSERT INTO accounts(id,email,email_hash,active,created_at) VALUES('acct-1',?,?,1,?)").bind(
			email,
			await hmac(email),
			Date.now(),
		),
		env.DB.prepare(
			"INSERT INTO photos(id,category,filename,version,status,width,height,created_at,updated_at) VALUES('photo-1','Opening','sample.jpg',1,'published',2,2,?,?)",
		).bind(Date.now(), Date.now()),
		env.DB.prepare(
			"INSERT INTO photos(id,category,filename,version,status,width,height,created_at,updated_at) VALUES('photo-2','Closing','second.jpg',1,'published',2,2,?,?)",
		).bind(Date.now(), Date.now()),
		env.DB.prepare(
			"INSERT INTO photo_variants(photo_id,format,object_key,width,height,bytes,content_type) VALUES('photo-1','thumbnail','photo-1/thumb',2,2,4,'image/jpeg'),('photo-1','preview','photo-1/preview',2,2,4,'image/jpeg'),('photo-1','full','photo-1/full',2,2,4,'image/jpeg'),('photo-1','quick','photo-1/quick',2,2,4,'image/jpeg')",
		),
		env.DB.prepare(
			"INSERT INTO photo_variants(photo_id,format,object_key,width,height,bytes,content_type) VALUES('photo-2','thumbnail','photo-2/thumb',2,2,4,'image/jpeg'),('photo-2','preview','photo-2/preview',2,2,4,'image/jpeg'),('photo-2','full','photo-2/full',2,2,4,'image/jpeg'),('photo-2','quick','photo-2/quick',2,2,4,'image/jpeg')",
		),
		env.DB.prepare(
			"INSERT INTO licence_versions(version,en_json,fr_json,current,created_at) VALUES('2026-10-06','[]','[]',1,?)",
		).bind(Date.now()),
	]);
	for (const key of [
		"photo-1/thumb",
		"photo-1/preview",
		"photo-1/full",
		"photo-1/quick",
		"photo-2/thumb",
		"photo-2/preview",
		"photo-2/full",
		"photo-2/quick",
	])
		await env.PHOTO_BUCKET.put(key, new Uint8Array([1, 2, 3, 4]), { httpMetadata: { contentType: "image/jpeg" } });
}

async function reset(): Promise<void> {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM download_requests"),
		env.DB.prepare("DELETE FROM viewer_opens"),
		env.DB.prepare("DELETE FROM daily_aggregates"),
		env.DB.prepare("DELETE FROM notification_outbox"),
		env.DB.prepare("DELETE FROM moderation_audit"),
		env.DB.prepare("DELETE FROM removal_requests"),
		env.DB.prepare("DELETE FROM sessions"),
		env.DB.prepare("DELETE FROM code_challenges"),
		env.DB.prepare("DELETE FROM photo_variants"),
		env.DB.prepare("DELETE FROM photos"),
		env.DB.prepare("DELETE FROM licence_versions"),
		env.DB.prepare("DELETE FROM accounts"),
	]);
	for (const key of [
		"photo-1/thumb",
		"photo-1/preview",
		"photo-1/full",
		"photo-1/quick",
		"photo-2/thumb",
		"photo-2/preview",
		"photo-2/full",
		"photo-2/quick",
	])
		await env.PHOTO_BUCKET.delete(key);
	await seed();
}

describe("photo gallery in the Workers runtime", () => {
	beforeEach(reset);

	it("allows CTN inboxes without a prior import, including previously inactive CTN accounts", async () => {
		for (const address of ["new-member@ctn-rtc.org", "revoked-member@ctn-rtc.org"]) {
			if (address.startsWith("revoked")) {
				await env.DB.prepare(
					"INSERT INTO accounts(id,email,email_hash,active,created_at,revoked_at) VALUES('revoked-ctn',?,?,0,1,2)",
				)
					.bind(address, await hmac(address))
					.run();
			}
			const response = await SELF.fetch("https://gallery.test/?action=request-code", {
				method: "POST",
				headers: { origin: "https://gallery.test", "content-type": "application/json" },
				body: JSON.stringify({ email: address.toUpperCase(), language: "en" }),
			});
			expect(response.status).toBe(202);
			const account = await env.DB.prepare("SELECT active,revoked_at FROM accounts WHERE email=?")
				.bind(address)
				.first();
			expect(account).toMatchObject({ active: 1, revoked_at: null });
			const outbox = await env.DB.prepare(
				"SELECT payload_json FROM notification_outbox WHERE kind='otp' AND json_extract(payload_json,'$.to')=?",
			)
				.bind(address)
				.first<{ payload_json: string }>();
			expect(outbox).not.toBeNull();
			const code = JSON.parse(outbox!.payload_json).text.match(/\b[0-9]{8}\b/)[0];
			const verified = await SELF.fetch("https://gallery.test/?action=verify-code", {
				method: "POST",
				headers: { origin: "https://gallery.test", "content-type": "application/json" },
				body: JSON.stringify({ email: address, code }),
			});
			expect(verified.status).toBe(200);
		}
	});

	it("does not grant domain access to lookalike domains or unrelated unapproved addresses", async () => {
		for (const address of ["person@ctn-rtc.org.example.com", "person@fake-ctn-rtc.org", "person@example.com"]) {
			await SELF.fetch("https://gallery.test/?action=request-code", {
				method: "POST",
				headers: { origin: "https://gallery.test", "content-type": "application/json" },
				body: JSON.stringify({ email: address }),
			});
			expect(await env.DB.prepare("SELECT id FROM accounts WHERE email=?").bind(address).first()).toBeNull();
		}
		const outbox = await env.DB.prepare(
			"SELECT COUNT(*) as count FROM notification_outbox WHERE kind='otp'",
		).first<{ count: number }>();
		expect(outbox?.count).toBe(0);
	});

	it("rejects Access assertions with the wrong audience, domain, or expiry", async () => {
		for (const overrides of [
			{ aud: "other-audience" },
			{ email: "organizer@outside.example" },
			{ exp: Math.floor(Date.now() / 1000) - 1 },
		]) {
			const fixture = await accessFixture(overrides);
			try {
				const response = await SELF.fetch(
					"https://gallery.test/restore?action=case&case=missing-case&version=2",
					{
						headers: { "cf-access-jwt-assertion": fixture.token },
					},
				);
				expect(response.status).toBe(403);
			} finally {
				fixture.restore();
			}
		}
	});

	it("keeps auth generic, protects media, and gates downloads on the licence", async () => {
		const invalidEmail = await SELF.fetch("https://gallery.test/?action=request-code", {
			method: "POST",
			headers: { origin: "https://gallery.test", "content-type": "application/json" },
			body: JSON.stringify({ email: "not-an-email", language: "en" }),
		});
		expect(invalidEmail.status).toBe(202);
		expect(await invalidEmail.json()).toEqual({ accepted: true });
		const malformedBody = await SELF.fetch("https://gallery.test/?action=request-code", {
			method: "POST",
			headers: { origin: "https://gallery.test", "content-type": "application/json" },
			body: "{",
		});
		expect(malformedBody.status).toBe(400);
		expect(await malformedBody.json()).toEqual({ error: "Invalid request." });
		const unknown = await SELF.fetch("https://gallery.test/?action=request-code", {
			method: "POST",
			headers: { origin: "https://gallery.test", "content-type": "application/json" },
			body: JSON.stringify({ email: "unknown@example.org", language: "en" }),
		});
		expect(unknown.status).toBe(202);
		expect(await unknown.json()).toEqual({ accepted: true });
		const unknownRetry = await SELF.fetch("https://gallery.test/?action=request-code", {
			method: "POST",
			headers: { origin: "https://gallery.test", "content-type": "application/json" },
			body: JSON.stringify({ email: "unknown@example.org", language: "fr" }),
		});
		expect(unknownRetry.status).toBe(429);
		const unauthenticated = await SELF.fetch("https://gallery.test/?action=album");
		expect(unauthenticated.status).toBe(401);
		const malformedSessionCookie = await SELF.fetch("https://gallery.test/?action=session", {
			headers: { cookie: "photo_gallery_session=%" },
		});
		expect(malformedSessionCookie.status).toBe(200);
		expect(await malformedSessionCookie.json()).toEqual({ authenticated: false });
		const malformedAlbumCookie = await SELF.fetch("https://gallery.test/?action=album", {
			headers: { cookie: "photo_gallery_session=%" },
		});
		expect(malformedAlbumCookie.status).toBe(401);
		const malformedAccessCookie = await SELF.fetch(
			"https://gallery.test/restore?action=case&case=missing-case&version=2",
			{
				headers: { cookie: "CF_Authorization=%" },
			},
		);
		expect(malformedAccessCookie.status).toBe(403);
		const code = await requestCode();
		const verified = await SELF.fetch("https://gallery.test/?action=verify-code", {
			method: "POST",
			headers: { origin: "https://gallery.test", "content-type": "application/json" },
			body: JSON.stringify({ email, code }),
		});
		expect(verified.status).toBe(200);
		const cookie = verified.headers.get("set-cookie")?.split(";")[0] ?? "";
		const session = (await verified.json()) as { csrfToken: string };
		const album = await SELF.fetch("https://gallery.test/?action=album", { headers: { cookie } });
		expect(album.status).toBe(200);
		const albumBody = (await album.json()) as {
			version: string;
			photos: Array<{ id: string; preview: { url: string }; thumbnail: { url: string } }>;
		};
		expect(albumBody.version).toBe("2026-10-06");
		expect(albumBody.photos.find(photo => photo.id === "photo-1")).toMatchObject({
			thumbnail: { url: "/?action=thumbnail&photo=photo-1" },
			preview: { url: "/?action=preview&photo=photo-1" },
		});
		const eventBody = JSON.stringify({ photoIds: ["photo-1"] });
		const eventHeaders = {
			cookie,
			origin: "https://gallery.test",
			"content-type": "application/json",
			"x-csrf-token": session.csrfToken,
		};
		expect(
			(
				await SELF.fetch("https://gallery.test/?action=events", {
					method: "POST",
					headers: eventHeaders,
					body: eventBody,
				})
			).status,
		).toBe(200);
		expect(
			(
				await SELF.fetch("https://gallery.test/?action=events", {
					method: "POST",
					headers: eventHeaders,
					body: eventBody,
				})
			).status,
		).toBe(200);
		expect(
			(
				await env.DB.prepare("SELECT opens FROM daily_aggregates WHERE photo_id='photo-1'").first<{
					opens: number;
				}>()
			)?.opens,
		).toBe(1);
		const media = await SELF.fetch("https://gallery.test/?action=preview&photo=photo-1", { headers: { cookie } });
		expect(media.status).toBe(200);
		expect(
			(await SELF.fetch("https://gallery.test/?action=preview&photo=photo-1/extra", { headers: { cookie } }))
				.status,
		).toBe(404);
		const blocked = await SELF.fetch(
			"https://gallery.test/?action=download&photo=photo-1&format=full&requestId=11111111-1111-4111-8111-111111111111",
			{ headers: { cookie } },
		);
		expect(blocked.status).toBe(428);
		const acknowledged = await SELF.fetch("https://gallery.test/?action=licence", {
			method: "POST",
			headers: {
				cookie,
				origin: "https://gallery.test",
				"content-type": "application/json",
				"x-csrf-token": session.csrfToken,
			},
			body: JSON.stringify({ version: "2026-10-06" }),
		});
		expect(acknowledged.status).toBe(200);
		const download = await SELF.fetch(
			"https://gallery.test/?action=download&photo=photo-1&format=full&requestId=11111111-1111-4111-8111-111111111111",
			{ headers: { cookie } },
		);
		expect(download.status).toBe(200);
		expect(
			(
				await SELF.fetch(
					"https://gallery.test/?action=download&photo=photo-1/extra?format=full&requestId=11111111-1111-4111-8111-111111111111",
					{ headers: { cookie } },
				)
			).status,
		).toBe(404);
		const invalidRange = await SELF.fetch(
			"https://gallery.test/?action=download&photo=photo-1&format=full&requestId=33333333-3333-4333-8333-333333333333",
			{ headers: { cookie, range: "bytes=99-100" } },
		);
		expect(invalidRange.status).toBe(416);
		const suffixRange = await SELF.fetch(
			"https://gallery.test/?action=download&photo=photo-1&format=full&requestId=55555555-5555-4555-8555-555555555555",
			{ headers: { cookie, range: "bytes=-2" } },
		);
		expect(suffixRange.status).toBe(206);
		expect(suffixRange.headers.get("content-range")).toBe("bytes 2-3/4");
		expect((await suffixRange.arrayBuffer()).byteLength).toBe(2);
		const ifRangeMismatch = await SELF.fetch(
			"https://gallery.test/?action=download&photo=photo-1&format=full&requestId=66666666-6666-4666-8666-666666666666",
			{ headers: { cookie, range: "bytes=0-1", "if-range": '"stale-etag"' } },
		);
		expect(ifRangeMismatch.status).toBe(200);
		expect((await ifRangeMismatch.arrayBuffer()).byteLength).toBe(4);
		const crossPhotoRequestId = await SELF.fetch(
			"https://gallery.test/?action=download&photo=photo-2&format=full&requestId=11111111-1111-4111-8111-111111111111",
			{ headers: { cookie } },
		);
		expect(crossPhotoRequestId.status).toBe(409);
		const removed = await SELF.fetch("https://gallery.test/?action=remove&photo=photo-1", {
			method: "POST",
			headers: {
				cookie,
				origin: "https://gallery.test",
				"content-type": "application/json",
				"x-csrf-token": session.csrfToken,
			},
			body: JSON.stringify({
				explanation: "Please remove this photo.",
				requestId: "22222222-2222-4222-8222-222222222222",
			}),
		});
		expect(removed.status).toBe(202);
		expect(
			(
				await SELF.fetch("https://gallery.test/?action=remove&photo=photo-1/extra", {
					method: "POST",
					headers: {
						cookie,
						origin: "https://gallery.test",
						"content-type": "application/json",
						"x-csrf-token": session.csrfToken,
					},
					body: JSON.stringify({ explanation: "Extra path must not alias.", requestId: crypto.randomUUID() }),
				})
			).status,
		).toBe(404);
		const removalNotice = await env.DB.prepare(
			"SELECT payload_json as payload FROM notification_outbox WHERE kind='removal' ORDER BY created_at DESC LIMIT 1",
		).first<{ payload: string }>();
		expect((JSON.parse(removalNotice?.payload ?? "{}") as { text: string }).text).toContain("Restore / Restaurer");
		const hidden = await SELF.fetch("https://gallery.test/?action=preview&photo=photo-1", { headers: { cookie } });
		expect(hidden.status).toBe(404);
		const firstCase = (await removed.json()) as { caseId: string };
		expect((JSON.parse(removalNotice?.payload ?? "{}") as { text: string }).text).toContain(
			`https://gallery.test/restore?case=${firstCase.caseId}&version=2`,
		);
		const duplicate = await SELF.fetch("https://gallery.test/?action=remove&photo=photo-1", {
			method: "POST",
			headers: {
				cookie,
				origin: "https://gallery.test",
				"content-type": "application/json",
				"x-csrf-token": session.csrfToken,
			},
			body: JSON.stringify({
				explanation: "A changed retry must stay idempotent.",
				requestId: "22222222-2222-4222-8222-222222222222",
			}),
		});
		expect(((await duplicate.json()) as { caseId: string }).caseId).toBe(firstCase.caseId);
		expect(
			await env.DB.prepare("SELECT status,version FROM photos WHERE id='photo-1'").first<{
				status: string;
				version: number;
			}>(),
		).toMatchObject({ status: "quarantined", version: 2 });
		const admin = await accessFixture();
		try {
			const forgedAdmin = await SELF.fetch(
				`https://gallery.test/restore?action=case&case=${firstCase.caseId}&version=2`,
				{
					headers: { "cf-access-jwt-assertion": `${admin.token.split(".").slice(0, 2).join(".")}.invalid` },
				},
			);
			expect(forgedAdmin.status).toBe(403);
			const missing = await SELF.fetch("https://gallery.test/restore?action=case&case=missing-case&version=2", {
				headers: { "cf-access-jwt-assertion": admin.token },
			});
			expect(missing.status).toBe(404);
			const restoreGet = await SELF.fetch(
				`https://gallery.test/restore?action=case&case=${firstCase.caseId}&version=2`,
				{
					headers: { "cf-access-jwt-assertion": admin.token },
				},
			);
			expect(restoreGet.status).toBe(200);
			const restoreBody = (await restoreGet.json()) as {
				filename: string;
				canRestore: boolean;
				photoVersion: number;
				csrfToken: string;
				status: string;
			};
			expect(restoreBody).toMatchObject({
				filename: "sample.jpg",
				canRestore: true,
				photoVersion: 2,
				status: "pending",
			});
			expect(restoreBody.csrfToken).toBeTruthy();
			const staleGet = await SELF.fetch(
				`https://gallery.test/restore?action=case&case=${firstCase.caseId}&version=1`,
				{
					headers: { "cf-access-jwt-assertion": admin.token },
				},
			);
			expect(((await staleGet.json()) as { canRestore: boolean }).canRestore).toBe(false);
			expect(
				(
					await SELF.fetch(
						`https://gallery.test/restore?action=case&case=${firstCase.caseId}/extra?version=2`,
						{
							headers: { "cf-access-jwt-assertion": admin.token },
						},
					)
				).status,
			).toBe(404);
			expect(
				(
					await SELF.fetch("https://gallery.test/api/manage", {
						headers: { "cf-access-jwt-assertion": admin.token },
					})
				).status,
			).toBe(404);
			const invalidCsrf = await SELF.fetch(`https://gallery.test/restore?action=case&case=${firstCase.caseId}`, {
				method: "POST",
				headers: {
					"cf-access-jwt-assertion": admin.token,
					origin: "https://gallery.test",
					"content-type": "application/json",
					"x-csrf-token": "wrong",
				},
				body: JSON.stringify({ expectedVersion: 2 }),
			});
			expect(invalidCsrf.status).toBe(403);
			const staleRestore = await SELF.fetch(`https://gallery.test/restore?action=case&case=${firstCase.caseId}`, {
				method: "POST",
				headers: {
					"cf-access-jwt-assertion": admin.token,
					origin: "https://gallery.test",
					"content-type": "application/json",
					"x-csrf-token": restoreBody.csrfToken,
				},
				body: JSON.stringify({ expectedVersion: 1 }),
			});
			expect(staleRestore.status).toBe(409);
			const restore = await SELF.fetch(`https://gallery.test/restore?action=case&case=${firstCase.caseId}`, {
				method: "POST",
				headers: {
					"cf-access-jwt-assertion": admin.token,
					origin: "https://gallery.test",
					"content-type": "application/json",
					"x-csrf-token": restoreBody.csrfToken,
				},
				body: JSON.stringify({ expectedVersion: 2 }),
			});
			expect(restore.status).toBe(200);
			expect(await restore.json()).toMatchObject({ restored: true, status: "dismissed", version: 3 });
			expect(await env.DB.prepare("SELECT status,version FROM photos WHERE id='photo-1'").first()).toMatchObject({
				status: "published",
				version: 3,
			});
			expect(
				await env.DB.prepare("SELECT status FROM removal_requests WHERE id=?").bind(firstCase.caseId).first(),
			).toMatchObject({ status: "dismissed" });
			expect(
				await env.DB.prepare("SELECT reason FROM moderation_audit WHERE case_id=?")
					.bind(firstCase.caseId)
					.first(),
			).toMatchObject({ reason: "Restoration approved from removal notification" });
			const repeated = await SELF.fetch(`https://gallery.test/restore?action=case&case=${firstCase.caseId}`, {
				method: "POST",
				headers: {
					"cf-access-jwt-assertion": admin.token,
					origin: "https://gallery.test",
					"content-type": "application/json",
					"x-csrf-token": restoreBody.csrfToken,
				},
				body: JSON.stringify({ expectedVersion: 2 }),
			});
			expect(repeated.status).toBe(409);
		} finally {
			admin.restore();
		}
		const invalidLogout = await SELF.fetch("https://gallery.test/?action=logout", {
			method: "POST",
			headers: {
				cookie,
				origin: "https://gallery.test",
				"content-type": "application/json",
				"x-csrf-token": "wrong",
			},
		});
		expect(invalidLogout.status).toBe(403);
		const validLogout = await SELF.fetch("https://gallery.test/?action=logout", {
			method: "POST",
			headers: {
				cookie,
				origin: "https://gallery.test",
				"content-type": "application/json",
				"x-csrf-token": session.csrfToken,
			},
		});
		expect(validLogout.status).toBe(200);
		expect((await SELF.fetch("https://gallery.test/?action=album", { headers: { cookie } })).status).toBe(401);
	});

	it("rejects requests for hidden photos and restores every pending request together", async () => {
		const code = await requestCode();
		const verified = await SELF.fetch("https://gallery.test/?action=verify-code", {
			method: "POST",
			headers: { origin: "https://gallery.test", "content-type": "application/json" },
			body: JSON.stringify({ email, code }),
		});
		const cookie = verified.headers.get("set-cookie")?.split(";")[0] ?? "";
		const session = (await verified.json()) as { csrfToken: string; accountId: string };
		const submit = (requestId: string) =>
			SELF.fetch("https://gallery.test/?action=remove&photo=photo-1", {
				method: "POST",
				headers: {
					cookie,
					origin: "https://gallery.test",
					"content-type": "application/json",
					"x-csrf-token": session.csrfToken,
				},
				body: JSON.stringify({ explanation: "Pending restoration request.", requestId }),
			});
		const first = await submit("11111111-1111-4111-8111-111111111111");
		expect(first.status).toBe(202);
		const firstCase = ((await first.json()) as { caseId: string }).caseId;
		// The photo is hidden now, so a second request cannot add another pending row.
		expect((await submit("22222222-2222-4222-8222-222222222222")).status).toBe(404);
		// A retry of the accepted request is still idempotent.
		expect(
			((await (await submit("11111111-1111-4111-8111-111111111111")).json()) as { caseId: string }).caseId,
		).toBe(firstCase);
		// Simulate a second pending request left over from before this rule existed.
		await env.DB.prepare(
			"INSERT INTO removal_requests(id,photo_id,requester_account_id,explanation,request_id,status,photo_version,created_at,updated_at) VALUES('legacy-case','photo-1',?,'Legacy duplicate.','33333333-3333-4333-8333-333333333333','pending',3,?,?)",
		)
			.bind(session.accountId, Date.now(), Date.now())
			.run();
		const admin = await accessFixture();
		try {
			const state = await SELF.fetch(`https://gallery.test/restore?action=case&case=${firstCase}&version=3`, {
				headers: { "cf-access-jwt-assertion": admin.token },
			});
			expect(state.status).toBe(200);
			const stateBody = (await state.json()) as { canRestore: boolean; csrfToken: string };
			expect(stateBody.canRestore).toBe(true);
			const restore = await SELF.fetch(`https://gallery.test/restore?action=case&case=${firstCase}`, {
				method: "POST",
				headers: {
					"cf-access-jwt-assertion": admin.token,
					origin: "https://gallery.test",
					"content-type": "application/json",
					"x-csrf-token": stateBody.csrfToken,
				},
				body: JSON.stringify({ expectedVersion: 3 }),
			});
			expect(restore.status).toBe(200);
			expect(await env.DB.prepare("SELECT status,version FROM photos WHERE id='photo-1'").first()).toMatchObject({
				status: "published",
				version: 4,
			});
			const pending = await env.DB.prepare(
				"SELECT COUNT(*) as count FROM removal_requests WHERE photo_id='photo-1' AND status='pending'",
			).first<{ count: number }>();
			expect(pending?.count).toBe(0);
		} finally {
			admin.restore();
		}
	});

	it("fails closed when the D1 licence version differs from configuration", async () => {
		const code = await requestCode();
		const verified = await SELF.fetch("https://gallery.test/?action=verify-code", {
			method: "POST",
			headers: { origin: "https://gallery.test", "content-type": "application/json" },
			body: JSON.stringify({ email, code }),
		});
		const cookie = verified.headers.get("set-cookie")?.split(";")[0] ?? "";
		await env.DB.prepare("UPDATE licence_versions SET version='2026-10-07' WHERE current=1").run();
		const album = await SELF.fetch("https://gallery.test/?action=album", { headers: { cookie } });
		expect(album.status).toBe(500);
		expect(await album.json()).toEqual({ error: "The request could not be completed." });
	});

	it("returns a generic server error when auth persistence fails", async () => {
		const failingEnv = {
			...env,
			DB: {
				prepare() {
					throw new Error("database unavailable");
				},
			},
		} as unknown as Env;
		const response = await worker.fetch(
			new Request("https://gallery.test/?action=request-code", {
				method: "POST",
				headers: { origin: "https://gallery.test", "content-type": "application/json" },
				body: JSON.stringify({ email: "eligible@example.org", language: "en" }),
			}),
			failingEnv,
			{ waitUntil() {} } as unknown as ExecutionContext,
		);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "The request could not be completed." });
	});

	it("returns a generic server error when admin persistence fails after Access verification", async () => {
		const fixture = await accessFixture();
		try {
			const failingEnv = {
				...env,
				DB: {
					prepare() {
						throw new Error("database unavailable");
					},
				},
			} as unknown as Env;
			const response = await worker.fetch(
				new Request("https://gallery.test/restore?action=case&case=missing-case&version=2", {
					headers: { "cf-access-jwt-assertion": fixture.token },
				}),
				failingEnv,
				{ waitUntil() {} } as unknown as ExecutionContext,
			);
			expect(response.status).toBe(500);
			expect(await response.json()).toEqual({ error: "The request could not be completed." });
		} finally {
			fixture.restore();
		}
	});

	it("expires OTPs, supersedes old challenges, and locks after five wrong attempts", async () => {
		const firstCode = await requestCode();
		await env.DB.prepare("UPDATE code_challenges SET expires_at=0,resend_after=0 WHERE email_hash=?")
			.bind(await hmac(email))
			.run();
		const expired = await SELF.fetch("https://gallery.test/?action=verify-code", {
			method: "POST",
			headers: { origin: "https://gallery.test", "content-type": "application/json" },
			body: JSON.stringify({ email, code: firstCode }),
		});
		expect(expired.status).toBe(401);
		const currentCode = await requestCode();
		const wrong = "00000000" === currentCode ? "99999999" : "00000000";
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const response = await SELF.fetch("https://gallery.test/?action=verify-code", {
				method: "POST",
				headers: { origin: "https://gallery.test", "content-type": "application/json" },
				body: JSON.stringify({ email, code: wrong }),
			});
			expect(response.status).toBe(401);
		}
		const locked = await SELF.fetch("https://gallery.test/?action=verify-code", {
			method: "POST",
			headers: { origin: "https://gallery.test", "content-type": "application/json" },
			body: JSON.stringify({ email, code: currentCode }),
		});
		expect(locked.status).toBe(401);
	});

	it("applies same-photo removal quotas atomically while preserving idempotent retries", async () => {
		const code = await requestCode();
		const verified = await SELF.fetch("https://gallery.test/?action=verify-code", {
			method: "POST",
			headers: { origin: "https://gallery.test", "content-type": "application/json" },
			body: JSON.stringify({ email, code }),
		});
		const cookie = verified.headers.get("set-cookie")?.split(";")[0] ?? "";
		const session = (await verified.json()) as { csrfToken: string };
		const submit = (requestId: string, explanation: string) =>
			SELF.fetch("https://gallery.test/?action=remove&photo=photo-1", {
				method: "POST",
				headers: {
					cookie,
					origin: "https://gallery.test",
					"content-type": "application/json",
					"x-csrf-token": session.csrfToken,
				},
				body: JSON.stringify({ explanation, requestId }),
			});
		const ids = [
			"a0000000-0000-4000-8000-000000000001",
			"a0000000-0000-4000-8000-000000000002",
			"a0000000-0000-4000-8000-000000000003",
			"a0000000-0000-4000-8000-000000000004",
			"a0000000-0000-4000-8000-000000000005",
		];
		// Requests are accepted only for published photos, so republish between them.
		const republish = () => env.DB.prepare("UPDATE photos SET status='published' WHERE id='photo-1'").run();
		for (const [index, id] of ids.entries()) {
			expect((await submit(id, `Report ${index}`)).status).toBe(202);
			await republish();
		}
		expect((await submit("a0000000-0000-4000-8000-000000000006", "The sixth report is over quota.")).status).toBe(
			429,
		);
		const retry = await submit(ids[0], "Changed text must remain idempotent.");
		expect(retry.status).toBe(202);
		expect(
			(
				await env.DB.prepare(
					"SELECT COUNT(*) as count FROM removal_requests WHERE requester_account_id='acct-1' AND photo_id='photo-1'",
				).first<{ count: number }>()
			)?.count,
		).toBe(5);
	});

	it("retains pending cases but purges resolved history and old audit rows", async () => {
		const old = Date.now() - 366 * 24 * 60 * 60 * 1000;
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO removal_requests(id,photo_id,requester_account_id,explanation,request_id,status,photo_version,created_at,updated_at,resolved_at) VALUES('old-case','photo-1','acct-1','Old resolved request','old-request','dismissed',1,?,?,?)",
			).bind(old, old, old),
			env.DB.prepare(
				"INSERT INTO moderation_audit(id,actor_subject,action,photo_id,reason,created_at) VALUES('old-audit','admin-subject','dismiss','photo-1','Old audit',?)",
			).bind(old),
			env.DB.prepare(
				"INSERT INTO removal_requests(id,photo_id,requester_account_id,explanation,request_id,status,photo_version,created_at,updated_at) VALUES('pending-retained','photo-1','acct-1','Pending request','pending-retained-request','pending',1,?,?)",
			).bind(old, old),
			env.DB.prepare(
				"INSERT INTO notification_outbox(id,kind,payload_json,attempts,available_at,sent_at,created_at) VALUES('old-sent','removal','{}',0,?,?,?)",
			).bind(old, old, old),
			env.DB.prepare(
				"INSERT INTO notification_outbox(id,kind,payload_json,attempts,available_at,created_at) VALUES('old-unsent','removal','{}',3,?,?)",
			).bind(old, old),
		]);
		const waits: Promise<unknown>[] = [];
		await worker.scheduled({} as ScheduledController, env, {
			waitUntil(promise: Promise<unknown>) {
				waits.push(promise);
			},
		} as ExecutionContext);
		await Promise.all(waits);
		expect(
			(
				await env.DB.prepare("SELECT COUNT(*) as count FROM removal_requests WHERE id='old-case'").first<{
					count: number;
				}>()
			)?.count,
		).toBe(0);
		expect(
			(
				await env.DB.prepare("SELECT COUNT(*) as count FROM moderation_audit WHERE id='old-audit'").first<{
					count: number;
				}>()
			)?.count,
		).toBe(0);
		expect(
			(
				await env.DB.prepare(
					"SELECT COUNT(*) as count FROM removal_requests WHERE id='pending-retained'",
				).first<{
					count: number;
				}>()
			)?.count,
		).toBe(1);
		// Delivered removal emails expire; undelivered ones stay until they are sent.
		const outbox = await env.DB.prepare(
			"SELECT id FROM notification_outbox WHERE id IN ('old-sent','old-unsent') ORDER BY id",
		).all<{ id: string }>();
		expect(outbox.results.map(row => row.id)).toEqual(["old-unsent"]);
	});

	it("consumes a successful OTP exactly once", async () => {
		const code = await requestCode();
		const verified = await SELF.fetch("https://gallery.test/?action=verify-code", {
			method: "POST",
			headers: { origin: "https://gallery.test", "content-type": "application/json" },
			body: JSON.stringify({ email, code }),
		});
		expect(verified.status).toBe(200);
		const reused = await SELF.fetch("https://gallery.test/?action=verify-code", {
			method: "POST",
			headers: { origin: "https://gallery.test", "content-type": "application/json" },
			body: JSON.stringify({ email, code }),
		});
		expect(reused.status).toBe(401);
	});

	it.each(["en", "fr"] as const)("queues consistent %s photo album login emails", async lang => {
		const code = await requestCode(lang);
		const outbox = await env.DB.prepare(
			"SELECT payload_json as payload FROM notification_outbox WHERE kind='otp' ORDER BY created_at DESC LIMIT 1",
		).first<{ payload: string }>();
		const payload = JSON.parse(outbox?.payload ?? "{}") as { subject: string; text: string };
		expect(payload.subject).toBe(
			lang === "fr"
				? "Code de connexion à l’album photo de Hack the Hill III"
				: "Hack the Hill III photo album sign-in code",
		);
		expect(payload.text).toBe(
			lang === "fr"
				? `Votre code de connexion est ${code}. Il expire dans dix minutes.`
				: `Your sign-in code is ${code}. It expires in ten minutes.`,
		);
	});

	it("serializes concurrent OTP requests through the cooldown and budget gate", async () => {
		const request = () =>
			SELF.fetch("https://gallery.test/?action=request-code", {
				method: "POST",
				headers: { origin: "https://gallery.test", "content-type": "application/json" },
				body: JSON.stringify({ email, language: "en" }),
			});
		const [first, second] = await Promise.all([request(), request()]);
		expect([first.status, second.status].sort()).toEqual([202, 429]);
		expect(
			(
				await env.DB.prepare("SELECT COUNT(*) as count FROM code_challenges WHERE email_hash=?")
					.bind(await hmac(email))
					.first<{ count: number }>()
			)?.count,
		).toBe(1);
		expect(
			(
				await env.DB.prepare("SELECT COUNT(*) as count FROM notification_outbox WHERE kind='otp'").first<{
					count: number;
				}>()
			)?.count,
		).toBe(1);
	});

	it("rejects a concurrent download that loses requestId binding", async () => {
		const code = await requestCode();
		const verified = await SELF.fetch("https://gallery.test/?action=verify-code", {
			method: "POST",
			headers: { origin: "https://gallery.test", "content-type": "application/json" },
			body: JSON.stringify({ email, code }),
		});
		const cookie = verified.headers.get("set-cookie")?.split(";")[0] ?? "";
		const session = (await verified.json()) as { csrfToken: string };
		const acknowledged = await SELF.fetch("https://gallery.test/?action=licence", {
			method: "POST",
			headers: {
				cookie,
				origin: "https://gallery.test",
				"content-type": "application/json",
				"x-csrf-token": session.csrfToken,
			},
			body: JSON.stringify({ version: "2026-10-06" }),
		});
		expect(acknowledged.status).toBe(200);
		const requestId = "abababab-abab-4aba-8aba-abababababab";
		const fetchDownload = (photoId: string) =>
			SELF.fetch(`https://gallery.test/?action=download&photo=${photoId}&format=full&requestId=${requestId}`, {
				headers: { cookie },
			});
		const [first, second] = await Promise.all([fetchDownload("photo-1"), fetchDownload("photo-2")]);
		expect([first.status, second.status].sort()).toEqual([200, 409]);
		expect(
			(
				await env.DB.prepare("SELECT COUNT(*) as count FROM download_requests WHERE request_id=?")
					.bind(requestId)
					.first<{ count: number }>()
			)?.count,
		).toBe(1);
	});

	it("keeps anonymous activity aggregates after download records expire", async () => {
		const code = await requestCode();
		const verified = await SELF.fetch("https://gallery.test/?action=verify-code", {
			method: "POST",
			headers: { origin: "https://gallery.test", "content-type": "application/json" },
			body: JSON.stringify({ email, code }),
		});
		const cookie = verified.headers.get("set-cookie")?.split(";")[0] ?? "";
		const session = (await verified.json()) as { csrfToken: string };
		const headers = {
			cookie,
			origin: "https://gallery.test",
			"content-type": "application/json",
			"x-csrf-token": session.csrfToken,
		};
		expect(
			(
				await SELF.fetch("https://gallery.test/?action=licence", {
					method: "POST",
					headers: headers,
					body: JSON.stringify({ version: "2026-10-06" }),
				})
			).status,
		).toBe(200);
		for (const [format, requestId] of [
			["full", "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd"],
			["quick", "dededede-dede-4ded-8ded-dededededede"],
		] as const) {
			expect(
				(
					await SELF.fetch(
						`https://gallery.test/?action=download&photo=photo-1&format=${format}&requestId=${requestId}`,
						{ headers: { cookie } },
					)
				).status,
			).toBe(200);
		}
		expect(
			(
				await SELF.fetch("https://gallery.test/?action=events", {
					method: "POST",
					headers,
					body: JSON.stringify({ photoIds: ["photo-1"], albumVisit: true }),
				})
			).status,
		).toBe(200);
		await env.DB.prepare("UPDATE download_requests SET created_at=? WHERE photo_id='photo-1'")
			.bind(Date.now() - 91 * 24 * 60 * 60 * 1000)
			.run();
		const waits: Promise<unknown>[] = [];
		await worker.scheduled({} as ScheduledController, env, {
			waitUntil(promise: Promise<unknown>) {
				waits.push(promise);
			},
		} as ExecutionContext);
		await Promise.all(waits);
		const album = await SELF.fetch("https://gallery.test/?action=album", { headers: { cookie } });
		expect(album.status).toBe(200);
		const body = (await album.json()) as {
			activity: { views: number; downloadRequests: number };
			photos: Array<{ id: string; activity: { views: number; downloadRequests: number } }>;
		};
		expect(body.activity).toEqual({ views: 1, downloadRequests: 2 });
		expect(body.photos.find(photo => photo.id === "photo-1")?.activity).toEqual({ views: 1, downloadRequests: 2 });
		expect(JSON.stringify(body)).not.toContain(email);
	});
});

it("serves only approved public previews and respects removal even with a matching ETag", async () => {
	await reset();
	const id = [...publicHighlights][0];
	await env.DB.prepare(
		"INSERT INTO photos(id,category,filename,version,status,width,height,created_at,updated_at) SELECT ?,category,filename,version,status,width,height,created_at,updated_at FROM photos WHERE id='photo-1'",
	)
		.bind(id)
		.run();
	await env.DB.prepare(
		"INSERT INTO photo_variants(photo_id,format,object_key,width,height,bytes,content_type,sha256) VALUES(?,'preview','photo-1/preview',2,2,4,'image/jpeg','test-hash')",
	)
		.bind(id)
		.run();
	const url = `https://gallery.test/?action=highlight&photo=${id}`;
	const response = await SELF.fetch(url);
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-cache");
	expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3, 4]);
	const revalidated = await SELF.fetch(url, { headers: { "If-None-Match": response.headers.get("etag")! } });
	expect(revalidated.status).toBe(304);
	expect((await SELF.fetch("https://gallery.test/?action=highlight&photo=photo-1")).status).toBe(404);
	expect((await SELF.fetch(`https://gallery.test/?action=preview&photo=${id}`)).status).toBe(401);
	expect((await SELF.fetch(`https://gallery.test/?action=download&photo=${id}&format=full`)).status).toBe(401);
	await env.DB.prepare("UPDATE photos SET status='quarantined' WHERE id=?").bind(id).run();
	expect((await SELF.fetch(url, { headers: { "if-none-match": '"test-hash"' } })).status).toBe(404);
});

it("serves the album page for GET and HEAD but not other methods", async () => {
	const get = await SELF.fetch("https://gallery.test/");
	expect(get.status).toBe(200);
	expect(await get.text()).toContain("Album test page");
	const head = await SELF.fetch("https://gallery.test/", { method: "HEAD" });
	expect(head.status).toBe(200);
	expect(head.headers.get("content-type")).toContain("text/html");
	expect((await SELF.fetch("https://gallery.test/", { method: "POST" })).status).toBe(404);
});
