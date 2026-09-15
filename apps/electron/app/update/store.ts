import extract from "extract-zip";
import fs from "node:fs/promises";
import path from "node:path";

import type { MainUpdateManifest } from "./manifest.ts";

export interface InstalledUpdateState {
	commit: string;
	previousCommit?: string;
	pendingHealthCheck: boolean;
}

function isState(value: unknown): value is InstalledUpdateState {
	if (typeof value !== "object" || value === null) return false;
	const state = value as Record<string, unknown>;
	return (
		typeof state.commit === "string" &&
		(state.previousCommit === undefined || typeof state.previousCommit === "string") &&
		typeof state.pendingHealthCheck === "boolean"
	);
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export class UpdateStore {
	constructor(readonly rootDir: string) {}

	get currentDir() {
		return path.join(this.rootDir, "current");
	}
	get previousDir() {
		return path.join(this.rootDir, "previous");
	}
	get stagingDir() {
		return path.join(this.rootDir, "staging");
	}
	private get statePath() {
		return path.join(this.rootDir, "state.json");
	}

	async initialize(): Promise<void> {
		await fs.mkdir(this.rootDir, { recursive: true });
		const state = await this.readState();
		if (state && !(await this.isRunnableDirectory(this.currentDir)) && (await this.isRunnableDirectory(this.previousDir))) {
			await fs.rm(this.currentDir, { recursive: true, force: true });
			await fs.rename(this.previousDir, this.currentDir);
			if (state.previousCommit) await this.writeState({ commit: state.previousCommit, pendingHealthCheck: false });
		}
		await this.cleanup();
	}

	private async isRunnableDirectory(directory: string): Promise<boolean> {
		for (const required of ["index.html", "noname.js", path.join("game", "build-info.json")]) {
			try {
				if (!(await fs.stat(path.join(directory, required))).isFile()) return false;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
				throw error;
			}
		}
		return true;
	}

	async readState(): Promise<InstalledUpdateState | null> {
		try {
			const value: unknown = JSON.parse(await fs.readFile(this.statePath, "utf8"));
			if (!isState(value)) throw new Error("Invalid installed update state");
			return value;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}

	private async writeState(state: InstalledUpdateState): Promise<void> {
		const temporary = `${this.statePath}.tmp`;
		await fs.writeFile(temporary, `${JSON.stringify(state, null, "\t")}\n`, "utf8");
		await fs.rename(temporary, this.statePath);
	}

	async stageArchive(zipPath: string, manifest: MainUpdateManifest): Promise<void> {
		await fs.rm(this.stagingDir, { recursive: true, force: true });
		await fs.mkdir(this.stagingDir, { recursive: true });
		try {
			let entryCount = 0;
			let extractedBytes = 0;
			await extract(zipPath, {
				dir: this.stagingDir,
				onEntry(entry) {
					entryCount++;
					extractedBytes += entry.uncompressedSize;
					const name = entry.fileName.replaceAll("\\", "/");
					const unixType = (entry.externalFileAttributes >>> 16) & 0xf000;
					if (
						name.startsWith("/") ||
						/^[a-zA-Z]:/.test(name) ||
						name.split("/").some(part => part === "..") ||
						path.posix.normalize(name).startsWith("../") ||
						unixType === 0xa000 ||
						entryCount > 100_000 ||
						extractedBytes > 1024 * 1024 * 1024
					) {
						throw new Error(`Unsafe archive entry: ${entry.fileName}`);
					}
				},
			});
			for (const required of ["index.html", "noname.js", path.join("game", "build-info.json")]) {
				const stat = await fs.stat(path.join(this.stagingDir, required));
				if (!stat.isFile()) throw new Error(`Missing required update file: ${required}`);
			}
			const buildInfo: unknown = JSON.parse(await fs.readFile(path.join(this.stagingDir, "game", "build-info.json"), "utf8"));
			if (typeof buildInfo !== "object" || buildInfo === null || (buildInfo as { commit?: unknown }).commit !== manifest.commit) {
				throw new Error("Update build commit does not match manifest");
			}
		} catch (error) {
			await fs.rm(this.stagingDir, { recursive: true, force: true });
			throw error;
		}
	}

	async activate(manifest: MainUpdateManifest): Promise<void> {
		const oldState = await this.readState();
		const hadCurrent = oldState !== null && (await exists(this.currentDir));
		await fs.rm(this.previousDir, { recursive: true, force: true });
		try {
			if (hadCurrent) await fs.rename(this.currentDir, this.previousDir);
			else await fs.rm(this.currentDir, { recursive: true, force: true });
			await fs.rename(this.stagingDir, this.currentDir);
			await this.writeState({
				commit: manifest.commit,
				previousCommit: oldState?.commit,
				pendingHealthCheck: true,
			});
		} catch (error) {
			await fs.rm(this.currentDir, { recursive: true, force: true });
			if (hadCurrent && (await exists(this.previousDir))) await fs.rename(this.previousDir, this.currentDir);
			throw error;
		}
	}

	async markHealthy(): Promise<void> {
		const state = await this.readState();
		if (state?.pendingHealthCheck) await this.writeState({ ...state, pendingHealthCheck: false });
	}

	async rollback(): Promise<boolean> {
		const state = await this.readState();
		if (!state?.pendingHealthCheck || !(await exists(this.currentDir))) return false;
		await fs.rm(this.currentDir, { recursive: true, force: true });
		if (await exists(this.previousDir)) {
			await fs.rename(this.previousDir, this.currentDir);
			if (!state.previousCommit) throw new Error("Previous update directory has no commit");
			await this.writeState({ commit: state.previousCommit, pendingHealthCheck: false });
		} else {
			await fs.rm(this.statePath, { force: true });
		}
		return true;
	}

	async cleanup(): Promise<void> {
		await fs.rm(this.stagingDir, { recursive: true, force: true });
		await fs.rm(`${this.statePath}.tmp`, { force: true });
	}
}
