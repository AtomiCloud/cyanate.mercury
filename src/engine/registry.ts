/**
 * Segment registry.
 *
 * Segments are registered programmatically, then the CLI can list them,
 * validate DAG dependencies, and execute them.
 */

import type { SegmentDef } from "./types.js";

export class SegmentRegistry {
	private segments = new Map<string, SegmentDef>();

	register(segment: SegmentDef): void {
		if (this.segments.has(segment.id)) {
			throw new Error(`Segment "${segment.id}" is already registered`);
		}
		this.segments.set(segment.id, segment);
	}

	get(id: string): SegmentDef {
		const seg = this.segments.get(id);
		if (!seg) {
			throw new Error(
				`Segment "${id}" not found. Available: ${this.listIds().join(", ")}`,
			);
		}
		return seg;
	}

	has(id: string): boolean {
		return this.segments.has(id);
	}

	listIds(): string[] {
		return [...this.segments.keys()];
	}

	list(): SegmentDef[] {
		return [...this.segments.values()];
	}

	/**
	 * Validate that all segment dependencies exist in the registry.
	 */
	validateDeps(): string[] {
		const errors: string[] = [];
		for (const seg of this.segments.values()) {
			for (const dep of seg.depends) {
				if (!this.segments.has(dep)) {
					errors.push(
						`Segment "${seg.id}" depends on "${dep}", which is not registered`,
					);
				}
			}
		}
		return errors;
	}

	/**
	 * Return topological order of segments (dependencies first).
	 * Throws on cycles.
	 */
	topologicalOrder(): string[] {
		const visited = new Set<string>();
		const visiting = new Set<string>();
		const order: string[] = [];

		const visit = (id: string) => {
			if (visited.has(id)) return;
			if (visiting.has(id)) {
				throw new Error(`Cycle detected in segment DAG involving "${id}"`);
			}

			visiting.add(id);
			const seg = this.get(id);
			for (const dep of seg.depends) {
				visit(dep);
			}
			visiting.delete(id);
			visited.add(id);
			order.push(id);
		};

		for (const id of this.segments.keys()) {
			visit(id);
		}

		return order;
	}
}

/** Global registry instance */
export const registry = new SegmentRegistry();
