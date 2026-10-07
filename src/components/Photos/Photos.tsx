import { categories, copy, type Language } from "../../locales/photos";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type FormEvent,
	type ReactNode,
	type TouchEvent,
} from "react";
import { LICENCE_VERSION, type AlbumManifest, type AlbumPhoto, type PhotoSession } from "../../shared/photos";
import licence from "../../shared/photo-licence.json";
import styles from "./Photos.module.css";

type Category = "all" | "favourites" | string;
type Notice = { kind: "error" | "success" | "info"; text: string } | null;
// Server error text is English-only; the UI chooses localized copy from the status.
class ApiError extends Error {
	constructor(readonly status: number) {
		super(`HTTP ${status}`);
	}
}
const statusOf = (error: unknown) => (error instanceof ApiError ? error.status : 0);
const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
	const response = await fetch(path, {
		credentials: "same-origin",
		...init,
		headers: {
			Accept: "application/json",
			...(init?.body ? { "Content-Type": "application/json" } : {}),
			...init?.headers,
		},
	});
	if (!response.ok) throw new ApiError(response.status);
	return (await response.json().catch(() => ({}))) as T;
};

function csrfHeaders(session: PhotoSession): Record<string, string> {
	const headers: Record<string, string> = {};
	if (session.csrfToken) headers["X-CSRF-Token"] = session.csrfToken;
	return headers;
}
function storageRead(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}
function storageWrite(key: string, value: string) {
	try {
		localStorage.setItem(key, value);
	} catch {
		/* Optional preferences stay in memory. */
	}
}
function languageFromStorage(): Language {
	return storageRead("hth-photo-language") === "fr" ? "fr" : "en";
}
function photoLabel(category: string, language: Language) {
	return categories[category]?.[language] || category.replace(/[-_]/g, " ");
}
function formatBytes(bytes: number, language: Language) {
	if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} ${language === "fr" ? "Ko" : "KB"}`;
	return `${(bytes / 1_000_000).toFixed(1)} ${language === "fr" ? "Mo" : "MB"}`;
}
function displayUrl(url: string) {
	return url.startsWith("/") ? url : `/${url.replace(/^\.?\//, "")}`;
}
function storedFavourites(key: string) {
	try {
		const value: unknown = JSON.parse(storageRead(key) || "[]");
		return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
	} catch {
		return new Set<string>();
	}
}

const focusableSelector =
	'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isTopmostDialog(node: HTMLElement | null) {
	if (!node) return false;
	const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'));
	return dialogs[dialogs.length - 1] === node;
}

let modalScrollLocks = 0;
let restorePageScroll: (() => void) | undefined;

function lockPageScroll() {
	if (modalScrollLocks++ === 0) {
		const body = document.body;
		const saved = body.getAttribute("style");
		const rootOverflow = document.documentElement.style.overflow;
		const { scrollX, scrollY } = window;
		const gutter = window.innerWidth - document.documentElement.clientWidth;
		body.style.paddingRight = `${parseFloat(getComputedStyle(body).paddingRight) + gutter}px`;
		body.style.position = "fixed";
		body.style.top = `-${scrollY}px`;
		body.style.left = `-${scrollX}px`;
		body.style.width = "100%";
		document.documentElement.style.overflow = "hidden";
		restorePageScroll = () => {
			if (saved === null) body.removeAttribute("style");
			else body.setAttribute("style", saved);
			document.documentElement.style.overflow = rootOverflow;
			window.scrollTo(scrollX, scrollY);
		};
	}
	return () => {
		if (--modalScrollLocks === 0) {
			restorePageScroll?.();
			restorePageScroll = undefined;
		}
	};
}

const inertLocks = new Map<HTMLElement, { count: number; previous: boolean }>();
function lockInert(element: HTMLElement) {
	const state = inertLocks.get(element) || { count: 0, previous: element.inert };
	state.count++;
	inertLocks.set(element, state);
	element.inert = true;
	return () => {
		if (--state.count === 0) {
			element.inert = state.previous;
			inertLocks.delete(element);
		}
	};
}

