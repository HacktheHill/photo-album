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
	const body = (await response.json().catch(() => ({}))) as T & { error?: string };
	if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
	return body;
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
function storageRemove(key: string) {
	try {
		localStorage.removeItem(key);
	} catch {
		/* Session revocation is enforced server-side. */
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

function useModalFocus(onClose: () => void) {
	const dialog = useRef<HTMLDivElement>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	useEffect(() => {
		const node = dialog.current;
		if (!node) return;
		const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
				storageRemove(`hth-photo-favourites:${session.accountId || "unknown"}`);
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
		} catch (error) {
			setNotice({ kind: "error", text: error instanceof Error ? error.message : t.serviceError });
			return;
		}
		storageRemove(`hth-photo-favourites:${session.accountId || "unknown"}`);
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
			setNotice({ kind: "error", text: error instanceof Error ? error.message : t.serviceError });
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
			setNotice({ kind: "error", text: error instanceof Error ? error.message : t.serviceError });
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
	const sharedPhotoId = new URLSearchParams(window.location.search).get("photo");
	const sharedPhoto = manifest.photos.find(item => item.id === sharedPhotoId) || null;
	const [viewer, setViewer] = useState<AlbumPhoto | null>(sharedPhoto);
	const [favourites, setFavourites] = useState<Set<string>>(() =>
		storedFavourites(`hth-photo-favourites:${session.accountId || "unknown"}`),
	);
	const [terms, setTerms] = useState<AlbumPhoto | null>(null);
	const [removal, setRemoval] = useState<AlbumPhoto | null>(null);
	const visitSent = useRef(false);
	useEffect(() => {
		if (visitSent.current) return;
		visitSent.current = true;
		void api("/?action=events", {
			method: "POST",
			body: JSON.stringify({ photoIds: [], albumVisit: true }),
			headers: csrfHeaders(session),
		}).catch(() => undefined);
	}, [session]);
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
	const coverPhoto =
		manifest.photos.find(item => item.category === "Opening Ceremony" && item.filename === "DSC_3416.jpg") ||
		manifest.photos.find(item => item.category === "Closing Ceremony") ||
		manifest.photos[0];
	const closeViewer = () => {
		setViewer(null);
		window.history.replaceState({}, "", "/");
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
				<section className={styles.albumHero}>
					<div>
						<h1>{t.cover}</h1>
					</div>
					{coverPhoto ? (
						<div className={styles.heroPhoto}>
							<img
								src={displayUrl(coverPhoto.thumbnail.url)}
								alt=""
								width={coverPhoto.thumbnail.width}
								height={coverPhoto.thumbnail.height}
							/>
						</div>
					) : (
						<div className={styles.heroStamp} aria-hidden="true">
							<strong>{new Set(manifest.photos.map(photo => photo.category)).size}</strong>
							<span>{language === "en" ? "chapters" : "chapitres"}</span>
						</div>
					)}
				</section>
				{sharedPhotoId && !sharedPhoto && (
					<div className={styles.notice} role="status">
						{t.unavailable}
					</div>
				)}
				<div className={styles.toolbar}>
					<nav
						className={styles.categoryNav}
						aria-label={language === "en" ? "Photo categories" : "Catégories de photos"}
					>
						<button
							className={category === "all" ? styles.activeTab : ""}
							onClick={() => setCategory("all")}
						>
							{t.all} <span>{manifest.photos.length}</span>
						</button>
						<button
							className={category === "favourites" ? styles.activeTab : ""}
							onClick={() => setCategory("favourites")}
						>
							{t.favourites} <span>{favourites.size}</span>
						</button>
						{Object.keys(categories)
							.filter(key => categoryCounts[key])
							.map(key => (
								<button
									key={key}
									className={category === key ? styles.activeTab : ""}
									onClick={() => setCategory(key)}
								>
									{photoLabel(key, language)} <span>{categoryCounts[key]}</span>
								</button>
							))}
					</nav>
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
											window.history.replaceState(
												{},
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
									<div className={styles.cardMeta}>
										<div>
											<strong>{photoLabel(photo.category, language)}</strong>
											<span>
												{photo.activity?.views ?? 0} {t.views} ·{" "}
												{photo.activity?.downloadRequests ?? 0} {t.downloadRequests}
											</span>
										</div>
										<button
											className={`${styles.favourite} ${favourites.has(photo.id) ? styles.favouriteOn : ""}`}
											onClick={() => toggleFavourite(photo.id)}
											aria-label={favourites.has(photo.id) ? t.removeFavourite : t.addFavourite}
											aria-pressed={favourites.has(photo.id)}
										>
											{favourites.has(photo.id) ? "♥" : "♡"}
										</button>
									</div>
								</article>
							</li>
						))}
					</ul>
				) : (
					<div className={styles.empty}>
						<span aria-hidden="true">✦</span>
						<p>{t.empty}</p>
					</div>
				)}
			</main>
			{viewer && (
				<Viewer
					photo={viewer}
					photos={filtered}
					language={language}
					session={session}
					favourites={favourites}
					onToggleFavourite={toggleFavourite}
					onClose={closeViewer}
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

function Viewer({
	photo,
	photos,
	language,
	session,
	favourites,
	onToggleFavourite,
	onClose,
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
	onTerms: (p: AlbumPhoto) => void;
	onRemoval: (p: AlbumPhoto) => void;
}) {
	const t = copy[language];
	const initialIndex = Math.max(
		0,
		photos.findIndex(item => item.id === photo.id),
	);
	const [position, setPosition] = useState(initialIndex);
	const current = photos[position] || photo;
	const dialog = useModalFocus(onClose);
	const touchStart = useRef<number | null>(null);
	const queue = useRef<Set<string>>(new Set());
	const navigate = useCallback(
		(delta: number) => {
			const nextPosition = (position + delta + photos.length) % photos.length;
			const next = photos[nextPosition];
			if (next) {
				setPosition(nextPosition);
				window.history.replaceState({}, "", `/?photo=${encodeURIComponent(next.id)}`);
			}
		},
		[photos, position],
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
					body: JSON.stringify({ photoIds: ids, albumVisit: false }),
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
					<img
						className={styles.viewerImage}
						src={displayUrl(current.preview.url)}
						alt=""
						width={current.preview.width}
						height={current.preview.height}
					/>
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
				<div className={styles.viewerActions}>
					<button className={styles.button} onClick={() => onTerms(current)}>
						↓ {t.download}
					</button>
					<button className={styles.textButton} onClick={() => onRemoval(current)}>
						{t.removal}
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
			const requestId = crypto.randomUUID();
			window.location.assign(
				`/?action=download&photo=${encodeURIComponent(photo.id)}&format=${format}&requestId=${requestId}`,
			);
		} catch (error) {
			setNotice({ kind: "error", text: error instanceof Error ? error.message : t.serviceError });
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
		requestId.current ||= crypto.randomUUID();
		try {
			await api(`/?action=remove&photo=${encodeURIComponent(photo.id)}`, {
				method: "POST",
				body: JSON.stringify({ explanation: explanation.trim(), requestId: requestId.current }),
				headers: csrfHeaders(session),
			});
			onHidden(photo);
		} catch {
			setFailure(t.serviceError);
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
						onChange={event => {
							setExplanation(event.target.value);
							requestId.current = null;
						}}
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
