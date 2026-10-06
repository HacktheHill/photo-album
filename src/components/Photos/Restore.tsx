import { useEffect, useRef, useState } from "react";
import styles from "./Restore.module.css";
import type { RestoreResponse } from "../../shared/photos";

type Language = "en" | "fr";
type Copy = {
	brand: string;
	title: string;
	loading: string;
	missing: string;
	accessUnavailable: string;
	accessLink: string;
	loadError: string;
	retry: string;
	alreadyRestored: string;
	cannotRestore: string;
	versionMismatch: string;
	prompt: string;
	restore: string;
	restored: string;
	back: string;
	error: string;
	language: string;
};

const copy: Record<Language, Copy> = {
	en: {
		brand: "Hack the Hill III",
		title: "Restore photo",
		loading: "Loading…",
		missing: "No restore request was specified.",
		accessUnavailable: "Access is required to restore this photo.",
		accessLink: "Continue with CTN Google Workspace",
		loadError: "We could not load this restore request. Try again.",
		retry: "Try again",
		alreadyRestored: "This photo is already available.",
		cannotRestore: "This photo cannot be restored from this request.",
		versionMismatch: "This case has changed. Open the latest notification before restoring the photo.",
		prompt: "This will make the photo available again.",
		restore: "Restore photo",
		restored: "Photo restored. It is available in the album again.",
		back: "Back to album",
		error: "We could not restore this photo. Try again.",
		language: "Français",
	},
	fr: {
		brand: "Hack the Hill III",
		title: "Restaurer la photo",
		loading: "Chargement…",
		missing: "Aucune demande de restauration n’a été indiquée.",
		accessUnavailable: "L’accès est requis pour restaurer cette photo.",
		accessLink: "Continuer avec Google Workspace de CTN",
		loadError: "Impossible de charger cette demande de restauration. Réessayez.",
		retry: "Réessayer",
		alreadyRestored: "Cette photo est déjà disponible.",
		cannotRestore: "Cette photo ne peut pas être restaurée à partir de cette demande.",
		versionMismatch: "Ce dossier a changé. Ouvrez la plus récente notification avant de restaurer la photo.",
		prompt: "La photo redeviendra disponible.",
		restore: "Restaurer la photo",
		restored: "Photo restaurée. Elle est de nouveau disponible dans l’album.",
		back: "Retour à l’album",
		error: "Impossible de restaurer cette photo. Réessayez.",
		language: "English",
	},
};

type ErrorState = "missing" | "forbidden" | "load" | "version" | "alreadyRestored" | "cannotRestore" | null;

