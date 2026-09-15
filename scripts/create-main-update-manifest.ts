import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

import { classifyChangedPaths, parseMainUpdateManifest } from "../apps/electron/app/update/manifest.ts";

function requiredEnvironmentVariable(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

function isUsableBeforeCommit(commit: string): boolean {
	if (!/^[0-9a-f]{40}$/.test(commit) || /^0+$/.test(commit)) {
		return false;
	}

	try {
		execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], {
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}

async function sha256File(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) {
		hash.update(chunk);
	}
	return hash.digest("hex");
}

const commit = requiredEnvironmentVariable("UPDATE_COMMIT");
const before = process.env.UPDATE_BEFORE ?? "";
const packagePath = requiredEnvironmentVariable("UPDATE_PACKAGE");
const outputPath = requiredEnvironmentVariable("UPDATE_OUTPUT");

const hasUsableBeforeCommit = isUsableBeforeCommit(before);
const changedPaths = hasUsableBeforeCommit
	? execFileSync("git", ["diff", "--name-only", before, commit], {
			encoding: "utf8",
		})
			.split(/\r?\n/)
			.filter(Boolean)
	: ["<unknown>"];
const packageStats = await stat(packagePath);
const builtAt = new Date(
	execFileSync("git", ["show", "-s", "--format=%cI", commit], {
		encoding: "utf8",
	}).trim()
).toISOString();

const manifest = parseMainUpdateManifest({
	schemaVersion: 1,
	commit,
	builtAt,
	requiresInstaller: classifyChangedPaths(changedPaths),
	package: {
		name: "noname-main.zip",
		sha256: await sha256File(packagePath),
		size: packageStats.size,
	},
});

await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