function useModalFocus(onClose: () => void) {
	const dialog = useRef<HTMLDivElement>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	useEffect(() => {
		const node = dialog.current;
		if (!node) return;
		const unlockScroll = lockPageScroll();
		const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const background: Array<() => void> = [];
		for (let current: HTMLElement = node; current.parentElement; current = current.parentElement) {
			for (const sibling of current.parentElement.children) {
				if (sibling instanceof HTMLElement && sibling !== current) {
					background.push(lockInert(sibling));
				}
			}
			if (current.parentElement === document.body) break;
		}
		const focusable = () =>
			Array.from(node.querySelectorAll<HTMLElement>(focusableSelector)).filter(
				item => !item.hasAttribute("aria-hidden") && item.offsetParent !== null,
			);
		(focusable()[0] || node).focus();
		const handleKeyDown = (event: KeyboardEvent) => {
			if (!isTopmostDialog(node)) return;
			if (event.key === "Escape") {
				event.preventDefault();
				onCloseRef.current();
				return;
			}
			if (event.key !== "Tab") return;
			const items = focusable();
			if (!items.length) {
				event.preventDefault();
				node.focus();
				return;
			}
			const first = items[0];
			const last = items[items.length - 1];
			if (!node.contains(document.activeElement)) {
				event.preventDefault();
				(event.shiftKey ? last : first).focus();
				return;
			}
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		};
		window.addEventListener("keydown", handleKeyDown, true);
		return () => {
			window.removeEventListener("keydown", handleKeyDown, true);
			unlockScroll();
			for (const unlock of background) unlock();
			window.requestAnimationFrame(() => {
				if (previousFocus?.isConnected) previousFocus.focus();
			});
		};
	}, []);
	return dialog;
}

function ModalDialog({
	className,
	onClose,
	labelledBy,
	children,
}: {
	className?: string;
	onClose: () => void;
	labelledBy: string;
	children: ReactNode;
}) {
	const dialog = useModalFocus(onClose);
	return (
		<div
			className={className || styles.dialog}
			role="dialog"
			aria-modal="true"
			aria-labelledby={labelledBy}
			tabIndex={-1}
			ref={dialog}
		>
			{children}
		</div>
	);
}

export default function Photos() {
	const [language, setLanguage] = useState<Language>(languageFromStorage);
	const [session, setSession] = useState<PhotoSession | null>(null);
	const [manifest, setManifest] = useState<AlbumManifest | null>(null);
	const [busy, setBusy] = useState(true);
	const [notice, setNotice] = useState<Notice>(null);
	const refreshingRef = useRef(false);
	const t = copy[language];
	const disconnectedLabelRef = useRef(t.disconnected);
	disconnectedLabelRef.current = t.disconnected;

	useEffect(() => {
		storageWrite("hth-photo-language", language);
		document.documentElement.lang = language;
	}, [language]);
	const loadSession = useCallback(async () => {
		setBusy(true);
		setNotice(null);
		try {
			const next = await api<PhotoSession>("/?action=session");
			setSession(next);
			if (next.authenticated) setManifest(await api<AlbumManifest>("/?action=album"));
		} catch {
			setNotice({ kind: "error", text: disconnectedLabelRef.current });
		} finally {
			setBusy(false);
		}
	}, []);
	const refreshAlbum = useCallback(async () => {
		if (!session?.authenticated || refreshingRef.current) return;
		refreshingRef.current = true;
		try {
			const nextSession = await api<PhotoSession>("/?action=session");
			if (!nextSession.authenticated) {
				setManifest(null);
				setSession({ authenticated: false });
				setNotice({ kind: "info", text: t.sessionExpired });
				return;
			}
			const nextManifest = await api<AlbumManifest>("/?action=album");
			setSession(nextSession);
			setManifest(nextManifest);
		} catch {
			// A quiet refresh should leave the current album usable during a transient outage.
		} finally {
			refreshingRef.current = false;
		}
	}, [session, t.sessionExpired]);
	useEffect(() => {
		if (!session?.authenticated) return;
		const refresh = () => {
			if (document.visibilityState === "visible") void refreshAlbum();
		};
		window.addEventListener("focus", refresh);
		document.addEventListener("visibilitychange", refresh);
		return () => {
			window.removeEventListener("focus", refresh);
			document.removeEventListener("visibilitychange", refresh);
		};
	}, [refreshAlbum, session?.authenticated]);
	useEffect(() => {
		void loadSession();
	}, [loadSession]);

	const signOut = async () => {
		if (!session) return;
		setNotice(null);
		try {
			await api("/?action=logout", { method: "POST", body: "{}", headers: csrfHeaders(session) });
		} catch {
			setNotice({ kind: "error", text: t.serviceError });
			return;
		}
		setManifest(null);
		setSession({ authenticated: false });
	};

	if (busy)
		return (
			<Shell language={language} setLanguage={setLanguage}>
				<main className={styles.centerState} aria-live="polite">
					<Spinner />
					{t.loading}
				</main>
			</Shell>
		);
	if (!session?.authenticated)
		return (
			<Auth
				language={language}
				setLanguage={setLanguage}
				onAuthenticated={next => {
					setBusy(true);
					setSession(next);
					void api<AlbumManifest>("/?action=album")
						.then(setManifest)
						.catch(() => setNotice({ kind: "error", text: t.disconnected }))
						.finally(() => setBusy(false));
				}}
				notice={notice}
				setNotice={setNotice}
			/>
		);
	if (!manifest)
		return (
			<Shell language={language} setLanguage={setLanguage}>
				<main className={styles.centerState}>
					<p>{t.disconnected}</p>
					<button className={styles.button} onClick={() => void loadSession()}>
						{t.retry}
					</button>
				</main>
			</Shell>
		);
	return (
		<Album
			language={language}
			setLanguage={setLanguage}
			session={session}
			manifest={manifest}
			setManifest={setManifest}
			onSignOut={signOut}
			notice={notice}
			setNotice={setNotice}
		/>
	);
}

