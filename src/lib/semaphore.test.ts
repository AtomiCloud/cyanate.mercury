import { describe, expect, test } from "bun:test";
import { Semaphore } from "./semaphore.js";

describe("Semaphore", () => {
	test("acquire up to limit → all resolve immediately", async () => {
		const sem = new Semaphore(3);
		const releases: Array<() => void> = [];

		for (let i = 0; i < 3; i++) {
			const release = await sem.acquire();
			releases.push(release);
		}

		expect(sem.available).toBe(0);
		expect(sem.pending).toBe(0);

		for (const release of releases) release();
		expect(sem.available).toBe(3);
	});

	test("acquire limit+1 → last one waits until a release", async () => {
		const sem = new Semaphore(2);
		const _releases: Array<() => void> = [];

		const r1 = await sem.acquire();
		const r2 = await sem.acquire();
		expect(sem.available).toBe(0);
		expect(sem.pending).toBe(0);

		// This should be pending
		let acquired = false;
		const p = sem.acquire().then((release) => {
			acquired = true;
			return release;
		});

		// Give the microtask queue a chance to process
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(acquired).toBe(false);
		expect(sem.pending).toBe(1);

		// Release one → pending should resolve
		r1();
		const r3 = await p;
		expect(acquired).toBe(true);
		expect(sem.pending).toBe(0);

		r2();
		r3();
	});

	test("release in order → pending resolves FIFO", async () => {
		const sem = new Semaphore(1);
		const r1 = await sem.acquire();
		expect(sem.available).toBe(0);

		const order: number[] = [];
		const p1 = sem.acquire().then((r) => {
			order.push(1);
			return r;
		});
		const p2 = sem.acquire().then((r) => {
			order.push(2);
			return r;
		});

		r1(); // releases initial slot, triggers p1
		const r1b = await p1; // p1 resolved, holds the slot
		r1b(); // releases slot, triggers p2
		const r2 = await p2; // p2 resolved

		expect(order).toEqual([1, 2]);
		r2();
	});

	test("concurrent stress: 100 acquires with limit 5", async () => {
		const sem = new Semaphore(5);
		let maxConcurrent = 0;
		let currentConcurrent = 0;

		const acquireAndTrack = async (_i: number): Promise<void> => {
			const release = await sem.acquire();
			currentConcurrent++;
			if (currentConcurrent > maxConcurrent) maxConcurrent = currentConcurrent;

			// Hold for a tiny bit
			await new Promise((resolve) => setTimeout(resolve, 5));

			currentConcurrent--;
			release();
		};

		const promises = Array.from({ length: 100 }, (_, i) => acquireAndTrack(i));
		await Promise.all(promises);

		expect(maxConcurrent).toBeLessThanOrEqual(5);
		expect(maxConcurrent).toBeGreaterThan(0);
	});

	test("constructor rejects limit < 1", () => {
		expect(() => new Semaphore(0)).toThrow("Semaphore limit must be >= 1");
		expect(() => new Semaphore(-1)).toThrow("Semaphore limit must be >= 1");
	});

	test("double release is safe (idempotent)", async () => {
		const sem = new Semaphore(1);
		const release = await sem.acquire();
		expect(sem.available).toBe(0);
		release();
		expect(sem.available).toBe(1);
		// Double release should not increase available
		release();
		expect(sem.available).toBe(1);
	});
});
