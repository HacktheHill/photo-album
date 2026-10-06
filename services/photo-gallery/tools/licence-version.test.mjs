import assert from "node:assert/strict";
import { test } from "node:test";
import { validateCurrentLicenceVersions, validateLicenceVersion } from "./licence-version.mjs";

const source = "2026-10-06";

test("derives and validates the source licence version", () => {
	assert.equal(validateLicenceVersion(undefined, source, source), source);
	assert.equal(validateLicenceVersion(source, source, source), source);
	assert.throws(() => validateLicenceVersion("2026-10-05", source, source), /does not match/);
	assert.throws(() => validateLicenceVersion(source, source, "2026-10-05"), /CURRENT_LICENCE_VERSION/);
});

test("allows an empty current set or the same current version", () => {
	assert.deepEqual(validateCurrentLicenceVersions([], source), { hasCurrent: false, version: source });
	assert.deepEqual(validateCurrentLicenceVersions([source, source], source), { hasCurrent: true, version: source });
});

test("an older seed cannot reactivate a different current licence", () => {
	assert.throws(() => validateCurrentLicenceVersions(["2026-10-07"], source), /Refusing to seed licence 2026-10-06/);
});