function Shell({
	language,
	setLanguage,
	onSignOut,
	children,
}: {
	language: Language;
	setLanguage: (value: Language) => void;
	onSignOut?: () => void;
	children: ReactNode;
}) {
	const t = copy[language];
	return (
		<div className={styles.app}>
			<header className={styles.topbar}>
				<a href="/" className={styles.brand} aria-label="Hack the Hill III">
					<img src="/Logos/hackthehill-banner.svg" alt="" />
				</a>
				{onSignOut && <h1 className={styles.albumTitle}>{t.cover}</h1>}
				<div className={styles.topActions}>
					<button
						className={styles.language}
						onClick={() => setLanguage(language === "en" ? "fr" : "en")}
						lang={language === "en" ? "fr" : "en"}
					>
						{t.language}
					</button>
					{onSignOut && (
						<button className={styles.signOut} onClick={onSignOut}>
							{t.signout}
						</button>
					)}
				</div>
			</header>
			{children}
		</div>
	);
}

function Spinner() {
	return <span className={styles.spinner} aria-hidden="true" />;
}

function Auth({
	language,
	setLanguage,
	onAuthenticated,
	notice,
	setNotice,
}: {
	language: Language;
	setLanguage: (v: Language) => void;
	onAuthenticated: (s: PhotoSession) => void;
	notice: Notice;
	setNotice: (n: Notice) => void;
}) {
	const t = copy[language];
	const [email, setEmail] = useState("");
	const [code, setCode] = useState("");
	const [sent, setSent] = useState(false);
	const [seconds, setSeconds] = useState(60);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		if (!sent || seconds <= 0) return;
		const timer = window.setInterval(() => setSeconds(value => value - 1), 1_000);
		return () => window.clearInterval(timer);
	}, [sent, seconds]);
	const request = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setNotice(null);
		try {
			await api("/?action=request-code", {
				method: "POST",
				body: JSON.stringify({ email: email.trim(), language }),
			});
			setSent(true);
			setSeconds(60);
			setNotice({ kind: "info", text: t.unknown });
		} catch (error) {
			setNotice({ kind: "error", text: statusOf(error) === 429 ? t.rateLimited : t.serviceError });
		} finally {
			setBusy(false);
		}
	};
	const verify = async (event: FormEvent) => {
		event.preventDefault();
		if (code.length !== 8) return;
		setBusy(true);
		setNotice(null);
		try {
			onAuthenticated(
				await api<PhotoSession>("/?action=verify-code", {
					method: "POST",
					body: JSON.stringify({ email: email.trim(), code }),
				}),
			);
		} catch (error) {
			setNotice({ kind: "error", text: statusOf(error) === 401 ? t.invalidCode : t.serviceError });
		} finally {
			setBusy(false);
		}
	};
	return (
		<Shell language={language} setLanguage={setLanguage}>
			<main className={styles.authPage}>
				<section className={styles.authCard} aria-labelledby="auth-title">
					<h1 id="auth-title">{t.album}</h1>

					{sent ? (
						<form onSubmit={verify}>
							<label htmlFor="photo-code">{t.code}</label>
							<input
								id="photo-code"
								className={styles.codeInput}
								inputMode="numeric"
								autoComplete="one-time-code"
								maxLength={8}
								pattern="[0-9]{8}"
								value={code}
								onChange={event => setCode(event.target.value.replace(/\D/g, "").slice(0, 8))}
								onPaste={event => {
									const pasted = event.clipboardData.getData("text").replace(/\D/g, "").slice(0, 8);
									if (pasted) {
										event.preventDefault();
										setCode(pasted);
									}
								}}
								required
							/>
							<p className={styles.muted}>{t.sent}</p>
							<button className={styles.button} disabled={busy || code.length !== 8}>
								{busy ? <Spinner /> : t.verify}
							</button>
							<button
								type="button"
								className={styles.textButton}
								disabled={seconds > 0 || busy}
								onClick={request}
							>
								{seconds > 0 ? `${t.resendIn} ${seconds}s` : t.resend}
							</button>
						</form>
					) : (
						<form onSubmit={request}>
							<label htmlFor="photo-email">{t.email}</label>
							<input
								id="photo-email"
								type="email"
								autoComplete="email"
								value={email}
								onChange={event => setEmail(event.target.value)}
								required
							/>
							<button className={styles.button} disabled={busy}>
								{busy ? <Spinner /> : t.send}
							</button>
						</form>
					)}

					<p className={styles.support}>
						<a href="mailto:info@ctn-rtc.org">{t.support}</a>
					</p>
					{notice && <NoticeBox notice={notice} />}
				</section>
			</main>
		</Shell>
	);
}

