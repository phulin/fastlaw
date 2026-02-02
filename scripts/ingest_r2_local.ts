import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const readArg = (flag: string, fallback: string) => {
	const index = process.argv.indexOf(flag);
	if (index === -1) return fallback;
	return process.argv[index + 1] ?? fallback;
};

const bucket = readArg("--bucket", "fastlaw-content");
const dir = readArg("--dir", "data/r2");
const root = path.resolve(dir);

const walk = (current: string): string[] => {
	const entries = readdirSync(current, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = path.join(current, entry.name);
		if (entry.isDirectory()) {
			files.push(...walk(fullPath));
			continue;
		}
		if (entry.isFile()) {
			files.push(fullPath);
		}
	}
	return files;
};

const files = walk(root).filter((file) => statSync(file).isFile());
const total = files.length;

const wranglerEnv = {
	...process.env,
	WRANGLER_LOG: "none",
};

console.log(`Uploading ${total} files to ${bucket} from ${root}...`);
let uploaded = 0;

for (const file of files) {
	const relative = path.relative(root, file);
	const key = relative.split(path.sep).join(path.posix.sep);
	uploaded += 1;
	console.log(`[${uploaded}/${total}] ${key}`);
	const result = spawnSync(
		"yarn",
		[
			"wrangler",
			"r2",
			"object",
			"put",
			`${bucket}/${key}`,
			"--file",
			file,
			"--local",
		],
		{ stdio: "inherit", env: wranglerEnv },
	);
	if ((result.status ?? 1) !== 0) {
		process.exit(result.status ?? 1);
	}
}
console.log(`Done. Uploaded ${uploaded} files.`);
