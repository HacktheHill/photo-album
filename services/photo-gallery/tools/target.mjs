import { resolve } from "node:path";

// Owner mutations must select the same configuration and environment as deployment.
export function wranglerTargetArgs(argv) {
	const result = [];
	for (const flag of ["--config", "--env"]) {
		const index = argv.indexOf(flag);
		if (index < 0) continue;
		const value = argv[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
		if (flag === "--env" && value !== "production")
			throw new Error("Only the production environment is supported; omit --env for staging");
		if (flag === "--env" && !argv.includes("--remote"))
			throw new Error("Production owner mutations require --remote");
		result.push(flag, flag === "--config" ? resolve(value) : value);
	}
	return result;
}