function NoticeBox({ notice }: { notice: Notice }) {
	return notice ? (
		<div className={`${styles.notice} ${styles[notice.kind]}`} role={notice.kind === "error" ? "alert" : "status"}>
			{notice.text}
		</div>
	) : null;
}

function Album({
	language,
	setLanguage,
	session,
	manifest,
	setManifest,
	onSignOut,
	notice,
	setNotice,
}: {
	language: Language;
	setLanguage: (v: Language) => void;
	session: PhotoSession;
	manifest: AlbumManifest;
	setManifest: (m: AlbumManifest) => void;
	onSignOut: () => void;
	notice: Notice;
	setNotice: (n: Notice) => void;
}) {
	const t = copy[language];
	const [category, setCategory] = useState<Category>("all");
	const [filterOpen, setFilterOpen] = useState(false);
	const sharedPhotoId = new URLSearchParams(window.location.search).get("photo");
	const sharedPhoto = manifest.photos.find(item => item.id === sharedPhotoId) || null;
	const [viewer, setViewer] = useState<AlbumPhoto | null>(sharedPhoto);
	const [favourites, setFavourites] = useState<Set<string>>(() =>
		storedFavourites(`hth-photo-favourites:${session.accountId || "unknown"}`),
	);
	const [terms, setTerms] = useState<AlbumPhoto | null>(null);
	const [removal, setRemoval] = useState<AlbumPhoto | null>(null);
	useEffect(() => {
		const previousRestoration = window.history.scrollRestoration;
		window.history.scrollRestoration = "manual";
		const syncViewer = () => {
			const id = new URLSearchParams(window.location.search).get("photo");
			setTerms(null);
			setRemoval(null);
			setViewer(manifest.photos.find(item => item.id === id) || null);
		};
		window.addEventListener("popstate", syncViewer);
		return () => {
			window.removeEventListener("popstate", syncViewer);
			window.history.scrollRestoration = previousRestoration;
		};
	}, [manifest.photos]);
	useEffect(() => {
		const stillAvailable = (photo: AlbumPhoto | null) =>
			!photo || manifest.photos.some(item => item.id === photo.id);
		if (stillAvailable(viewer) && stillAvailable(terms) && stillAvailable(removal)) return;
		setViewer(current => (stillAvailable(current) ? current : null));
		setTerms(current => (stillAvailable(current) ? current : null));
		setRemoval(current => (stillAvailable(current) ? current : null));
		window.history.replaceState({}, "", "/");
		setNotice({ kind: "info", text: t.unavailable });
	}, [manifest.photos, removal, setNotice, t.unavailable, terms, viewer]);
	const closeViewer = () => {
		if (window.history.state?.photoViewer) window.history.back();
		else {
			setViewer(null);
			window.history.replaceState(null, "", "/");
		}
	};
	const categoryCounts = useMemo(
		() =>
			manifest.photos.reduce<Record<string, number>>((counts, photo) => {
				counts[photo.category] = (counts[photo.category] || 0) + 1;
				return counts;
			}, {}),
		[manifest.photos],
	);
	const filtered = useMemo(
		() =>
			manifest.photos.filter(
				photo =>
					category === "all" ||
					(category === "favourites" ? favourites.has(photo.id) : photo.category === category),
			),
		[manifest.photos, category, favourites],
	);
	const filterOptions = [
		{ value: "all", label: t.all, count: manifest.photos.length },
		{
			value: "favourites",
			label: t.favourites,
			count: manifest.photos.filter(photo => favourites.has(photo.id)).length,
		},
		...Object.keys(categories)
			.filter(key => categoryCounts[key])
			.map(key => ({ value: key, label: photoLabel(key, language), count: categoryCounts[key] })),
	];
	const selectedFilter = filterOptions.find(option => option.value === category) || filterOptions[0];
	const toggleFavourite = (id: string) =>
		setFavourites(previous => {
			const next = new Set(previous);
			next.has(id) ? next.delete(id) : next.add(id);
			storageWrite(`hth-photo-favourites:${session.accountId || "unknown"}`, JSON.stringify([...next]));
			return next;
		});
	return (
		<Shell language={language} setLanguage={setLanguage} onSignOut={onSignOut}>
			<main className={styles.album}>
				{sharedPhotoId && !sharedPhoto && (
					<div className={styles.notice} role="status">
						{t.unavailable}
					</div>
				)}
				<div className={styles.toolbar}>
					<span className={styles.filterLabel} id="filter-label">
						{t.filterPhotos}
					</span>
					<div className={styles.categoryNav} role="group" aria-labelledby="filter-label">
						{filterOptions.map(option => (
							<button
								key={option.value}
								aria-pressed={category === option.value}
								className={category === option.value ? styles.activeTab : ""}
								onClick={() => setCategory(option.value)}
							>
								{option.label} <span>{option.count}</span>
							</button>
						))}
					</div>
					<button
						className={styles.mobileFilter}
						aria-haspopup="dialog"
						aria-expanded={filterOpen}
						onClick={() => setFilterOpen(true)}
					>
						<span>
							{t.filter}: {selectedFilter.label} · {selectedFilter.count}
						</span>
						<span aria-hidden="true">⌄</span>
					</button>
				</div>
				{notice && <NoticeBox notice={notice} />}
				{filtered.length ? (
					<ul className={styles.grid}>
						{filtered.map((photo, index) => (
							<li key={photo.id}>
								<article className={styles.photoCard}>
									<button
										className={styles.photoButton}
										onClick={() => {
											setViewer(photo);
											window.history.pushState(
												{ photoViewer: true },
												"",
												`/?photo=${encodeURIComponent(photo.id)}`,
											);
										}}
										aria-label={`${t.view}: ${photoLabel(photo.category, language)} ${index + 1}`}
									>
										<img
											src={displayUrl(photo.thumbnail.url)}
											alt=""
											loading="lazy"
											width={photo.thumbnail.width}
											height={photo.thumbnail.height}
										/>
										<span className={styles.viewLabel}>{t.view}</span>
									</button>
									<button
										className={`${styles.favourite} ${favourites.has(photo.id) ? styles.favouriteOn : ""}`}
										onClick={() => toggleFavourite(photo.id)}
										aria-label={favourites.has(photo.id) ? t.removeFavourite : t.addFavourite}
										aria-pressed={favourites.has(photo.id)}
									>
										{favourites.has(photo.id) ? "♥" : "♡"}
									</button>
									{Boolean(photo.activity?.views || photo.activity?.downloadRequests) && (
										<div className={styles.cardMeta}>
											<div>
												<span>
													{[
														photo.activity?.views
															? `${photo.activity.views} ${photo.activity.views === 1 ? t.oneView : t.views}`
															: "",
														photo.activity?.downloadRequests
															? `${photo.activity.downloadRequests} ${photo.activity.downloadRequests === 1 ? t.oneDownload : t.downloadRequests}`
															: "",
													]
														.filter(Boolean)
														.join(" · ")}
												</span>
											</div>
										</div>
									)}
								</article>
							</li>
						))}
					</ul>
				) : (
					<div className={styles.empty}>
						<span aria-hidden="true">✦</span>
						<p>{category === "favourites" ? t.emptyFavourites : t.empty}</p>
					</div>
				)}
			</main>
			{filterOpen && (
				<div
					className={styles.sheetBackdrop}
					onClick={event => {
						if (event.target === event.currentTarget) setFilterOpen(false);
					}}
				>
					<ModalDialog
						className={styles.filterSheet}
						onClose={() => setFilterOpen(false)}
						labelledBy="filter-title"
					>
						<div className={styles.sheetHeader}>
							<h2 id="filter-title">{t.filterPhotos}</h2>
							<button
								className={styles.iconButton}
								onClick={() => setFilterOpen(false)}
								aria-label={t.closeFilters}
							>
								×
							</button>
						</div>
						<div className={styles.filterOptions}>
							{filterOptions.map(option => (
								<button
									key={option.value}
									aria-pressed={category === option.value}
									onClick={() => {
										setCategory(option.value);
										setFilterOpen(false);
									}}
								>
									<span className={styles.filterCheck} aria-hidden="true">
										{category === option.value ? "✓" : ""}
									</span>
									<span>{option.label}</span>
									<span className={styles.filterCount}>{option.count}</span>
								</button>
							))}
						</div>
					</ModalDialog>
				</div>
			)}
			{viewer && (
				<Viewer
					photo={viewer}
					photos={filtered}
					language={language}
					session={session}
					favourites={favourites}
					onToggleFavourite={toggleFavourite}
					onClose={closeViewer}
					onNavigate={setViewer}
					onTerms={setTerms}
					onRemoval={setRemoval}
				/>
			)}
			{terms && (
				<LicenceDialog
					language={language}
					photo={terms}
					session={session}
					onClose={() => setTerms(null)}
					setNotice={setNotice}
				/>
			)}
			{removal && (
				<RemovalDialog
					language={language}
					photo={removal}
					session={session}
					onClose={() => setRemoval(null)}
					onHidden={photo => {
						setManifest({ ...manifest, photos: manifest.photos.filter(item => item.id !== photo.id) });
						closeViewer();
						setNotice({ kind: "success", text: t.hidden });
					}}
				/>
			)}
		</Shell>
	);
}

