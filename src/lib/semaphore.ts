/**
 * Concurrency semaphore — limits parallel execution to N concurrent tasks.
 *
 * Stateful but no IO — fully testable in unit tests.
 */

export class Semaphore {
	private current = 0;
	private queue: Array<() => void> = [];

	constructor(private limit: number) {
		if (limit < 1) throw new Error("Semaphore limit must be >= 1");
	}

	async acquire(): Promise<() => void> {
		if (this.current < this.limit) {
			this.current++;
			return this.createRelease();
		}

		return new Promise<() => void>((resolve) => {
			this.queue.push(() => {
				this.current++;
				resolve(this.createRelease());
			});
		});
	}

	get available(): number {
		return this.limit - this.current;
	}

	get pending(): number {
		return this.queue.length;
	}

	private createRelease(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.current--;
			const next = this.queue.shift();
			if (next) next();
		};
	}
}
