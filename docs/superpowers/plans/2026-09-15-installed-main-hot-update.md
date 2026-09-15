# Installed Main Hot Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Windows Electron installation silently download each compatible `main` build at startup and reload the game window only after the current match ends.

**Architecture:** A GitHub Actions workflow publishes a rolling prerelease containing a fully built web root and a validated manifest. The Electron main process owns update checks, download, checksum verification, staging, atomic directory swaps, rollback, and IPC; the game reports match lifecycle through the existing preload bridge.

**Tech Stack:** TypeScript, Electron 39, Fastify static serving, GitHub Actions, Node.js `fetch`/`crypto`/filesystem APIs, `extract-zip`, Node's built-in test runner through `tsx --test`.

## Global Constraints

- Check for updates once per Electron process startup; do not poll.
- Never interrupt a running match.
- Apply a downloaded game update by reloading the BrowserWindow, not by exiting Electron.
- Never hot-update Electron shell, runtime dependencies, or unknown paths.
- Keep the current runnable version if checking, downloading, verification, extraction, or activation fails.
- Accept update metadata and packages only from `github.com`, `api.github.com`, and `objects.githubusercontent.com` over HTTPS.
- Keep at most the active version, previous version, and one staging download.

---

### Task 1: Update manifest contract and rolling build

**Files:**
- Create: `apps/electron/app/update/manifest.ts`
- Create: `apps/electron/app/update/manifest.test.ts`
- Create: `scripts/create-main-update-manifest.ts`
- Create: `.github/workflows/main-update.yml`
- Modify: `apps/electron/package.json`

**Interfaces:**
- Produces: `MainUpdateManifest`, `parseMainUpdateManifest(value: unknown): MainUpdateManifest`, and `classifyChangedPaths(paths: string[]): boolean`.
- Produces release assets named `main-update.json` and `noname-main.zip` on prerelease tag `main-latest`.

- [ ] **Step 1: Add the failing manifest tests**

Test valid schema parsing, rejection of malformed SHA/checksum/size/asset names, and conservative path classification. Include cases proving `apps/core/**`, `packages/jit/**`, `docs/**`, `README.md`, `LICENSE`, and `.nomedia` are hot-update compatible while `apps/electron/**`, lockfiles, other packages, and unknown paths require an installer.

- [ ] **Step 2: Run the focused tests and observe failure**

Run: `pnpm -F @noname/electron exec tsx --test app/update/manifest.test.ts`

Expected: FAIL because `manifest.ts` does not exist.

- [ ] **Step 3: Implement the manifest contract**

Define this exact public shape:

```ts
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

export function parseMainUpdateManifest(value: unknown): MainUpdateManifest;
export function classifyChangedPaths(paths: string[]): boolean;
```

Use explicit runtime guards. `commit` must be 40 lowercase hexadecimal characters, `sha256` must be 64 lowercase hexadecimal characters, `size` must be a positive safe integer, and no unknown package name is accepted. `classifyChangedPaths` must return `true` when any path is outside the explicit hot-update allowlist.

- [ ] **Step 4: Add the manifest generator and workflow**

`scripts/create-main-update-manifest.ts` must read `UPDATE_COMMIT`, `UPDATE_BEFORE`, `UPDATE_PACKAGE`, and `UPDATE_OUTPUT`; run `git diff --name-only <before> <commit>` when the before SHA is usable; hash the ZIP; call `classifyChangedPaths`; and write deterministic JSON.

`.github/workflows/main-update.yml` must:

1. Trigger on pushes to `main` and manual dispatch.
2. Checkout full history, install pnpm/Node, and run `pnpm install --frozen-lockfile`.
3. Set `NONAME_BUILD_CHANNEL=nightly`, `NONAME_BUILD_COMMIT=${{ github.sha }}`, and run `pnpm build`.
4. Archive the contents of `dist` as `noname-main.zip`.
5. Run the manifest generator.
6. Create or update prerelease tag/release `main-latest` with `gh release`.
7. Upload both assets using `--clobber`.

The workflow needs `contents: write` and must serialize with a `main-update` concurrency group.

- [ ] **Step 5: Add and run the test script**

Add `"test": "tsx --test app/**/*.test.ts"` to `apps/electron/package.json`, then run:

`pnpm -F @noname/electron test`

Expected: all manifest tests PASS.

- [ ] **Step 6: Commit**

```powershell
git add apps/electron/app/update/manifest.ts apps/electron/app/update/manifest.test.ts apps/electron/package.json scripts/create-main-update-manifest.ts .github/workflows/main-update.yml pnpm-lock.yaml
git commit -m "ci: publish rolling main update"
```

### Task 2: Transactional update storage

