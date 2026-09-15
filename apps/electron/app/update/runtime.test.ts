import assert from "node:assert/strict";
import { test } from "node:test";

import { UpdateRuntime } from "./runtime.ts";
import type { UpdateStore } from "./store.ts";

function fixture(pendingHealthCheck = false) {
	let reloads = 0;
	let markedHealthy = 0;
	let rollbacks = 0;
	const store = {
		readState: async () => (pendingHealthCheck ? { commit: "a", pendingHealthCheck: true } : null),
		markHealthy: async () => {
			markedHealthy++;
		},
		rollback: async () => {
			rollbacks++;
			return true;
		},
	} as unknown as UpdateStore;
	const runtime = new UpdateRuntime(store, () => reloads++, () => undefined, 5);
	return { runtime, reloads: () => reloads, markedHealthy: () => markedHealthy, rollbacks: () => rollbacks };
}

test("reloads a ready update once when safe", () => {
	const value = fixture();
	value.runtime.setStatus({ state: "ready", commit: "a" });
	value.runtime.setGameActive(false);
	assert.equal(value.reloads(), 1);
});

test("waits for an active game to finish", () => {
	const value = fixture();
	value.runtime.setGameActive(true);
	value.runtime.setStatus({ state: "ready", commit: "a" });
	assert.equal(value.reloads(), 0);
	value.runtime.setGameActive(false);
	assert.equal(value.reloads(), 1);
});

test("marks a pending update healthy on renderer handshake", async () => {
	const value = fixture(true);
	await value.runtime.startHealthCheck();
	await value.runtime.reportReady();
	assert.equal(value.markedHealthy(), 1);
});

test("rolls back and reloads after health timeout", async () => {
	const value = fixture(true);
	await value.runtime.startHealthCheck();
	await new Promise(resolve => setTimeout(resolve, 15));
	assert.equal(value.rollbacks(), 1);
	assert.equal(value.reloads(), 1);
});
