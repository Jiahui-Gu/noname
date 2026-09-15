import { UpdateStore } from "./store.ts";
import type { UpdateStatus } from "./service.ts";

export class UpdateRuntime {
	private gameActive = false;
	private reloaded = false;
	private healthTimer?: ReturnType<typeof setTimeout>;
	private status: UpdateStatus = { state: "checking" };

	constructor(
		private readonly store: UpdateStore,
		private readonly reload: () => void,
		private readonly broadcast: (status: UpdateStatus) => void,
		private readonly healthTimeoutMs = 20_000
	) {}

	getStatus(): UpdateStatus {
		return this.status;
	}

	async startHealthCheck(): Promise<void> {
		if (this.healthTimer) clearTimeout(this.healthTimer);
		const state = await this.store.readState();
		if (!state?.pendingHealthCheck) return;
		this.healthTimer = setTimeout(() => {
			void this.store
				.rollback()
				.then(rolledBack => {
					if (rolledBack) this.reload();
				})
				.catch(error => this.setStatus({ state: "failed", message: `Update rollback failed: ${String(error)}` }));
		}, this.healthTimeoutMs);
	}

	setStatus(status: UpdateStatus): void {
		this.status = status;
		this.broadcast(status);
		if (status.state === "ready") {
			void this.startHealthCheck().catch(error => this.setStatus({ state: "failed", message: `Update health check failed: ${String(error)}` }));
			this.reloadWhenSafe();
		}
	}

	setGameActive(active: boolean): void {
		this.gameActive = active;
		if (!active && this.status.state === "ready") this.reloadWhenSafe();
	}

	async reportReady(): Promise<void> {
		if (this.healthTimer) clearTimeout(this.healthTimer);
		this.healthTimer = undefined;
		await this.store.markHealthy();
	}

	private reloadWhenSafe(): void {
		if (!this.gameActive && !this.reloaded) {
			this.reloaded = true;
			this.reload();
		}
	}
}