**Files:**
- Create: `apps/electron/app/update/store.ts`
- Create: `apps/electron/app/update/store.test.ts`
- Modify: `apps/electron/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `MainUpdateManifest` from Task 1.
- Produces: `UpdateStore`, `InstalledUpdateState`, and directory getters `currentDir`, `previousDir`, `stagingDir`.

- [ ] **Step 1: Add failing storage tests**

Use temporary directories to cover:

- Initialization creates `current`, `previous`, and `staging` parents without touching bundled files.
- A ZIP entry such as `../escape.txt`, an absolute path, or a symlink is rejected.
- A valid archive must contain `index.html`, `noname.js`, and `game/build-info.json`.
- Activation renames `current` to `previous`, staging to `current`, then atomically writes state.
- A failed activation restores the old `current`.
- Rollback swaps `previous` back to `current`.
- Cleanup removes abandoned staging and retains only current/previous.

- [ ] **Step 2: Run tests and observe failure**

Run: `pnpm -F @noname/electron exec tsx --test app/update/store.test.ts`

Expected: FAIL because `store.ts` does not exist.

- [ ] **Step 3: Add the extraction dependency**

Add runtime dependency `"extract-zip": "^2.0.1"` and dev dependency `"@types/extract-zip": "^2.0.0"` to `apps/electron/package.json`, then run `pnpm install`.

- [ ] **Step 4: Implement transactional storage**

Expose:

```ts
export interface InstalledUpdateState {
	commit: string;
	previousCommit?: string;
	pendingHealthCheck: boolean;
}

export class UpdateStore {
	constructor(readonly rootDir: string);
	get currentDir(): string;
	get previousDir(): string;
	get stagingDir(): string;
	initialize(): Promise<void>;
	readState(): Promise<InstalledUpdateState | null>;
	stageArchive(zipPath: string, manifest: MainUpdateManifest): Promise<void>;
	activate(manifest: MainUpdateManifest): Promise<void>;
	markHealthy(): Promise<void>;
	rollback(): Promise<boolean>;
	cleanup(): Promise<void>;
}
```

Use `extract-zip`'s entry callback to reject traversal, absolute paths, and symbolic links before extraction. Write state through `state.json.tmp` followed by rename. Validate `game/build-info.json` parses and its `commit` equals the manifest commit.

- [ ] **Step 5: Run storage tests**

Run: `pnpm -F @noname/electron test`

Expected: manifest and storage tests PASS.

- [ ] **Step 6: Commit**

```powershell
git add apps/electron/app/update/store.ts apps/electron/app/update/store.test.ts apps/electron/package.json pnpm-lock.yaml
git commit -m "feat(electron): add transactional update storage"
```

### Task 3: Startup update service

**Files:**
- Create: `apps/electron/app/update/service.ts`
- Create: `apps/electron/app/update/service.test.ts`

**Interfaces:**
- Consumes: `parseMainUpdateManifest` and `UpdateStore`.
- Produces: `MainUpdateService`, `UpdateStatus`, and injected `UpdateServiceOptions`.

- [ ] **Step 1: Add failing service tests**

Inject fake `fetch`, clock, and callbacks. Cover:

- Same commit returns `up-to-date` without downloading.
- `requiresInstaller` returns `installer-required`.
- Compatible update downloads once, verifies declared size and SHA-256, stages, activates, then returns `ready`.
- Non-HTTPS or non-allowlisted redirect URL is rejected.
- HTTP errors, timeout, rate limit, size overflow, checksum mismatch, and malformed manifest return explicit `failed` status without activation.

- [ ] **Step 2: Run tests and observe failure**

Run: `pnpm -F @noname/electron exec tsx --test app/update/service.test.ts`

Expected: FAIL because `service.ts` does not exist.

- [ ] **Step 3: Implement the service**

Expose:

```ts
export type UpdateStatus =
	| { state: "checking" }
	| { state: "up-to-date"; commit: string }
	| { state: "downloading"; commit: string; received: number; total: number }
	| { state: "ready"; commit: string }
	| { state: "installer-required"; commit: string; releaseUrl: string }
	| { state: "failed"; message: string; retryAt?: string };

export interface UpdateServiceOptions {
	owner: "Jiahui-Gu";
	repo: "noname";
	releaseTag: "main-latest";
	maxPackageBytes: number;
	timeoutMs: number;
	fetchImpl?: typeof fetch;
	onStatus(status: UpdateStatus): void;
}

export class MainUpdateService {
	constructor(store: UpdateStore, options: UpdateServiceOptions);
	check(currentCommit: string): Promise<UpdateStatus>;
}
```

Use the GitHub release-by-tag API, find exact asset names, fetch `main-update.json`, parse it, and stream `noname-main.zip` to a staging ZIP while updating SHA-256. Set maximum package size to 1 GiB and timeout to 30 seconds in production wiring. Preserve rate-limit reset as `retryAt`.

- [ ] **Step 4: Run service tests**

Run: `pnpm -F @noname/electron test`

Expected: all update module tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/electron/app/update/service.ts apps/electron/app/update/service.test.ts
git commit -m "feat(electron): download verified main updates"
```

### Task 4: Electron serving, health handshake, and IPC

**Files:**
- Modify: `packages/fs/src/index.ts`
- Modify: `apps/electron/app/main.ts`
- Modify: `apps/electron/app/preload.ts`
- Create: `apps/electron/app/update/runtime.ts`
- Create: `apps/electron/app/update/runtime.test.ts`
- Modify: `apps/core/typings/windowEx.d.ts`

