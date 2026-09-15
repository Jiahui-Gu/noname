interface LocalUpdateStatus {
	state: "running" | "ready" | "failed";
	message: string;
}

export function installUpdateButton() {
	if (typeof window.require !== "function" || typeof window.process !== "object") return;

	const fs = window.require("fs");
	const path = window.require("path");
	const { spawn } = window.require("child_process");
	const resourcesDir = window.process.resourcesPath;
	const worker = path.join(resourcesDir, "app", "updater", "stageInstalledUpdate.ts");
	if (!fs.existsSync(worker)) return;

	const statusFile = path.join(resourcesDir, "update-status.json");
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = "一键更新";
	Object.assign(button.style, {
		position: "fixed",
		right: "16px",
		bottom: "16px",
		zIndex: "10000",
		padding: "9px 14px",
		border: "1px solid rgba(255,255,255,.45)",
		borderRadius: "8px",
		color: "white",
		background: "rgba(45,45,45,.9)",
		boxShadow: "0 2px 8px rgba(0,0,0,.35)",
		cursor: "pointer",
	});
	document.body.appendChild(button);

	let timer: ReturnType<typeof setInterval> | undefined;
	const refresh = async () => {
		try {
			const status = JSON.parse(await fs.promises.readFile(statusFile, "utf8")) as LocalUpdateStatus;
			button.textContent = status.message;
			if (status.state !== "running") {
				button.disabled = false;
				button.style.cursor = "pointer";
				if (timer) clearInterval(timer);
			}
		} catch {
			// Worker may not have written its first status yet.
		}
	};

	button.addEventListener("click", () => {
		button.disabled = true;
		button.style.cursor = "wait";
		const startingMessage = "正在启动更新…";
		button.textContent = startingMessage;
		const repoDir =
			localStorage.getItem("noname_update_repo") ||
			path.join(window.process.env.USERPROFILE, ".copilot", "repos", "noname");
		fs.writeFileSync(
			statusFile,
			`${JSON.stringify({ state: "running", message: startingMessage } satisfies LocalUpdateStatus)}\n`,
			"utf8",
		);
		const child = spawn("cmd.exe", ["/d", "/s", "/c", `pnpm exec tsx "${worker}"`], {
			cwd: repoDir,
			detached: true,
			stdio: "ignore",
			env: {
				...window.process.env,
				NONAME_REPO_DIR: repoDir,
				NONAME_INSTALL_DIR: path.dirname(resourcesDir),
			},
		});
		const showLaunchFailure = (message: string) => {
			let status: LocalUpdateStatus | undefined;
			try {
				status = JSON.parse(fs.readFileSync(statusFile, "utf8")) as LocalUpdateStatus;
			} catch {
				// A missing status is also a launch failure.
			}
			if (status?.state === "running" && status.message !== startingMessage) return;
			const failed = { state: "failed", message: `启动失败：${message}` } satisfies LocalUpdateStatus;
			fs.writeFileSync(statusFile, `${JSON.stringify(failed)}\n`, "utf8");
			button.disabled = false;
			button.style.cursor = "pointer";
			button.textContent = failed.message;
			if (timer) clearInterval(timer);
		};
		child.once("error", (error: Error) => {
			showLaunchFailure(error.message);
		});
		child.once("exit", (code: number | null) => {
			if (code !== null && code !== 0) showLaunchFailure(`更新进程退出码 ${code}`);
		});
		child.unref();
		timer = setInterval(refresh, 1000);
		void refresh();
	});
}
