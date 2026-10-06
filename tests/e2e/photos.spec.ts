import { expect, test, type Page } from "@playwright/test";

const photo = {
	id: "opening-001",
	category: "Opening Ceremony",
	filename: "IMG_0001.jpg",
	version: "1",
	width: 2400,
	height: 1600,
	thumbnail: { url: "/api/photos/opening-001/thumbnail", width: 640, height: 427, bytes: 42_000 },
	preview: { url: "/api/photos/opening-001/preview", width: 1600, height: 1067, bytes: 180_000 },
	downloads: {
		full: { width: 6000, height: 4000, bytes: 2_400_000 },
		quick: { width: 2048, height: 1365, bytes: 420_000 },
	},
};
const tinyPng = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);

async function routePhotoMedia(page: Page) {
	await page.route(/\/api\/photos\/[^/]+\/(thumbnail|preview)(?:\?.*)?$/, route =>
		route.fulfill({
			status: 200,
			contentType: "image/png",
			body: tinyPng,
			headers: { "Cache-Control": "private, no-store" },
		}),
	);
}

async function routeAttendee(page: Page, authenticated = true) {
	await page.route("**/api/auth/session", route =>
		route.fulfill({
			json: authenticated
				? { authenticated: true, csrfToken: "csrf-attendee", accountId: "acct-1", licenceVersion: "2026-10-06" }
				: { authenticated: false },
		}),
	);
	if (authenticated) {
		await routePhotoMedia(page);
		await page.route("**/api/album", route =>
			route.fulfill({
				json: {
					version: "1",
					photos: [
						photo,
						{ ...photo, id: "closing-001", category: "Closing Ceremony", filename: "IMG_0002.jpg" },
					],
				},
			}),
		);
	}
}

async function expectTopDialogContainsFocus(page: Page) {
	await expect
		.poll(() =>
			page.evaluate(() => {
				const dialogs = Array.from(
					document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'),
				);
				return dialogs.length > 0 && dialogs[dialogs.length - 1].contains(document.activeElement);
			}),
		)
		.toBe(true);
}

test("unauthenticated arrival contains no protected photo media", async ({ page }) => {
	const mediaRequests: string[] = [];
	page.on("request", request => {
		if (request.url().includes("/api/photos/")) mediaRequests.push(request.url());
	});
	await routeAttendee(page, false);
	await page.goto("/");
	await expect(page.getByRole("heading", { name: /album/i })).toBeVisible();
	await expect(page.locator("img")).toHaveCount(1); // branding only
	await expect(page.locator("#photo-email")).toBeVisible();
	expect(mediaRequests).toEqual([]);
	await expect(page.locator("body")).not.toContainText("IMG_0001.jpg");
});

test("email code request supports paste and verifies through the API contract", async ({ page }) => {
	await routeAttendee(page, false);
	await page.route("**/api/auth/request", async route => {
		expect(await route.request().postDataJSON()).toEqual({ email: "attendee@example.org", language: "en" });
		await route.fulfill({ status: 202, json: { accepted: true } });
	});
	await page.route("**/api/auth/verify", async route => {
		expect(await route.request().postDataJSON()).toEqual({ email: "attendee@example.org", code: "12345678" });
		await route.fulfill({
			json: {
				authenticated: true,
				csrfToken: "csrf-attendee",
				accountId: "acct-1",
				licenceVersion: "2026-10-06",
			},
		});
	});
	const eventBodies: Array<{ photoIds: string[]; albumVisit: boolean }> = [];
	await page.route("**/api/events", async route => {
		eventBodies.push(await route.request().postDataJSON());
		await route.fulfill({ json: {} });
	});
	await routePhotoMedia(page);
	await page.route("**/api/album", route => route.fulfill({ json: { version: "1", photos: [photo] } }));
	await page.goto("/");
	await page.locator("#photo-email").fill("attendee@example.org");
	await page.getByRole("button", { name: "Send code" }).click();
	await expect(page.locator("#photo-code")).toBeVisible();
	await page.locator("#photo-code").fill("12345678");
	await page.getByRole("button", { name: "Open album" }).click();
	await expect(page.getByRole("heading", { name: "Photo album" })).toBeVisible();
	await expect.poll(() => eventBodies.filter(event => event.albumVisit).length).toBe(1);
	expect(eventBodies.find(event => event.albumVisit)).toEqual({ photoIds: [], albumVisit: true });
	await expect
		.poll(() =>
			page
				.locator('[class*="photoButton"] img')
				.first()
				.evaluate(image => ({
					complete: (image as HTMLImageElement).complete,
					naturalWidth: (image as HTMLImageElement).naturalWidth,
				})),
		)
		.toEqual({ complete: true, naturalWidth: 1 });
	await expect
		.poll(() =>
			page.locator('[class*="heroPhoto"] img').evaluate(image => ({
				complete: (image as HTMLImageElement).complete,
				naturalWidth: (image as HTMLImageElement).naturalWidth,
			})),
		)
		.toEqual({ complete: true, naturalWidth: 1 });
	await page.locator('input[placeholder="Search photos"]').fill("IMG");
	await page.getByRole("button", { name: "Français" }).click();
	await expect(page.getByRole("heading", { name: "Album photo" })).toBeVisible();
	await expect(page.locator('input[placeholder="Rechercher des photos"]')).toHaveValue("IMG");
	expect(eventBodies.filter(event => event.albumVisit)).toHaveLength(1);
});

