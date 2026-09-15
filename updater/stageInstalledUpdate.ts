import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

interface UpdateStatus {
	state: "running" | "ready" | "failed";
	message: string;
}

interface HuodongFile {
	path: string;
	size: number;
}

const useCurrentCheckout = process.argv.includes("--use-current-checkout");
const repoDir = process.env.NONAME_REPO_DIR || process.cwd();
const installDir = process.env.NONAME_INSTALL_DIR || path.join(process.env.LOCALAPPDATA || "", "Programs", "noname");
const resourcesDir = path.join(installDir, "resources");
const appDir = path.join(resourcesDir, "app");
const nextDir = path.join(resourcesDir, "app.next");
const previousDir = path.join(resourcesDir, "app.previous");
const temporaryDir = path.join(resourcesDir, "app.next.tmp");
const huodongTempDir = path.join(resourcesDir, "huodong.next");
const lockPath = path.join(resourcesDir, "update.lock");
const logPath = path.join(resourcesDir, "update.log");
const statusPath = path.join(resourcesDir, "update-status.json");
const huodongBase = "https://raw.githubusercontent.com/xizifu/HuoDong-update/main";

async function exists(target: string) {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}

async function log(message: string) {
	await fs.appendFile(logPath, `${new Date().toISOString()} ${message}\n`, "utf8");
}

async function setStatus(status: UpdateStatus) {
	await fs.writeFile(statusPath, `${JSON.stringify(status)}\n`, "utf8");
	await log(status.message);
}

