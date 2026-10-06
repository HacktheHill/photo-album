/** Browser-safe contract: no object keys, roster, edit notes or private reports. */
export const LICENCE_VERSION = "2026-10-06";
export type PhotoLanguage = "en" | "fr";
export type PhotoFormat = "full" | "quick";
export interface PhotoVariant {
	url: string;
	width: number;
	height: number;
	bytes: number;
}
export interface PhotoActivity {
	views: number;
	downloadRequests: number;
}
export interface AlbumPhoto {
	id: string;
	category: string;
	filename: string;
	version: string;
	width: number;
	height: number;
	thumbnail: PhotoVariant;
	preview: PhotoVariant;
	downloads: Record<PhotoFormat, { width: number; height: number; bytes: number }>;
	activity: PhotoActivity;
}
export interface AlbumManifest {
	version: string;
	photos: AlbumPhoto[];
	activity: PhotoActivity;
}
export interface PhotoSession {
	authenticated: boolean;
	csrfToken?: string;
	accountId?: string;
	licenceVersion?: string;
	expiresAt?: number;
}
export interface RestoreResponse {
	filename: string;
	canRestore: boolean;
	photoVersion: number;
	csrfToken: string;
	status: string;
}