test("download opens bilingual terms and cancellation makes no download request", async ({ page }) => {
	await routeAttendee(page);
	await page.route("**/api/events", route => route.fulfill({ json: {} }));
	await page.goto("/");
	await page.getByRole("button", { name: /View photo: IMG_0001/ }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
	let downloadRequests = 0;
	page.on("request", request => {
		if (new URL(request.url()).pathname.endsWith("/download")) downloadRequests++;
	});
	await page.getByRole("button", { name: /Download/ }).click();
	await expect(page.getByRole("heading", { name: "Before you download" })).toBeVisible();
	await expect(page.getByText("English", { exact: true })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Français" })).toBeVisible();
	await page.keyboard.press("Tab");
	await expectTopDialogContainsFocus(page);
	await page.keyboard.press("Shift+Tab");
	await expectTopDialogContainsFocus(page);
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(1); // the viewer remains beneath the licence dialog
	await expect(page.locator("#viewer-title")).toHaveText("IMG_0001.jpg");
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	expect(downloadRequests).toBe(0);
});

test("removal dialog traps focus and Escape restores the viewer", async ({ page }) => {
	await routeAttendee(page);
	await page.route("**/api/events", route => route.fulfill({ json: {} }));
	await page.goto("/");
	await page.getByRole("button", { name: /View photo: IMG_0001/ }).click();
	await page.getByRole("button", { name: "Request removal" }).click();
	await expect(page.getByRole("heading", { name: "Request removal" })).toBeVisible();
	await page.keyboard.press("Tab");
	await expectTopDialogContainsFocus(page);
	await page.keyboard.press("Shift+Tab");
	await expectTopDialogContainsFocus(page);
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(1);
	await expect(page.locator("#viewer-title")).toHaveText("IMG_0001.jpg");
});

test("viewer keeps the full preview composition and moves with keyboard", async ({ page }) => {
	await routeAttendee(page);
	await page.route("**/api/events", route => route.fulfill({ json: {} }));
	await page.goto("/");
	await page.getByRole("button", { name: /View photo: IMG_0001/ }).click();
	const viewerImage = page.getByRole("dialog").locator("img");
	await expect(viewerImage).toHaveAttribute("src", "/api/photos/opening-001/preview");
	await expect(viewerImage).toHaveAttribute("width", "1600");
	await expect
		.poll(() =>
			viewerImage.evaluate(image => ({
				complete: (image as HTMLImageElement).complete,
				naturalWidth: (image as HTMLImageElement).naturalWidth,
			})),
		)
		.toEqual({ complete: true, naturalWidth: 1 });
	await page.keyboard.press("ArrowRight");
	await expect(page.locator("#viewer-title")).toHaveText("IMG_0002.jpg");
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("unavailable shared photo is neutral and corrupted favourites do not break the album", async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("hth-photo-favourites:acct-1", "{not-json"));
	await routeAttendee(page);
	await page.goto("/?photo=hidden-or-missing");
	await expect(page.getByRole("status")).toContainText("This photo is no longer available.");
	await expect(page.getByRole("heading", { name: "Photo album" })).toBeVisible();
	await expect(page.getByText("IMG_0001.jpg")).toBeVisible();
});

test("returning to a visible album closes a withdrawn viewer without remounting the shell", async ({ page }) => {
	await routeAttendee(page);
	let revoked = false;
	await page.route("**/api/auth/session", route =>
		route.fulfill({
			json: revoked
				? { authenticated: true, csrfToken: "csrf-attendee", accountId: "acct-1" }
				: { authenticated: true, csrfToken: "csrf-attendee", accountId: "acct-1" },
		}),
	);
	await page.route("**/api/album", route =>
		route.fulfill({
			json: {
				version: "2",
				photos: revoked
					? [{ ...photo, id: "closing-001", category: "Closing Ceremony", filename: "IMG_0002.jpg" }]
					: [photo],
			},
		}),
	);
	await page.goto("/");
	await page.getByRole("button", { name: /View photo: IMG_0001/ }).click();
	revoked = true;
	await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
	await expect(page.getByRole("status")).toContainText("This photo is no longer available.");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(page.getByRole("heading", { name: "Photo album" })).toBeVisible();
});

test("logout failure keeps the authenticated album and offers the same retry action", async ({ page }) => {
	await routeAttendee(page);
	await page.route("**/api/auth/logout", route =>
		route.fulfill({ status: 503, json: { error: "temporary outage" } }),
	);
	await page.goto("/");
	await page.getByRole("button", { name: "Sign out" }).click();
	await expect(page.getByRole("alert")).toContainText("temporary outage");
	await expect(page.getByRole("heading", { name: "Photo album" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});

test("standalone root works on mobile and copies share links from its current origin", async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 740 });
	await page.addInitScript(() => {
		Object.defineProperty(navigator, "clipboard", {
			value: {
				writeText: async (value: string) => {
					(window as unknown as { copiedPhotoLink: string }).copiedPhotoLink = value;
				},
			},
		});
	});
	await routeAttendee(page);
	await page.route("**/api/events", route => route.fulfill({ json: {} }));
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Photo album" })).toBeVisible();
	await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await page.getByRole("button", { name: "View photo" }).first().click();
	await page.getByRole("button", { name: "Copy share link" }).click();
	const copied = await page.evaluate(() => (window as unknown as { copiedPhotoLink: string }).copiedPhotoLink);
	const expected = new URL("/?photo=opening-001", page.url()).href;
	expect(copied).toBe(expected);
	await page.goto(copied);
	await expect(page.getByRole("dialog", { name: "IMG_0001.jpg" })).toBeVisible();
});

test("restoration is a read-only email arrival followed by an explicit protected action", async ({ page }) => {
	let actions = 0;
	await page.route("**/api/restore/case-1?version=2", async route => {
		if (route.request().method() === "POST") {
			actions++;
			expect(route.request().headers()["x-csrf-token"]).toBe("restore-csrf");
			expect(route.request().postDataJSON()).toEqual({ expectedVersion: 2 });
			await route.fulfill({ json: { restored: true } });
		} else {
			await route.fulfill({
				json: {
					filename: "IMG_0001.jpg",
					canRestore: true,
					photoVersion: 2,
					status: "pending",
					csrfToken: "restore-csrf",
				},
			});
		}
	});
	await page.goto("/restore?case=case-1&version=2");
	await expect(page.getByText("IMG_0001.jpg")).toBeVisible();
	await expect(page.getByText("This will make the photo available again.")).toBeVisible();
	expect(actions).toBe(0);
	await page.getByRole("button", { name: "Restore photo", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Photo restored. It is available in the album again." }),
	).toBeVisible();
	expect(actions).toBe(1);
	await expect(page.getByRole("link", { name: "Back to album" })).toHaveAttribute("href", "/");
});

test("stale restoration email offers no restoration action", async ({ page }) => {
	await page.route("**/api/restore/case-1?version=2", route =>
		route.fulfill({
			json: {
				filename: "IMG_0001.jpg",
				canRestore: false,
				photoVersion: 3,
				status: "pending",
				csrfToken: "restore-csrf",
			},
		}),
	);
	await page.goto("/restore?case=case-1&version=2");
	await expect(page.getByRole("heading", { name: /Open the latest notification/ })).toBeVisible();
	await expect(page.getByRole("button", { name: "Restore photo", exact: true })).toHaveCount(0);
});

test("the restoration route handles a missing email context", async ({ page }) => {
	await page.goto("/restore");
	await expect(page.getByRole("heading", { name: "No restore request was specified." })).toBeVisible();
	await expect(page.locator("#photo-email")).toHaveCount(0);
});

test("a failed removal preserves the explanation and idempotent retry", async ({ page }) => {
	await routeAttendee(page);
	const bodies: { explanation: string; requestId: string }[] = [];
	await page.route("**/api/photos/opening-001/removal-requests", async route => {
		bodies.push(route.request().postDataJSON());
		await route.fulfill({ status: 500, json: { error: "Unavailable" } });
	});
	await page.goto("/");
	await page.getByRole("button", { name: /View photo: IMG_0001/ }).click();
	await page.getByRole("button", { name: "Request removal", exact: true }).click();
	await page.locator("#removal-explanation").fill("Please remove this photo of me.");
	await page.getByRole("button", { name: "Temporarily hide photo and send request", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("Something went wrong");
	await expect(page.locator("#removal-explanation")).toHaveValue("Please remove this photo of me.");
	await page.getByRole("button", { name: "Temporarily hide photo and send request", exact: true }).click();
	await expect.poll(() => bodies.length).toBe(2);
	expect(bodies[0]).toEqual(bodies[1]);
});

test("browser storage failure does not prevent the album or restoration panel from loading", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await page.addInitScript(() => {
		Object.defineProperty(Storage.prototype, "getItem", {
			value: () => {
				throw new DOMException("Blocked", "SecurityError");
			},
		});
		Object.defineProperty(Storage.prototype, "setItem", {
			value: () => {
				throw new DOMException("Blocked", "SecurityError");
			},
		});
	});
	await routeAttendee(page);
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Photo album", exact: true })).toBeVisible();
	await page.goto("/restore");
	await expect(page.getByRole("heading", { name: "No restore request was specified." })).toBeVisible();
	expect(errors).toEqual([]);
});
