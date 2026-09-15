import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import type { MainUpdateManifest } from "./manifest.ts";
import { UpdateStore } from "./store.ts";

const first: MainUpdateManifest = {
	schemaVersion: 1,
	commit: "0123456789abcdef0123456789abcdef01234567",
	builtAt: "2026-09-15T12:00:00.000Z",
	requiresInstaller: false,
	package: { name: "noname-main.zip", sha256: "0".repeat(64), size: 1 },
};
const second = { ...first, commit: "89abcdef0123456789abcdef0123456789abcdef" };

test("atomically activates and rolls back update directories", async () => {
	const root = path.join(process.cwd(), `.update-store-test-${process.pid}`);
	await fs.rm(root, { recursive: true, force: true });
	const store = new UpdateStore(root);
	try {
		await store.initialize();
		await fs.mkdir(store.stagingDir);
		await fs.writeFile(path.join(store.stagingDir, "version"), "first");
		await store.activate(first);
		assert.equal((await store.readState())?.pendingHealthCheck, true);
		await store.markHealthy();

		await fs.mkdir(store.stagingDir);
		await fs.writeFile(path.join(store.stagingDir, "version"), "second");
		await store.activate(second);
		assert.equal(await fs.readFile(path.join(store.currentDir, "version"), "utf8"), "second");
		assert.equal(await fs.readFile(path.join(store.previousDir, "version"), "utf8"), "first");

		assert.equal(await store.rollback(), true);
		assert.equal(await fs.readFile(path.join(store.currentDir, "version"), "utf8"), "first");
		assert.deepEqual(await store.readState(), { commit: first.commit, pendingHealthCheck: false });
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