function PhotoPreview({ photo, language }: { photo: AlbumPhoto; language: Language }) {
	const t = copy[language];
	const image = useRef<HTMLImageElement>(null);
	const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		if (image.current?.complete && image.current.naturalWidth > 0) setStatus("ready");
	}, [attempt]);
	return (
		<>
			<img
				key={attempt}
				ref={image}
				className={styles.viewerImage}
				style={{ visibility: status === "ready" ? "visible" : "hidden" }}
				src={displayUrl(photo.preview.url)}
				alt=""
				width={photo.preview.width}
				height={photo.preview.height}
				onLoad={() => setStatus("ready")}
				onError={() => setStatus("error")}
			/>
			{status !== "ready" && (
				<div className={styles.previewStatus} role="status">
					{status === "loading" ? (
						<>
							<Spinner /> {t.loading}
						</>
					) : (
						<>
							<p>{t.imageError}</p>
							<button
								className={styles.outlineButton}
								onClick={() => {
									setStatus("loading");
									setAttempt(value => value + 1);
								}}
							>
								{t.retry}
							</button>
						</>
					)}
				</div>
			)}
		</>
	);
}

function Viewer({
	photo,
	photos,
	language,
	session,
	favourites,
	onToggleFavourite,
	onClose,
	onNavigate,
	onTerms,
	onRemoval,
}: {
	photo: AlbumPhoto;
	photos: AlbumPhoto[];
	language: Language;
	session: PhotoSession;
	favourites: Set<string>;
	onToggleFavourite: (id: string) => void;
	onClose: () => void;
	onNavigate: (photo: AlbumPhoto) => void;
	onTerms: (p: AlbumPhoto) => void;
	onRemoval: (p: AlbumPhoto) => void;
}) {
	const t = copy[language];
	const position = photos.findIndex(item => item.id === photo.id);
	const current = photo;
	const dialog = useModalFocus(onClose);
	const touchStart = useRef<number | null>(null);
	const queue = useRef<Set<string>>(new Set());
	const navigate = useCallback(
		(delta: number) => {
			const nextPosition = (position + delta + photos.length) % photos.length;
			const next = photos[nextPosition];
			if (next) {
				onNavigate(next);
				window.history.replaceState(window.history.state, "", `/?photo=${encodeURIComponent(next.id)}`);
			}
		},
		[photos, position, onNavigate],
	);
	useEffect(() => {
		const key = (event: globalThis.KeyboardEvent) => {
			if (!isTopmostDialog(dialog.current)) return;
			if (event.key === "ArrowLeft") navigate(-1);
			if (event.key === "ArrowRight") navigate(1);
		};
		window.addEventListener("keydown", key);
		queue.current.add(current.id);
		const timer = window.setTimeout(() => {
			if (queue.current.size) {
				const ids = [...queue.current];
				queue.current.clear();
				void api("/?action=events", {
					method: "POST",
					body: JSON.stringify({ photoIds: ids }),
					headers: csrfHeaders(session),
				}).catch(() => undefined);
			}
		}, 700);
		return () => {
			window.removeEventListener("keydown", key);
			window.clearTimeout(timer);
		};
	}, [navigate, current.id, session, dialog]);
	const handleTouchStart = (event: TouchEvent) => {
		touchStart.current = event.changedTouches[0]?.clientX ?? null;
	};
	const handleTouchEnd = (event: TouchEvent) => {
		if (touchStart.current === null) return;
		const difference = (event.changedTouches[0]?.clientX ?? 0) - touchStart.current;
		if (Math.abs(difference) > 50) navigate(difference > 0 ? -1 : 1);
		touchStart.current = null;
	};
	return (
		<div className={styles.modalBackdrop} role="presentation">
			<div
				className={styles.viewer}
				role="dialog"
				aria-modal="true"
				aria-labelledby="viewer-title"
				tabIndex={-1}
				ref={dialog}
				onTouchStart={handleTouchStart}
				onTouchEnd={handleTouchEnd}
			>
				<div className={styles.viewerTop}>
					<h2 id="viewer-title" className={styles.viewerCategory}>
						{photoLabel(current.category, language)}
					</h2>
					<button className={styles.iconButton} onClick={onClose} aria-label={t.close}>
						×
					</button>
				</div>
				<div className={styles.viewerImageWrap}>
					<button
						className={`${styles.viewerArrow} ${styles.viewerPrev}`}
						onClick={() => navigate(-1)}
						aria-label={t.previous}
					>
						‹
					</button>
					<PhotoPreview key={current.id} photo={current} language={language} />
					<button
						className={`${styles.viewerArrow} ${styles.viewerNext}`}
						onClick={() => navigate(1)}
						aria-label={t.next}
					>
						›
					</button>
				</div>
				<div className={styles.viewerInfo}>
					<div>
						<p>
							{current.width} × {current.height} px ·{" "}
							{formatBytes(current.downloads.full.bytes, language)}
						</p>
						<div className={styles.viewerActions}>
							<button className={styles.button} onClick={() => onTerms(current)}>
								{t.download}
							</button>
							<button className={styles.textButton} onClick={() => onRemoval(current)}>
								{t.removal}
							</button>
						</div>
					</div>
					<button
						className={`${styles.favouriteLarge} ${favourites.has(current.id) ? styles.favouriteOn : ""}`}
						onClick={() => onToggleFavourite(current.id)}
						aria-label={favourites.has(current.id) ? t.removeFavourite : t.addFavourite}
						aria-pressed={favourites.has(current.id)}
					>
						{favourites.has(current.id) ? "♥" : "♡"}
					</button>
				</div>
			</div>
		</div>
	);
}

