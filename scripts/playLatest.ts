import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const skipPull = process.argv.includes("--skip-pull");

function run(command: string, args: string[]) {
	const result = spawnSync(command, args, {
		stdio: "inherit",
		shell: false,
	});
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

function runPnpm(args: string[]) {
	const pnpmCli = process.env.npm_execpath;
	if (!pnpmCli) {
		throw new Error("请通过 pnpm play:latest 启动");
	}
	run(process.execPath, [pnpmCli, ...args]);
}

async function exists(target: string) {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}

if (!skipPull) {
	const branch = spawnSync("git", ["branch", "--show-current"], {
		encoding: "utf8",
		shell: false,
	});
	if (branch.error) {
		throw branch.error;
	}
	if (branch.status !== 0) {
		process.exit(branch.status ?? 1);
	}
	if (branch.stdout.trim() !== "main") {
		throw new Error("请在 main 分支运行 pnpm play:latest");
	}

	const changes = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], {
		encoding: "utf8",
		shell: false,
	});
	if (changes.error) {
		throw changes.error;
	}
	if (changes.status !== 0) {
		process.exit(changes.status ?? 1);
	}
	if (changes.stdout.trim()) {
		throw new Error("main 分支存在未提交修改，请先处理后再启动");
	}

	run("git", ["pull", "--ff-only", "origin", "main"]);
	runPnpm(["install", "--frozen-lockfile"]);
}

runPnpm(["build"]);

const installDir = process.env.NONAME_INSTALL_DIR || path.join(process.env.LOCALAPPDATA || "", "Programs", "noname");
const executable = path.join(installDir, "noname.exe");
const resourcesDir = path.join(installDir, "resources");
const appDir = path.join(resourcesDir, "app");
const nextDir = path.join(resourcesDir, "app.next");
const previousDir = path.join(resourcesDir, "app.previous");
const buildDir = path.resolve("dist");

if (!(await exists(executable)) || !(await exists(path.join(appDir, "app", "main.js")))) {
	throw new Error(`未找到可更新的安装版：${installDir}`);
}

await fs.rm(nextDir, { recursive: true, force: true });
await fs.cp(buildDir, nextDir, { recursive: true });
await fs.cp(path.join(appDir, "app"), path.join(nextDir, "app"), { recursive: true });
await fs.copyFile(path.join(appDir, "package.json"), path.join(nextDir, "package.json"));
if (await exists(path.join(appDir, "extension"))) {
	await fs.cp(path.join(appDir, "extension"), path.join(nextDir, "extension"), {
		recursive: true,
		force: true,
	});
}

await fs.rm(previousDir, { recursive: true, force: true });
await fs.rename(appDir, previousDir);
try {
	const homeDir = path.join(previousDir, "Home");
	if (await exists(homeDir)) {
		await fs.rename(homeDir, path.join(nextDir, "Home"));
	}
	await fs.rename(nextDir, appDir);
} catch (error) {
	const movedHome = path.join(nextDir, "Home");
	if (await exists(movedHome)) {
		await fs.rename(movedHome, path.join(previousDir, "Home"));
	}
	if (!(await exists(appDir))) {
		await fs.rename(previousDir, appDir);
	}
	throw error;
}

console.log(`已更新原安装版并保留配置：${executable}`);
const game = spawn(executable, [], {
	cwd: installDir,
	detached: true,
	stdio: "ignore",
});
game.unref();
