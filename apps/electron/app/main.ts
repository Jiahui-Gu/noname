/// <reference types="vite/client" />
import { app, BrowserWindow, crashReporter, dialog, ipcMain, Menu, shell } from "electron";
import fs from "fs";
import path from "path";
import remote from "@electron/remote/main/index.js";
import createApp from "@noname/fs";
import { UpdateRuntime } from "./update/runtime.ts";
import { MainUpdateService, type UpdateStatus } from "./update/service.ts";
import { UpdateStore } from "./update/store.ts";
remote.initialize();
const dirname = path.join(import.meta.dirname, "../");

// 获取单实例锁
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
	// 如果获取失败，说明已经有实例在运行了，直接退出
	app.quit();
}

app.setAppUserModelId("com.libnoname.noname");

//防止32位无名杀的乱码
app.setName("无名杀");

function setPath(path1: any, path2: any) {
	app.getPath(path1);
	fs.mkdirSync(path2, { recursive: true });
	app.setPath(path1, path2);
}

setPath("home", path.join(dirname, "Home"));
setPath("appData", path.join(dirname, "Home", "AppData"));
setPath("userData", path.join(dirname, "Home", "UserData"));
setPath("temp", path.join(dirname, "Home", "Temp"));
setPath("cache", path.join(dirname, "Home", "Cache"));
//崩溃转储文件存储的目录
setPath("crashDumps", path.join(dirname, "Home", "crashDumps"));
//日志目录
setPath("logs", path.join(dirname, "Home", "logs"));

const updateStore = new UpdateStore(path.join(app.getPath("home"), "Updates"));
fs.mkdirSync(updateStore.currentDir, { recursive: true });
createApp({
	port: 8089,
	dirname: [updateStore.currentDir, dirname],
	server: true,
});

//崩溃处理
crashReporter.start({
	productName: "无名杀",
	//崩溃报告将被收集并存储在崩溃目录中，不会上传
	uploadToServer: false,
	compress: false,
});

// 其他实例启动时，主实例会通过 second-instance 事件接收其他实例的启动参数 `argv`
app.on("second-instance", (event, argv) => {
	// Windows 下通过协议URL启动时，URL会作为参数，所以需要在这个事件里处理
	if (process.platform === "win32") {
		createWindow();
	}
});

// macOS 下通过协议URL启动时，主实例会通过 open-url 事件接收这个 URL
app.on("open-url", (event, urlStr) => {
	createWindow();
});

app.setAboutPanelOptions({
	iconPath: "noname.ico",
	website: "https://github.com/libnoname/noname",
});

process.env["ELECTRON_DEFAULT_ERROR_MODE"] = "true";
process.env["ELECTRON_DISABLE_SECURITY_WARNINGS"] = "true";
process.noDeprecation = true;

let updateCheckStarted = false;
let waitForCurrentHealth = true;
let installerNoticeCommit: string | undefined;
let failureNotified = false;

const broadcastStatus = (status: UpdateStatus) => {
	for (const window of BrowserWindow.getAllWindows()) {
		if (!window.isDestroyed()) window.webContents.send("noname-update:status", status);
	}
	if (status.state !== "downloading") console.info(`[main-update] ${status.state}`);
	if (status.state === "installer-required" && installerNoticeCommit !== status.commit) {
		installerNoticeCommit = status.commit;
		const window = BrowserWindow.getAllWindows()[0];
		const options: Electron.MessageBoxOptions = {
				type: "info",
				title: "需要更新安装包",
				message: "此更新包含 Electron 或依赖变更，需要安装新版客户端。",
				buttons: ["打开发行页", "稍后"],
				defaultId: 0,
				cancelId: 1,
			};
		void (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options))
			.then(({ response }) => {
				if (response === 0) return shell.openExternal(status.releaseUrl);
			})
			.catch(error => console.error("[main-update] installer notification failed", error));
	}
	if (status.state === "failed" && !failureNotified) {
		failureNotified = true;
		const window = BrowserWindow.getAllWindows()[0];
		const options: Electron.MessageBoxOptions = {
				type: "error",
				title: "游戏内容更新失败",
				message: status.message,
				detail: "客户端将继续使用当前可运行版本。",
				buttons: ["确定"],
			};
		void (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options))
			.catch(error => console.error("[main-update] failure notification failed", error));
	}
};

const runtime = new UpdateRuntime(
	updateStore,
	() => {
		for (const window of BrowserWindow.getAllWindows()) {
			if (!window.isDestroyed()) window.webContents.reload();
		}
	},
	broadcastStatus
);

