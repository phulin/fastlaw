import type { Paragraph } from "./text-extract";

/**
 * Clusters indentations using k-means and assigns levels.
 */

export function assignIndentationLevels(paragraphs: Paragraph[]): Paragraph[] {
	if (paragraphs.length === 0) return [];

	const indents = paragraphs.map((p) => p.lines[0].xStart);

	let bestSilhouette = -Infinity;
	let bestAssignment: number[] = [];
	let bestMeans: number[] = [];
	let bestK = 0;

	for (let k = 3; k <= 7; k++) {
		if (k > indents.length) break;

		const { means, assignments } = kMeans(indents, k);
		const silhouette = silhouetteScore(indents, assignments, k);
		if (
			silhouette > bestSilhouette ||
			(silhouette === bestSilhouette && k < bestK)
		) {
			bestSilhouette = silhouette;
			bestAssignment = assignments;
			bestMeans = means;
			bestK = k;
		}
	}

	const clusterToLevel = new Map<number, number>();
	[...bestMeans.keys()]
		.sort((a, b) => bestMeans[a] - bestMeans[b])
		.forEach((clusterIndex, level) => {
			clusterToLevel.set(clusterIndex, level);
		});

	return paragraphs.map((p, i) => ({
		...p,
		level: clusterToLevel.get(bestAssignment[i]),
	}));
}
function kMeans(
	data: number[],
	k: number,
): { means: number[]; assignments: number[]; score: number } {
	if (data.length === 0) return { means: [], assignments: [], score: 0 };
	if (k >= data.length) {
		return {
			means: [...data],
			assignments: data.map((_, i) => i),
			score: 0,
		};
	}

	// Simple K-Means++ like initialization: pick first random, then pick furthest.
	const means = [data[0]];
	while (means.length < k) {
		let maxDist = -1;
		let nextMean = data[0];
		for (const x of data) {
			const minDistToMean = Math.min(...means.map((m) => Math.abs(x - m)));
			if (minDistToMean > maxDist) {
				maxDist = minDistToMean;
				nextMean = x;
			}
		}
		means.push(nextMean);
	}

	const assignments = new Array(data.length).fill(-1);
	let changed = true;
	let iterations = 0;

	while (changed && iterations < 100) {
		changed = false;
		iterations++;

		// Assignment step
		for (let i = 0; i < data.length; i++) {
			let minDist = Infinity;
			let bestCluster = -1;
			for (let j = 0; j < k; j++) {
				const dist = Math.abs(data[i] - means[j]);
				if (dist < minDist) {
					minDist = dist;
					bestCluster = j;
				}
			}
			if (assignments[i] !== bestCluster) {
				assignments[i] = bestCluster;
				changed = true;
			}
		}

		// Update step
		const newMeans = new Array(k).fill(0);
		const counts = new Array(k).fill(0);
		for (let i = 0; i < data.length; i++) {
			newMeans[assignments[i]] += data[i];
			counts[assignments[i]]++;
		}
		for (let j = 0; j < k; j++) {
			if (counts[j] > 0) {
				means[j] = newMeans[j] / counts[j];
			}
		}
	}

	// Calculate score: mean squared distance from cluster mean
	let totalSqDist = 0;
	for (let i = 0; i < data.length; i++) {
		totalSqDist += (data[i] - means[assignments[i]]) ** 2;
	}
	const score = totalSqDist / data.length;

	return { means, assignments, score };
}
function silhouetteScore(
	data: number[],
	assignments: number[],
	k: number,
): number {
	if (data.length <= 1) return 0;

	const clusters: number[][] = Array.from({ length: k }, () => []);
	for (let i = 0; i < assignments.length; i++) {
		clusters[assignments[i]].push(i);
	}

	const nonEmptyClusterCount = clusters.reduce(
		(count, cluster) => count + (cluster.length > 0 ? 1 : 0),
		0,
	);
	if (nonEmptyClusterCount <= 1) return -1;

	let totalScore = 0;
	for (let i = 0; i < data.length; i++) {
		const clusterId = assignments[i];
		const ownCluster = clusters[clusterId];
		if (ownCluster.length === 1) {
			continue;
		}

		let a = 0;
		let ownDistSum = 0;
		for (const idx of ownCluster) {
			if (idx === i) continue;
			ownDistSum += Math.abs(data[i] - data[idx]);
		}
		a = ownDistSum / (ownCluster.length - 1);

		let b = Infinity;
		for (let otherClusterId = 0; otherClusterId < k; otherClusterId++) {
			if (otherClusterId === clusterId) continue;
			const otherCluster = clusters[otherClusterId];
			if (otherCluster.length === 0) continue;

			let otherDistSum = 0;
			for (const idx of otherCluster) {
				otherDistSum += Math.abs(data[i] - data[idx]);
			}
			b = Math.min(b, otherDistSum / otherCluster.length);
		}

		if (!Number.isFinite(b)) continue;
		const denom = Math.max(a, b);
		if (denom === 0) continue;
		totalScore += (b - a) / denom;
	}

	return totalScore / data.length;
}
