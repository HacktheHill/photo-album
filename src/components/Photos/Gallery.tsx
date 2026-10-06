import { useEffect, useState } from "react";
import Photos from "./Photos";
import Restore from "./Restore";

// The album and email restoration route share the same app.
export default function Gallery() {
	const [restoration, setRestoration] = useState<{ caseId: string; version: number } | null | undefined>();
	useEffect(() => {
		const query = new URLSearchParams(window.location.search);
		const isRestoration = window.location.pathname.replace(/\/$/, "") === "/restore";
		setRestoration(
			isRestoration ? { caseId: query.get("case") ?? "", version: Number(query.get("version")) } : null,
		);
	}, []);
	if (restoration === undefined) return null;
	return restoration ? <Restore {...restoration} /> : <Photos />;
}