function readServedCommit(): string {
	for (const root of [updateStore.currentDir, dirname]) {
		try {
			const value: unknown = JSON.parse(fs.readFileSync(path.join(root, "game", "build-info.json"), "utf8"));
			if (typeof value === "object" && value !== null && typeof (value as { commit?: unknown }).commit === "string") {
				return (value as { commit: string }).commit;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[main-update] unable to read build info", error);
		}
	}
	return "unknown";
}

const updateService = new MainUpdateService(updateStore, {
	owner: "Jiahui-Gu",
	repo: "noname",
	releaseTag: "main-latest",
	maxPackageBytes: 1024 * 1024 * 1024,
	timeoutMs: 30_000,
	onStatus: status => runtime.setStatus(status),
});

function startUpdateCheckOnce() {
	if (updateCheckStarted || import.meta.env.DEV) return;
	updateCheckStarted = true;
	void updateService.check(readServedCommit());
}

function createWindow() {
	const window = createMainWindow();
	window.webContents.once("did-finish-load", () => {
		if (!waitForCurrentHealth) startUpdateCheckOnce();
	});
}

function createMainWindow() {
	let win = new BrowserWindow({
		width: 1000,
		height: 800,
		title: "无名杀",
		icon: path.join(dirname, "noname.ico"),
		webPreferences: {
			webSecurity: false,
			preload: path.join(dirname, "app/preload.js"),
			nodeIntegration: true, //主页面用node
			nodeIntegrationInSubFrames: true, //子页面用node
			nodeIntegrationInWorker: true, //worker用node
			contextIsolation: false, //必须为false
			plugins: true, //启用插件
			// @ts-ignore
			enableRemoteModule: true, //可以调用Remote
			experimentalFeatures: true, //启用Chromium的实验功能
		},
	});
	if (import.meta.env.DEV) {
		win.loadURL(`http://localhost:8080`);
	} else {
		win.loadURL(`http://localhost:8089/index.html`);
	}
	remote.enable(win.webContents);
	const menuTemplate: Electron.MenuItemConstructorOptions[] = [
		{
			label: "操作",
			submenu: [
				{
					label: "打开无名杀目录",
					click: () => {
						shell.showItemInFolder(path.join(app.getAppPath(), "app"));
					},
				},
			],
		},
		{
			label: "窗口",
			submenu: [
				{
					label: "重新加载当前窗口",
					role: "reload",
				},
				{
					label: "打开/关闭控制台",
					role: "toggleDevTools",
				},
				{
					type: "separator",
				},
				{
					label: "全屏模式",
					role: "togglefullscreen",
				},
				{
					label: "最小化",
					role: "minimize",
				},
				{
					type: "separator",
				},
			],
		},
		{
			label: "帮助",
			submenu: [
				{
					label: "bug反馈",
					click: () => {
						shell.openExternal("https://tieba.baidu.com/p/9117747182");
					},
				},
				{
					label: "版权声明",
					click: () => {
						dialog.showMessageBoxSync(win, {
							message:
								"【无名杀】属于个人（水乎）开发项目且【完全免费】。如非法倒卖用于牟利将承担法律责任 开发团队将追究到底",
							type: "info",
							title: "版权声明",
							icon: path.join(app.getAppPath(), "app", "noname.ico"),
						});
					},
				},
			],
		},
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
	return win;
}

app.whenReady().then(() => {
	void updateStore
		.initialize()
		.then(async () => {
			await runtime.startHealthCheck();
			createWindow();
		})
		.catch(error => {
			broadcastStatus({ state: "failed", message: `Update storage initialization failed: ${String(error)}` });
			createWindow();
		});
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});

	function isKnownRenderer(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
		return BrowserWindow.fromWebContents(event.sender) !== null;
	}

	ipcMain.on("noname-update:set-game-active", (event, active: unknown) => {
		if (isKnownRenderer(event) && typeof active === "boolean") runtime.setGameActive(active);
	});
	ipcMain.on("noname-update:ready", event => {
		if (!isKnownRenderer(event)) return;
		void runtime
			.reportReady()
			.then(() => {
				waitForCurrentHealth = false;
				startUpdateCheckOnce();
			})
			.catch(error => runtime.setStatus({ state: "failed", message: `Update health confirmation failed: ${String(error)}` }));
	});
	ipcMain.handle("noname-update:get-status", event => {
		if (!isKnownRenderer(event)) throw new Error("Unknown update IPC sender");
		return runtime.getStatus();
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});
