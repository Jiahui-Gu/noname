import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { parseMainUpdateManifest } from "./manifest.ts";
import { UpdateStore } from "./store.ts";

const ALLOWED_HOSTS = new Set(["github.com", "api.github.com", "objects.githubusercontent.com"]);
const RELEASE_URL = "https://github.com/Jiahui-Gu/noname/releases";

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

function validateUrl(value: string | URL): URL {
	const url = new URL(value);
	if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) throw new Error(`Update URL is not allowed: ${url.origin}`);
	return url;
}

async function secureFetch(fetchImpl: typeof fetch, input: string | URL, init: RequestInit = {}): Promise<Response> {
	let url = validateUrl(input);
	for (let redirects = 0; redirects <= 5; redirects++) {
		const response = await fetchImpl(url, { ...init, redirect: "manual" });
		validateUrl(response.url || url);
		if (![301, 302, 303, 307, 308].includes(response.status)) return response;
		const location = response.headers.get("location");
		if (!location) throw new Error("Update redirect has no location");
		url = validateUrl(new URL(location, url));
	}
	throw new Error("Too many update redirects");
}

function httpError(response: Response): Error & { retryAt?: string } {
	const error = new Error(`GitHub update request failed: HTTP ${response.status}`) as Error & { retryAt?: string };
	const reset = response.headers.get("x-ratelimit-reset");
	if ((response.status === 403 || response.status === 429) && reset) error.retryAt = new Date(Number(reset) * 1000).toISOString();
	return error;
}

export class MainUpdateService {
	private readonly fetchImpl: typeof fetch;
	constructor(
		private readonly store: UpdateStore,
		private readonly options: UpdateServiceOptions
	) {
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	private emit(status: UpdateStatus): UpdateStatus {
		this.options.onStatus(status);
		return status;
	}

	async check(currentCommit: string): Promise<UpdateStatus> {
		this.emit({ state: "checking" });
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
		const zipPath = path.join(this.store.rootDir, "noname-main.zip");
		try {
			const apiUrl = `https://api.github.com/repos/${this.options.owner}/${this.options.repo}/releases/tags/${this.options.releaseTag}`;
			const releaseResponse = await secureFetch(this.fetchImpl, apiUrl, {
				signal: controller.signal,
				headers: { Accept: "application/vnd.github+json", "User-Agent": "noname-electron-updater" },
			});
			if (!releaseResponse.ok) throw httpError(releaseResponse);
			const release = (await releaseResponse.json()) as { assets?: Array<{ name?: unknown; browser_download_url?: unknown }> };
			const assetUrl = (name: string) => {
				const asset = release.assets?.find(candidate => candidate.name === name);
				if (typeof asset?.browser_download_url !== "string") throw new Error(`Release asset is missing: ${name}`);
				return validateUrl(asset.browser_download_url);
			};
			const manifestResponse = await secureFetch(this.fetchImpl, assetUrl("main-update.json"), { signal: controller.signal });
			if (!manifestResponse.ok) throw httpError(manifestResponse);
			const manifestText = await manifestResponse.text();
			if (Buffer.byteLength(manifestText) > 1024 * 1024) throw new Error("Update manifest is too large");
			const manifest = parseMainUpdateManifest(JSON.parse(manifestText));
			if (manifest.commit === currentCommit) return this.emit({ state: "up-to-date", commit: currentCommit });
			if (manifest.requiresInstaller) return this.emit({ state: "installer-required", commit: manifest.commit, releaseUrl: RELEASE_URL });
			if (manifest.package.size > this.options.maxPackageBytes) throw new Error("Update package exceeds the 1 GiB limit");

			const packageResponse = await secureFetch(this.fetchImpl, assetUrl(manifest.package.name), { signal: controller.signal });
			if (!packageResponse.ok) throw httpError(packageResponse);
			if (!packageResponse.body) throw new Error("Update package response has no body");
			const declaredLength = packageResponse.headers.get("content-length");
			if (declaredLength && Number(declaredLength) !== manifest.package.size) throw new Error("Update package Content-Length does not match manifest");

			const output = await fs.open(zipPath, "w");
			const hash = createHash("sha256");
			let received = 0;
			try {
				const reader = packageResponse.body.getReader();
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					received += value.byteLength;
					if (received > manifest.package.size || received > this.options.maxPackageBytes) throw new Error("Update package exceeds declared size");
					hash.update(value);
					await output.write(value);
					this.emit({ state: "downloading", commit: manifest.commit, received, total: manifest.package.size });
				}
			} finally {
				await output.close();
			}
			if (received !== manifest.package.size) throw new Error("Update package size does not match manifest");
			if (hash.digest("hex") !== manifest.package.sha256) throw new Error("Update package SHA-256 does not match manifest");
			await this.store.stageArchive(zipPath, manifest);
			await this.store.activate(manifest);
			return this.emit({ state: "ready", commit: manifest.commit });
		} catch (error) {
			const value = error as Error & { retryAt?: string };
			const message = value.name === "AbortError" ? "Update check timed out after 30 seconds" : value.message || String(value);
			return this.emit({ state: "failed", message, ...(value.retryAt ? { retryAt: value.retryAt } : {}) });
		} finally {
			clearTimeout(timeout);
			try {
				await fs.rm(zipPath, { force: true });
			} catch (error) {
				console.warn("[main-update] unable to remove downloaded package", error);
			}
		}
	}
}
