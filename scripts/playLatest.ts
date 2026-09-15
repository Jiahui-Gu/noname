import { spawn, spawnSync } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

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
run(pnpm, ["install", "--frozen-lockfile"]);

const game = spawn(pnpm, ["-F", "@noname/electron", "dev"], {
	stdio: "inherit",
	shell: false,
});
game.on("error", error => {
	throw error;
});
game.on("exit", code => {
	process.exit(code ?? 0);
});