**Interfaces:**
- Consumes: `MainUpdateService` and `UpdateStore`.
- Produces renderer API:

```ts
window.nonameUpdate = {
	setGameActive(active: boolean): void;
	reportReady(): void;
	getStatus(): Promise<UpdateStatus>;
};
```

- [ ] **Step 1: Add failing runtime state-machine tests**

Cover these exact transitions:

- `ready` while safe invokes reload once.
- `ready` while active waits; changing active to false invokes reload once.
- `installer-required` never reloads.
- A pending health check is marked healthy only after `reportReady`.
- Health timeout invokes rollback and reload when previous exists.

- [ ] **Step 2: Run the runtime test and observe failure**

Run: `pnpm -F @noname/electron exec tsx --test app/update/runtime.test.ts`

Expected: FAIL because `runtime.ts` does not exist.

- [ ] **Step 3: Allow static fallback roots**

Change `@noname/fs` config `dirname` to accept `string | string[]`. Resolve every root and pass the array to `@fastify/static`. Keep filesystem mutation endpoints pinned to the final bundled root rather than the update overlay. This lets requests resolve from `Home/Updates/current` first and bundled `resources/app` second.

- [ ] **Step 4: Implement runtime orchestration and IPC**

`UpdateRuntime` owns `gameActive`, latest status, a single reload callback, and a 20-second startup health timer. In `main.ts`:

- Create `Home/Updates/current` before starting the static server.
- Start `createApp` with `[store.currentDir, dirname]`.
- Register fixed IPC channels for status, activity, and ready handshake.
- Read the bundled/current `game/build-info.json` commit.
- Start one asynchronous check after the first window is ready.
- Broadcast statuses to all windows.
- Open the repository releases page with `shell.openExternal` only for installer-required status.

Do not expose path or URL arguments over IPC.

- [ ] **Step 5: Expose the preload bridge**

In `preload.ts`, import `ipcRenderer`, expose the exact `window.nonameUpdate` interface, and dispatch a DOM `noname-update-status` custom event when status changes. Add matching declarations to `windowEx.d.ts`.

- [ ] **Step 6: Run focused validation**

Run:

```powershell
pnpm -F @noname/electron test
pnpm -F @noname/fs build
pnpm -F @noname/electron build
```

Expected: tests pass and both builds complete without TypeScript or Vite errors.

- [ ] **Step 7: Commit**

```powershell
git add packages/fs/src/index.ts apps/electron/app/main.ts apps/electron/app/preload.ts apps/electron/app/update/runtime.ts apps/electron/app/update/runtime.test.ts apps/core/typings/windowEx.d.ts
git commit -m "feat(electron): activate updates without app restart"
```

### Task 5: Game lifecycle and user-visible status

**Files:**
- Modify: `apps/core/noname/entry.ts`
- Modify: `apps/core/noname/library/element/gameEvent.ts`
- Modify: `apps/core/noname/game/index.js`
- Modify: `apps/electron/app/main.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `window.nonameUpdate` from Task 4.
- Produces lifecycle calls `setGameActive(true)` on game start, `setGameActive(false)` on game over, and `reportReady()` after successful boot.

- [ ] **Step 1: Add lifecycle calls**

After `boot()` resolves, call `window.nonameUpdate?.reportReady()`. In the existing `gameStart` trigger call `setGameActive(true)`. At the end of `game.over`, after result persistence and `lib.onover` callbacks, call `setGameActive(false)`.

- [ ] **Step 2: Add minimal update notifications**

In the Electron main process, use native dialogs only for:

- `installer-required`: one message per commit with a button opening `https://github.com/Jiahui-Gu/noname/releases`.
- `failed`: one non-blocking error notification per startup.

For `ready` while a game is active, send a status event; log “更新已就绪，将在本局结束后应用” in the renderer without modal interruption.

- [ ] **Step 3: Document installed update behavior**

Add a README section stating that newly built installers follow `main`, check once at startup, download compatible game builds silently, reload after a match, require a new installer for Electron/dependency changes, and retain the previous version on failure.

- [ ] **Step 4: Run full targeted verification**

Run:

```powershell
pnpm -F @noname/electron test
pnpm -F @noname/electron lint
pnpm -F @noname/fs lint
pnpm -F @noname/electron build
pnpm build
git --no-pager diff --check
```

Expected: all tests/lints/builds pass and `git diff --check` emits no output.

- [ ] **Step 5: Inspect the generated package**

Confirm `dist/game/build-info.json` contains the current commit and `dist/index.html`, `dist/noname.js`, and `dist/game/update.js` exist. Generate a local manifest using the current commit as both before and current values and confirm it parses through `parseMainUpdateManifest`.

- [ ] **Step 6: Commit**

```powershell
git add apps/core/noname/entry.ts apps/core/noname/library/element/gameEvent.ts apps/core/noname/game/index.js apps/electron/app/main.ts README.md
git commit -m "feat: apply main updates after matches"
```
