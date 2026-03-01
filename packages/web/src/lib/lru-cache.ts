export class LruCache<K, V> {
	private readonly entries = new Map<K, V>();

	constructor(private readonly maxEntries: number) {}

	get(key: K): V | undefined {
		const value = this.entries.get(key);
		if (value === undefined) return undefined;
		this.entries.delete(key);
		this.entries.set(key, value);
		return value;
	}

	set(key: K, value: V): void {
		if (this.entries.has(key)) {
			this.entries.delete(key);
		}
		this.entries.set(key, value);
		if (this.entries.size <= this.maxEntries) return;
		const oldestKey = this.entries.keys().next().value as K | undefined;
		if (oldestKey !== undefined) {
			this.entries.delete(oldestKey);
		}
	}

	get size(): number {
		return this.entries.size;
	}
}
