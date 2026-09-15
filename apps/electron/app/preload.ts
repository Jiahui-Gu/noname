import { ipcRenderer } from "electron";
import { app, getCurrentWindow } from "@electron/remote";
import type { UpdateStatus } from "./update/service.ts";
const thisWindow = getCurrentWindow();

thisWindow.setAutoHideMenuBar(false);
thisWindow.setMenuBarVisibility(true);

thisWindow.on("leave-full-screen", () => {
	if (!thisWindow.isDestroyed()) {
		thisWindow.webContents.closeDevTools();
	} else {
		app.exit(0);
	}
});

const updateBridge = Object.freeze({
	setGameActive(active: boolean) {
		if (typeof active !== "boolean") throw new TypeError("active must be a boolean");
		ipcRenderer.send("noname-update:set-game-active", active);
	},
	reportReady() {
		ipcRenderer.send("noname-update:ready");
	},
	getStatus(): Promise<UpdateStatus> {
		return ipcRenderer.invoke("noname-update:get-status");
	},
});

Object.defineProperty(window, "nonameUpdate", {
	value: updateBridge,
	configurable: false,
	writable: false,
});

ipcRenderer.on("noname-update:status", (_event, status: UpdateStatus) => {
	window.dispatchEvent(new CustomEvent("noname-update-status", { detail: status }));
	if (status.state === "ready") console.info("游戏内容更新已就绪，将在安全时自动应用。");
});
