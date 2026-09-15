export interface MainUpdateManifest {
	schemaVersion: 1;
	commit: string;
	builtAt: string;
	requiresInstaller: boolean;
	package: {
		name: "noname-main.zip";
		sha256: string;
		size: number;
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidManifest(): never {
	throw new TypeError("Invalid main update manifest");
}

export function parseMainUpdateManifest(value: unknown): MainUpdateManifest {
	if (!isRecord(value) || value.schemaVersion !== 1) {
		return invalidManifest();
	}
	if (typeof value.commit !== "string" || !/^[0-9a-f]{40}$/.test(value.commit) || typeof value.builtAt !== "string" || typeof value.requiresInstaller !== "boolean" || !isRecord(value.package)) {
		return invalidManifest();
	}

	const packageValue = value.package;
	if (packageValue.name !== "noname-main.zip" || typeof packageValue.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(packageValue.sha256) || typeof packageValue.size !== "number" || !Number.isSafeInteger(packageValue.size) || packageValue.size <= 0) {
		return invalidManifest();
	}

	return {
		schemaVersion: 1,
		commit: value.commit,
		builtAt: value.builtAt,
		requiresInstaller: value.requiresInstaller,
		package: {
			name: "noname-main.zip",
			sha256: packageValue.sha256,
			size: packageValue.size,
		},
	};
}

const HOT_UPDATE_PATH_PREFIXES = ["apps/core/", "packages/jit/", "docs/"];
const HOT_UPDATE_ROOT_FILES = new Set(["README.md", "LICENSE", ".nomedia"]);

export function classifyChangedPaths(paths: string[]): boolean {
	return paths.some(path => !HOT_UPDATE_ROOT_FILES.has(path) && !HOT_UPDATE_PATH_PREFIXES.some(prefix => path.startsWith(prefix)));
}