export default function Restore({ caseId, version }: { caseId: string; version: number }) {
	const [language, setLanguage] = useState<Language>("en");
	const [data, setData] = useState<RestoreResponse | null>(null);
	const [error, setError] = useState<ErrorState>(
		caseId && Number.isSafeInteger(version) && version > 0 ? null : "missing",
	);
	const [loading, setLoading] = useState(Boolean(caseId && Number.isSafeInteger(version) && version > 0));
	const [saving, setSaving] = useState(false);
	const [restored, setRestored] = useState(false);
	const [notice, setNotice] = useState<"error" | null>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const t = copy[language];

	useEffect(() => {
		try {
			if (window.localStorage.getItem("hth-photo-language") === "fr") setLanguage("fr");
		} catch {
			/* Language remains usable when browser storage is unavailable. */
		}
	}, []);
	useEffect(() => {
		try {
			window.localStorage.setItem("hth-photo-language", language);
		} catch {
			/* Keep the current selection in memory. */
		}
		document.documentElement.lang = language;
	}, [language]);

	const load = async () => {
		if (!caseId || !Number.isSafeInteger(version) || version < 1) {
			setError("missing");
			setLoading(false);
			return;
		}
		setLoading(true);
		setError(null);
		setNotice(null);
		try {
			const response = await fetch(
				`/restore?action=case&case=${encodeURIComponent(caseId)}&version=${encodeURIComponent(String(version))}`,
				{
					credentials: "same-origin",
					headers: { Accept: "application/json" },
				},
			);
			if (response.status === 403) {
				setError("forbidden");
				return;
			}
			if (response.status === 409) {
				setError("version");
				return;
			}
			if (!response.ok) throw new Error("load");
			const body = (await response.json()) as RestoreResponse;
			setData(body);
			if (body.photoVersion !== version) setError("version");
			else if (!body.canRestore) setError(body.status === "dismissed" ? "alreadyRestored" : "cannotRestore");
		} catch {
			setError("load");
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		void load();
		// The case and version identify the request; load only when either changes.
	}, [caseId, version]);

	useEffect(() => {
		if (!loading) headingRef.current?.focus();
	}, [error, loading, restored]);

	const restore = async () => {
		if (!data?.canRestore || data.photoVersion !== version || saving) return;
		setSaving(true);
		setError(null);
		setNotice(null);
		try {
			const response = await fetch(
				`/restore?action=case&case=${encodeURIComponent(caseId)}&version=${encodeURIComponent(String(version))}`,
				{
					method: "POST",
					credentials: "same-origin",
					headers: {
						Accept: "application/json",
						"Content-Type": "application/json",
						"X-CSRF-Token": data.csrfToken,
					},
					body: JSON.stringify({ expectedVersion: version }),
				},
			);
			if (response.status === 409) {
				setError("version");
				return;
			}
			if (!response.ok) throw new Error("save");
			setRestored(true);
		} catch {
			setNotice("error");
		} finally {
			setSaving(false);
		}
	};

	const accessUrl = `/restore?case=${encodeURIComponent(caseId)}&version=${encodeURIComponent(String(version))}`;
	const heading =
		error === "missing"
			? t.missing
			: error === "forbidden"
				? t.accessUnavailable
				: error === "load"
					? t.loadError
					: error === "version"
						? t.versionMismatch
						: error === "alreadyRestored"
							? t.alreadyRestored
							: error === "cannotRestore"
								? t.cannotRestore
								: restored
									? t.restored
									: t.title;

	return (
		<div className={styles.app}>
			<header className={styles.topbar}>
				<a className={styles.brand} href="/" aria-label={t.brand}>
					<img src="/Logos/hackthehill-banner.svg" alt="" />
				</a>
				<button
					className={styles.language}
					type="button"
					onClick={() => setLanguage(language === "en" ? "fr" : "en")}
					lang={language === "en" ? "fr" : "en"}
				>
					{t.language}
				</button>
			</header>
			<main className={styles.page}>
				<section className={styles.card} aria-live="polite">
					<h1 tabIndex={-1} ref={headingRef}>
						{loading ? t.loading : heading}
					</h1>
					{!loading && data?.filename ? <p className={styles.filename}>{data.filename}</p> : null}
					{error === "forbidden" ? (
						<a className={styles.button} href={accessUrl}>
							{t.accessLink}
						</a>
					) : null}
					{error === "load" ? (
						<button className={styles.outlineButton} type="button" onClick={() => void load()}>
							{t.retry}
						</button>
					) : null}
					{!loading && !error && !restored && data?.canRestore ? (
						<div className={styles.action}>
							<p>{t.prompt}</p>
							{notice === "error" ? (
								<p className={styles.error} role="alert">
									{t.error}
								</p>
							) : null}
							<button
								className={styles.button}
								type="button"
								onClick={() => void restore()}
								disabled={saving}
								aria-busy={saving}
							>
								{saving ? t.loading : t.restore}
							</button>
						</div>
					) : null}
					{restored || error === "version" || error === "alreadyRestored" || error === "cannotRestore" ? (
						<a className={styles.link} href="/">
							{t.back}
						</a>
					) : null}
				</section>
			</main>
		</div>
	);
}