function LicenceDialog({
	language,
	photo,
	session,
	onClose,
	setNotice,
}: {
	language: Language;
	photo: AlbumPhoto;
	session: PhotoSession;
	onClose: () => void;
	setNotice: (n: Notice) => void;
}) {
	const t = copy[language];
	const [busy, setBusy] = useState(false);
	const acknowledge = async (format: "full" | "quick") => {
		setBusy(true);
		try {
			await api("/?action=licence", {
				method: "POST",
				body: JSON.stringify({ version: LICENCE_VERSION }),
				headers: csrfHeaders(session),
			});
			const url = `/?action=download&photo=${encodeURIComponent(photo.id)}&format=${format}&requestId=${crypto.randomUUID()}`;
			// Check one byte first so a refusal shows a message instead of a raw JSON
			// page. Reusing the request ID makes the real download an idempotent retry.
			const check = await fetch(url, { credentials: "same-origin", headers: { Range: "bytes=0-0" } });
			void check.body?.cancel();
			if (!check.ok) throw new ApiError(check.status);
			window.location.assign(url);
		} catch (error) {
			const status = statusOf(error);
			setNotice({
				kind: "error",
				text:
					status === 404
						? t.unavailable
						: status === 401
							? t.sessionExpired
							: status === 409 || status === 428
								? t.licenceChanged
								: t.serviceError,
			});
			setBusy(false);
		}
	};
	return (
		<div className={styles.modalBackdrop}>
			<ModalDialog
				className={`${styles.dialog} ${styles.licenceDialog}`}
				onClose={onClose}
				labelledBy="licence-title"
			>
				<button className={styles.dialogClose} onClick={onClose} aria-label={t.cancel}>
					×
				</button>
				<h2 id="licence-title">{t.terms}</h2>
				<p className={styles.licenceSummary}>{t.licenceSummary}</p>
				<div className={styles.licenceText} lang={language}>
					{licence[language].slice(1).map((line, index) =>
						// Section positions in the approved bilingual licence; its first line is the dialog title.
						[2, 4, 10, 13, 15].includes(index + 1) ? (
							<h3 key={index}>{line}</h3>
						) : (
							<p key={index}>{line}</p>
						),
					)}
				</div>
				<div className={styles.downloadChoices}>
					<button className={styles.button} disabled={busy} onClick={() => void acknowledge("full")}>
						{t.continue} · {t.full}
					</button>
					<button className={styles.outlineButton} disabled={busy} onClick={() => void acknowledge("quick")}>
						{t.continue} · {t.quick}
					</button>
					<button className={styles.textButton} onClick={onClose}>
						{t.cancel}
					</button>
				</div>
			</ModalDialog>
		</div>
	);
}

