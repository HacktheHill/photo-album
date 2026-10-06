import assert from "node:assert/strict";
import { test } from "node:test";
import { wranglerTargetArgs } from "./target.mjs";

test("production selection cannot silently target local or default staging", () => {
	assert.deepEqual(wranglerTargetArgs(["--remote", "--env", "production"]), ["--env", "production"]);
	assert.throws(() => wranglerTargetArgs(["--env", "production"]), /require --remote/);
	assert.throws(() => wranglerTargetArgs(["--remote", "--env"]), /requires a value/);
	assert.throws(() => wranglerTargetArgs(["--remote", "--env", "prodution"]), /Only the production/);
	assert.deepEqual(wranglerTargetArgs(["--remote"]), []);
});
