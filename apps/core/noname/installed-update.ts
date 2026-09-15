export function startInstalledUpdate() {
	if (typeof window.require !== "function" || typeof window.process !== "object") return;

	const fs = window.require("fs");
	const path = window.require("path");
	const { spawn } = window.require("child_process");
	const resourcesDir = window.process.resourcesPath;
	const worker = path.join(resourcesDir, "app", "updater", "stageInstalledUpdate.ts");
	if (!fs.existsSync(worker)) return;

	const repoDir =
		localStorage.getItem("noname_update_repo") ||
		path.join(window.process.env.USERPROFILE, ".copilot", "repos", "noname");
	const launchLog = path.join(resourcesDir, "update-launch.log");
	const logFailure = (error: unknown) => {
		try {
			const message = error instanceof Error ? error.stack || error.message : String(error);
			fs.appendFileSync(launchLog, `${new Date().toISOString()} ${message}\n`);
		} catch {
			// Updater diagnostics must never interrupt game startup.
		}
	};
	let log: number | undefined;
	try {
		log = fs.openSync(launchLog, "a");
		const child = spawn("node.exe", ["--experimental-strip-types", worker], {
			cwd: repoDir,
			detached: true,
			windowsHide: true,
			stdio: ["ignore", log, log],
			env: {
				...window.process.env,
				NONAME_REPO_DIR: repoDir,
				NONAME_INSTALL_DIR: path.dirname(resourcesDir),
			},
		});
		child.once("error", logFailure);
		child.unref();
	} catch (error) {
		logFailure(error);
	} finally {
		if (log !== undefined) {
			try {
				fs.closeSync(log);
			} catch (error) {
				logFailure(error);
			}
		}
	}
}
