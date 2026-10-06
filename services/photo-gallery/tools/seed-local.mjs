import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getPlatformProxy } from "wrangler";
import {
	defaultLicencePath,
	defaultSourcePath,
	sourceLicenceVersion,
	validateCurrentLicenceVersions,
	validateLicenceVersion,
} from "./licence-version.mjs";

const argumentsList = process.argv.slice(2);
const positional = [];
const options = {};
for (let index = 0; index < argumentsList.length; index += 1) {
	const argument = argumentsList[index];
	if (argument === "--remote")
		throw new Error(
			"This owner tool is local-only; use the reviewed remote publishing workflow for staging/production.",
		);
	if (argument === "--licence" || argument === "--version") {
		const value = argumentsList[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
		options[argument.slice(2)] = value;
		index += 1;
		continue;
	}
	if (argument.startsWith("--")) throw new Error(`Unknown option ${argument}`);
	positional.push(argument);
}
const manifestPath = positional[0];
const assetRoot = resolve(positional[1] ?? ".");
if (!manifestPath)
	throw new Error(
		"Usage: npm run seed:local -- /absolute/path/publish-manifest.json /absolute/path/asset-root [--version YYYY-MM-DD] [--licence /absolute/path/licence.json]",
	);
const manifest = JSON.parse(await readFile(resolve(manifestPath), "utf8"));
if (!Array.isArray(manifest.photos) || manifest.photos.length > 358)
	throw new Error("Manifest must contain a bounded photos[] list (maximum 358 for this album)");
const licencePath = options.licence ? resolve(options.licence) : defaultLicencePath;
const sourceVersion = await sourceLicenceVersion(defaultSourcePath);
const { env, dispose } = await getPlatformProxy({ configPath: resolve("wrangler.jsonc"), persist: true });
const licenceVersion = validateLicenceVersion(options.version, sourceVersion, env.CURRENT_LICENCE_VERSION);
const currentLicenceRows = await env.DB.prepare(
	"SELECT version FROM licence_versions WHERE current=1 ORDER BY created_at DESC",
).all();
validateCurrentLicenceVersions(
	currentLicenceRows.results.map(row => row.version),
	licenceVersion,
);
const now = Date.now();
const sql = [];
const objects = [];
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
for (const photo of manifest.photos) {
	if (
		!photo ||
		typeof photo.id !== "string" ||
		!/^[A-Za-z0-9_-]{1,128}$/.test(photo.id) ||
		typeof photo.category !== "string" ||
		typeof photo.filename !== "string"
	)
		throw new Error("Manifest contains an invalid photo identity");
	const variants = photo.variants ?? {};
	const dimensions = photo.dimensions ?? { width: photo.width, height: photo.height };
	sql.push(
		`INSERT INTO photos(id,category,filename,version,status,thumbnail_key,preview_key,full_key,width,height,created_at,updated_at) VALUES(${quote(photo.id)},${quote(photo.category)},${quote(photo.filename)},1,'published',${quote(variants.thumbnail.objectKey ?? variants.thumbnail.key)},${quote(variants.preview.objectKey ?? variants.preview.key)},${quote(variants.full.objectKey ?? variants.full.key)},${Number(dimensions.width)},${Number(dimensions.height)},${now},${now}) ON CONFLICT(id) DO NOTHING;`,
	);
	for (const format of ["thumbnail", "preview", "full"]) {
		const variant = variants[format];
		if (!variant || typeof (variant.objectKey ?? variant.key) !== "string")
			throw new Error(`Photo ${photo.id} is missing ${format}`);
		const key = variant.objectKey ?? variant.key;
		const path = variant.path ? resolve(assetRoot, variant.path) : resolve(assetRoot, "objects", key);
		const variantDimensions = variant.dimensions ?? { width: variant.width, height: variant.height };
		objects.push({ key, path, contentType: variant.contentType ?? "image/jpeg" });
		sql.push(
			`INSERT INTO photo_variants(photo_id,format,object_key,width,height,bytes,sha256,content_type) VALUES(${quote(photo.id)},${quote(format)},${quote(key)},${Number(variantDimensions.width)},${Number(variantDimensions.height)},${Number(variant.size ?? variant.bytes)},${variant.sha256 == null ? "NULL" : quote(variant.sha256)},${quote(variant.contentType ?? "image/jpeg")}) ON CONFLICT(photo_id,format) DO NOTHING;`,
		);
	}
	if (variants.quick) {
		const variant = variants.quick;
		if (typeof (variant.objectKey ?? variant.key) !== "string")
			throw new Error(`Photo ${photo.id} has an invalid quick variant`);
		const key = variant.objectKey ?? variant.key;
		const path = variant.path ? resolve(assetRoot, variant.path) : resolve(assetRoot, "objects", key);
		const variantDimensions = variant.dimensions ?? { width: variant.width, height: variant.height };
		objects.push({ key, path, contentType: variant.contentType ?? "image/jpeg" });
		sql.push(
			`INSERT INTO photo_variants(photo_id,format,object_key,width,height,bytes,sha256,content_type) VALUES(${quote(photo.id)},'quick',${quote(key)},${Number(variantDimensions.width)},${Number(variantDimensions.height)},${Number(variant.size ?? variant.bytes)},${variant.sha256 == null ? "NULL" : quote(variant.sha256)},${quote(variant.contentType ?? "image/jpeg")}) ON CONFLICT(photo_id,format) DO NOTHING;`,
		);
	}
}
for (let index = 0; index < objects.length; index += 1) {
	const object = objects[index];
	await env.PHOTO_BUCKET.put(object.key, await readFile(object.path), {
		httpMetadata: { contentType: object.contentType },
	});
	if ((index + 1) % 25 === 0 || index === objects.length - 1)
		console.log(`Uploaded ${index + 1}/${objects.length} local gallery objects`);
}
for (let index = 0; index < sql.length; index += 100) {
	const statements = sql.slice(index, index + 100).map(statement => env.DB.prepare(statement));
	await env.DB.batch(statements);
}
if (
	await import("node:fs/promises").then(({ access }) =>
		access(licencePath)
			.then(() => true)
			.catch(() => false),
	)
) {
	const licence = JSON.parse(await readFile(licencePath, "utf8"));
	if (!Array.isArray(licence.en) || !Array.isArray(licence.fr)) throw new Error("Licence must contain en[] and fr[]");
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO licence_versions(version,en_json,fr_json,current,created_at) VALUES(?,?,?,?,?) ON CONFLICT(version) DO UPDATE SET en_json=excluded.en_json,fr_json=excluded.fr_json,current=1",
		).bind(licenceVersion, JSON.stringify(licence.en), JSON.stringify(licence.fr), 1, now),
		env.DB.prepare("UPDATE licence_versions SET current=0 WHERE current=1 AND version<>?").bind(licenceVersion),
	]);
}
console.log(`Seeded ${manifest.photos.length} photos and ${objects.length} private local objects.`);
await dispose();
