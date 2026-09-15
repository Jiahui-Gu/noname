import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { classifyChangedPaths, parseMainUpdateManifest, type MainUpdateManifest } from "./manifest.ts";

const validManifest: MainUpdateManifest = {
	schemaVersion: 1,
	commit: "0123456789abcdef0123456789abcdef01234567",
	builtAt: "2026-09-15T12:00:00.000Z",
	requiresInstaller: false,
	package: {
		name: "noname-main.zip",
		sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		size: 1024,
	},
};

describe("parseMainUpdateManifest", () => {
	test("parses a valid manifest", () => {
		assert.deepEqual(parseMainUpdateManifest(validManifest), validManifest);
	});

	test("rejects malformed commit SHAs", () => {
		for (const commit of ["0123456789abcdef", "0123456789abcdef0123456789abcdef0123456G", "0123456789ABCDEF0123456789ABCDEF01234567"]) {
			assert.throws(() => parseMainUpdateManifest({ ...validManifest, commit }), /manifest/i);
		}
	});

	test("rejects malformed package checksums", () => {
		for (const sha256 of ["0123456789abcdef", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeG", "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF"]) {
			assert.throws(
				() =>
					parseMainUpdateManifest({
						...validManifest,
						package: { ...validManifest.package, sha256 },
					}),
				/manifest/i
			);
		}
	});

	test("rejects non-positive and unsafe package sizes", () => {
		for (const size of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
			assert.throws(
				() =>
					parseMainUpdateManifest({
						...validManifest,
						package: { ...validManifest.package, size },
					}),
				/manifest/i
			);
		}
	});

	test("rejects unknown package asset names", () => {
		assert.throws(
			() =>
				parseMainUpdateManifest({
					...validManifest,
					package: { ...validManifest.package, name: "other.zip" },
				}),
			/manifest/i
		);
	});
});

describe("classifyChangedPaths", () => {
	test("allows only explicitly hot-update-compatible paths", () => {
		assert.equal(classifyChangedPaths(["apps/core/index.html", "packages/jit/src/index.ts", "docs/README.md", "README.md", "LICENSE", ".nomedia"]), false);
	});

	test("requires an installer for electron, lockfile, other package, and unknown paths", () => {
		for (const path of ["apps/electron/app/main.ts", "pnpm-lock.yaml", "package-lock.json", "packages/fs/index.ts", "scripts/build.ts"]) {
			assert.equal(classifyChangedPaths([path]), true, path);
		}
	});

	test("requires an installer if any path is not allowlisted", () => {
		assert.equal(classifyChangedPaths(["apps/core/game/index.js", "tsconfig.json"]), true);
	});
});