function run(command: string, args: string[]) {
	const result = spawnSync(command, args, {
		cwd: repoDir,
		encoding: "utf8",
		shell: false,
		windowsHide: true,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} 失败：${result.stderr.trim() || `退出码 ${result.status}`}`);
	}
	return result.stdout.trim();
}

function runPnpm(args: string[]) {
	if (process.platform === "win32") {
		return run("powershell.exe", ["-NoProfile", "-Command", `pnpm ${args.join(" ")}`]);
	}
	return run("pnpm", args);
}

async function readCommit(root: string) {
	try {
		const value = JSON.parse(await fs.readFile(path.join(root, "game", "build-info.json"), "utf8"));
		return typeof value.commit === "string" ? value.commit : "";
	} catch {
		return "";
	}
}

function safeRelativePath(value: unknown) {
	if (
		typeof value !== "string" ||
		!value ||
		value.includes("\\") ||
		path.posix.isAbsolute(value) ||
		value.split("/").some(part => part === ".." || part === "")
	) {
		throw new Error(`活动武将文件路径无效：${String(value)}`);
	}
	return value;
}

async function fetchResponse(url: string) {
	const parsed = new URL(url);
	if (parsed.protocol !== "https:" || parsed.hostname !== "raw.githubusercontent.com") {
		throw new Error(`不允许的更新地址：${parsed.origin}`);
	}
	const response = await fetch(parsed, { signal: AbortSignal.timeout(30_000) });
	if (!response.ok) throw new Error(`下载失败 ${response.status}：${parsed.pathname}`);
	return response;
}

async function updateHuodong(huodongDir: string) {
	await setStatus({ state: "running", message: "正在检查活动武将…" });
	const fileData = (await (await fetchResponse(`${huodongBase}/js/file.json?t=${Date.now()}`)).json()) as {
		files?: unknown;
	};
	if (!Array.isArray(fileData.files) || fileData.files.length > 100_000) {
		throw new Error("活动武将 file.json 格式无效");
	}
	const remoteFiles = fileData.files.map(value => {
		if (typeof value !== "object" || value === null) throw new Error("活动武将文件项无效");
		const item = value as Partial<HuodongFile>;
		const file = safeRelativePath(item.path);
		if (!Number.isSafeInteger(item.size) || Number(item.size) < 0) throw new Error(`活动武将文件大小无效：${file}`);
		return { path: file, size: Number(item.size) };
	});
	const remotePaths = new Set(remoteFiles.map(item => item.path));

	let localFiles: HuodongFile[] = [];
	try {
		const localData = JSON.parse(await fs.readFile(path.join(huodongDir, "js", "file.json"), "utf8"));
		if (Array.isArray(localData.files)) localFiles = localData.files;
	} catch {
		// A missing local manifest means all remote files must be downloaded.
	}
	const localSizes = new Map(localFiles.map(item => [item.path, item.size]));
	const downloads = remoteFiles.filter(item => localSizes.get(item.path) !== item.size).map(item => item.path);
	downloads.push("info.json", "js/file.json");

	await fs.rm(huodongTempDir, { recursive: true, force: true });
	for (let index = 0; index < downloads.length; index++) {
		const file = safeRelativePath(downloads[index]);
		await setStatus({
			state: "running",
			message: `更新活动武将 ${index + 1}/${downloads.length}`,
		});
		const encoded = file.split("/").map(encodeURIComponent).join("/");
		const data = Buffer.from(await (await fetchResponse(`${huodongBase}/${encoded}?t=${Date.now()}`)).arrayBuffer());
		const target = path.join(huodongTempDir, file);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, data);
	}

	await fs.cp(huodongTempDir, huodongDir, { recursive: true, force: true });
	for (const item of localFiles) {
		const file = safeRelativePath(item.path);
		if (!remotePaths.has(file)) await fs.rm(path.join(huodongDir, file), { force: true });
	}
	await fs.rm(huodongTempDir, { recursive: true, force: true });
}

async function stageNoname() {
	await setStatus({ state: "running", message: "正在检查 noname main…" });
	if (!useCurrentCheckout) {
		const branch = run("git", ["branch", "--show-current"]);
		if (branch !== "main") throw new Error(`更新工作区必须位于 main，当前为 ${branch}`);
		if (run("git", ["status", "--porcelain", "--untracked-files=no"])) throw new Error("main 工作区存在未提交修改");
		run("git", ["pull", "--ff-only", "origin", "main"]);
	}
	const commit = run("git", ["rev-parse", "HEAD"]);
	const appCommit = await readCommit(appDir);
	const nextCommit = await readCommit(nextDir);
	if (appCommit !== commit && nextCommit !== commit) {
		await setStatus({ state: "running", message: "正在后台构建 noname…" });
		runPnpm(["install", "--frozen-lockfile"]);
		runPnpm(["build"]);
		await fs.rm(temporaryDir, { recursive: true, force: true });
		await fs.cp(path.join(repoDir, "dist"), temporaryDir, { recursive: true });
		await fs.cp(path.join(appDir, "app"), path.join(temporaryDir, "app"), { recursive: true });
		await fs.copyFile(path.join(appDir, "package.json"), path.join(temporaryDir, "package.json"));
		await fs.cp(path.join(appDir, "extension"), path.join(temporaryDir, "extension"), {
			recursive: true,
			force: true,
		});
		await fs.rm(nextDir, { recursive: true, force: true });
		await fs.rename(temporaryDir, nextDir);
	} else if (nextCommit !== commit) {
		await setStatus({ state: "running", message: "正在准备 noname 更新…" });
		await fs.rm(temporaryDir, { recursive: true, force: true });
		const homeDir = path.join(appDir, "Home");
		await fs.cp(appDir, temporaryDir, {
			recursive: true,
			filter: source => source !== homeDir && !source.startsWith(`${homeDir}${path.sep}`),
		});
		await fs.rm(nextDir, { recursive: true, force: true });
		await fs.rename(temporaryDir, nextDir);
	}
	const installedExtensions = path.join(appDir, "extension");
	const stagedExtensions = path.join(nextDir, "extension");
	await fs.rm(stagedExtensions, { recursive: true, force: true });
	if (await exists(installedExtensions)) {
		await fs.cp(installedExtensions, stagedExtensions, { recursive: true });
	}
}

function isGameRunning() {
	if (process.platform !== "win32") return false;
	return run("tasklist.exe", ["/FI", "IMAGENAME eq noname.exe", "/NH"]).toLowerCase().includes("noname.exe");
}

async function renameWithRetry(source: string, target: string) {
	const retryable = new Set(["EPERM", "EBUSY", "EACCES"]);
	for (let attempt = 0; ; attempt++) {
		try {
			await fs.rename(source, target);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (!retryable.has(code || "") || attempt >= 59) throw error;
			await new Promise(resolve => setTimeout(resolve, 1000));
		}
	}
}

async function applyWhenGameExits() {
	await setStatus({ state: "running", message: "更新就绪，退出游戏后自动应用" });
	while (isGameRunning()) {
		await new Promise(resolve => setTimeout(resolve, 2000));
	}
	if (!(await exists(nextDir))) return;

	await fs.rm(previousDir, { recursive: true, force: true });
	await renameWithRetry(appDir, previousDir);
	try {
		const homeDir = path.join(previousDir, "Home");
		if (await exists(homeDir)) await renameWithRetry(homeDir, path.join(nextDir, "Home"));
		await renameWithRetry(nextDir, appDir);
	} catch (error) {
		const movedHome = path.join(nextDir, "Home");
		if (await exists(movedHome)) await renameWithRetry(movedHome, path.join(previousDir, "Home"));
		if (!(await exists(appDir))) await renameWithRetry(previousDir, appDir);
		throw error;
	}
}

async function acquireLock() {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const handle = await fs.open(lockPath, "wx");
			await handle.writeFile(String(process.pid));
			return handle;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const pid = Number.parseInt(await fs.readFile(lockPath, "utf8").catch(() => ""), 10);
			try {
				if (Number.isSafeInteger(pid)) process.kill(pid, 0);
				await setStatus({ state: "running", message: "更新已经在后台进行" });
				process.exit(0);
			} catch {
				await fs.rm(lockPath, { force: true });
			}
		}
	}
	throw new Error("无法取得更新锁");
}

const lock = await acquireLock();
try {
	await stageNoname();
	await updateHuodong(path.join(nextDir, "extension", "活动武将"));
	await applyWhenGameExits();
	await setStatus({ state: "ready", message: "更新已完成，下次启动生效" });
} catch (error) {
	await setStatus({
		state: "failed",
		message: `更新失败：${error instanceof Error ? error.message : String(error)}`,
	});
	await log(error instanceof Error ? error.stack || error.message : String(error));
	await fs.rm(temporaryDir, { recursive: true, force: true });
	await fs.rm(huodongTempDir, { recursive: true, force: true });
} finally {
	await lock.close();
	await fs.rm(lockPath, { force: true });
}
