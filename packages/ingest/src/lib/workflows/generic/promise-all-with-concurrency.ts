export async function promiseAllWithConcurrency<T>(
	tasks: Array<() => Promise<T>>,
	concurrency: number,
): Promise<T[]> {
	if (concurrency <= 0) {
		throw new Error(`Invalid concurrency value: ${concurrency}`);
	}

	const results: T[] = new Array(tasks.length);
	let nextIndex = 0;

	const worker = async () => {
		while (true) {
			const currentIndex = nextIndex++;
			if (currentIndex >= tasks.length) {
				return;
			}
			results[currentIndex] = await tasks[currentIndex]();
		}
	};

	await Promise.all(
		Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()),
	);

	return results;
}