function RemovalDialog({
	language,
	photo,
	session,
	onClose,
	onHidden,
}: {
	language: Language;
	photo: AlbumPhoto;
	session: PhotoSession;
	onClose: () => void;
	onHidden: (p: AlbumPhoto) => void;
}) {
	const t = copy[language];
	const [explanation, setExplanation] = useState("");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const requestId = useRef<string | null>(null);
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!explanation.trim()) return;
		setBusy(true);
		setFailure(null);
		// Edits keep the same ID: if an earlier attempt reached the server, the
		// retry returns that request instead of creating a second one.
		requestId.current ||= crypto.randomUUID();
		try {
			await api(`/?action=remove&photo=${encodeURIComponent(photo.id)}`, {
				method: "POST",
				body: JSON.stringify({ explanation: explanation.trim(), requestId: requestId.current }),
				headers: csrfHeaders(session),
			});
			onHidden(photo);
		} catch (error) {
			const status = statusOf(error);
			setFailure(status === 429 ? t.removalLimit : status === 404 ? t.unavailable : t.serviceError);
			setBusy(false);
		}
	};
	return (
		<div className={styles.modalBackdrop}>
			<ModalDialog onClose={onClose} labelledBy="removal-title">
				<button className={styles.dialogClose} onClick={onClose} aria-label={t.cancel}>
					×
				</button>
				<h2 id="removal-title">{t.removal}</h2>
				<p>{t.removalHelp}</p>
				{failure && (
					<p className={`${styles.notice} ${styles.error}`} role="alert">
						{failure}
					</p>
				)}
				<form onSubmit={submit}>
					<label htmlFor="removal-explanation">{t.explanation}</label>
					<textarea
						id="removal-explanation"
						rows={5}
						value={explanation}
						onChange={event => setExplanation(event.target.value)}
						required
					/>
					<div className={styles.dialogActions}>
						<button className={styles.button} disabled={busy || !explanation.trim()}>
							{busy ? t.processing : t.sendRemoval}
						</button>
						<button type="button" className={styles.textButton} onClick={onClose}>
							{t.cancel}
						</button>
					</div>
				</form>
			</ModalDialog>
		</div>
	);
}
