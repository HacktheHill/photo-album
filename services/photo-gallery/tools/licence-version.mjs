import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(toolDirectory, "../../..");
export const defaultSourcePath = resolve(repositoryRoot, "src/shared/photos.ts");
export const defaultLicencePath = resolve(repositoryRoot, "src/shared/photo-licence.json");

export async function sourceLicenceVersion(sourcePath = defaultSourcePath) {
	const source = await readFile(sourcePath, "utf8");
	const match = source.match(/export\s+const\s+LICENCE_VERSION\s*=\s*["']([^"']+)["']/);
	if (!match) throw new Error(`Could not find LICENCE_VERSION in ${sourcePath}`);
	return match[1];
}

export function validateLicenceVersion(requestedVersion, sourceVersion, configuredVersion) {
	const version = String(requestedVersion || sourceVersion || "").trim();
	if (!version) throw new Error("A licence version is required");
	if (version !== sourceVersion)
		throw new Error(`Licence version ${version} does not match src/shared/photos.ts (${sourceVersion})`);
	if (configuredVersion != null && String(configuredVersion).trim() !== version)
		throw new Error(
			`CURRENT_LICENCE_VERSION ${String(configuredVersion).trim()} does not match src/shared/photos.ts (${version})`,
		);
	return version;
}

export function validateCurrentLicenceVersions(currentVersions, sourceVersion) {
	const versions = [...new Set(currentVersions.map(version => String(version).trim()).filter(Boolean))];
	const mismatches = versions.filter(version => version !== sourceVersion);
	if (mismatches.length)
		throw new Error(
			`Refusing to seed licence ${sourceVersion}; D1 currently marks ${mismatches.join(", ")} as current`,
		);
	return { hasCurrent: versions.length > 0, version: sourceVersion };
}
