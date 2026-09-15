import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { MainUpdateService, type UpdateStatus } from "./service.ts";
import type { UpdateStore } from "./store.ts";

const commit = "0123456789abcdef0123456789abcdef01234567";
const nextCommit = "89abcdef0123456789abcdef0123456789abcdef";
const manifestUrl = "https://github.com/Jiahui-Gu/noname/releases/download/main-latest/main-update.json";
const packageUrl = "https://github.com/Jiahui-Gu/noname/releases/download/main-latest/noname-main.zip";

function setup(requiresInstaller = false, overrideManifestUrl = manifestUrl, redirectPackage = false) {
	const bytes = new TextEncoder().encode("verified update");
	const redirectedPackageUrl = "https://release-assets.githubusercontent.com/noname-main.zip";
	const manifest = {
		schemaVersion: 1,
		commit: nextCommit,
		builtAt: "2026-09-15T12:00:00.000Z",
		requiresInstaller,
		package: {
			name: "noname-main.zip",
			sha256: createHash("sha256").update(bytes).digest("hex"),
			size: bytes.byteLength,
		},
	};
	let staged = 0;
	let activated = 0;
	const store = {
		rootDir: process.cwd(),
		stageArchive: async () => {
			staged++;
		},
		activate: async () => {
			activated++;
		},
	} as unknown as UpdateStore;
	const statuses: UpdateStatus[] = [];
	const fetchImpl: typeof fetch = async input => {
		const url = String(input);
		if (url.includes("/releases/tags/main-latest")) {
			return Response.json({
				assets: [
					{ name: "main-update.json", browser_download_url: overrideManifestUrl },
					{ name: "noname-main.zip", browser_download_url: packageUrl },
				],
			});
		}
		if (url === manifestUrl) return Response.json(manifest);
		if (url === packageUrl && redirectPackage) return new Response(null, { status: 302, headers: { location: redirectedPackageUrl } });
		if (url === packageUrl || url === redirectedPackageUrl) return new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } });
		throw new Error(`Unexpected request: ${url}`);
	};
	const service = new MainUpdateService(store, {
		owner: "Jiahui-Gu",
		repo: "noname",
		releaseTag: "main-latest",
		maxPackageBytes: 1024,
		timeoutMs: 1000,
		fetchImpl,
		onStatus: status => statuses.push(status),
	});
	return { service, statuses, staged: () => staged, activated: () => activated };
}

test("does not download when the manifest commit is already served", async () => {
	const value = setup();
	const result = await value.service.check(nextCommit);
	assert.deepEqual(result, { state: "up-to-date", commit: nextCommit });
	assert.equal(value.staged(), 0);
});

test("requires an installer without staging any package", async () => {
	const value = setup(true);
	const result = await value.service.check(commit);
	assert.equal(result.state, "installer-required");
	assert.equal(value.staged(), 0);
});

test("downloads, verifies, stages, and activates a compatible update", async () => {
	const value = setup();
	const result = await value.service.check(commit);
	assert.deepEqual(result, { state: "ready", commit: nextCommit });
	assert.equal(value.staged(), 1);
	assert.equal(value.activated(), 1);
});

test("accepts GitHub's release asset redirect host", async () => {
	const value = setup(false, manifestUrl, true);
	const result = await value.service.check(commit);
	assert.deepEqual(result, { state: "ready", commit: nextCommit });
});

test("rejects a non-allowlisted asset host before download", async () => {
	const value = setup(false, "https://example.com/main-update.json");
	const result = await value.service.check(commit);
	assert.equal(result.state, "failed");
	assert.match(result.state === "failed" ? result.message : "", /not allowed/);
	assert.equal(value.staged(), 0);
});
