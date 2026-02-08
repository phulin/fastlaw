export interface CallbackParams {
	jobId: string;
	sourceVersionId: string;
	sourceId: string;
}

function toHex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

async function hmacSha256(payload: string, secret: string): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
	return toHex(sig);
}

export async function signCallbackUrl(
	baseUrl: string,
	params: CallbackParams,
	secret: string,
): Promise<string> {
	const url = new URL(baseUrl);
	url.searchParams.set("jobId", params.jobId);
	url.searchParams.set("svid", params.sourceVersionId);
	url.searchParams.set("sid", params.sourceId);
	const exp = String(Date.now() + 3600_000);
	url.searchParams.set("exp", exp);
	const payload = `${params.jobId}|${params.sourceVersionId}|${params.sourceId}|${exp}`;
	const sig = await hmacSha256(payload, secret);
	url.searchParams.set("sig", sig);
	return url.toString();
}

export async function verifyCallback(
	url: URL,
	secret: string,
): Promise<CallbackParams> {
	const jobId = url.searchParams.get("jobId");
	const svid = url.searchParams.get("svid");
	const sid = url.searchParams.get("sid");
	const exp = url.searchParams.get("exp");
	const sig = url.searchParams.get("sig");

	if (!jobId || !svid || !sid || !exp || !sig) {
		throw new Error("Missing callback parameters");
	}

	const expiry = Number(exp);
	if (Date.now() > expiry) {
		throw new Error("Callback URL expired");
	}

	const payload = `${jobId}|${svid}|${sid}|${exp}`;
	const expectedSig = await hmacSha256(payload, secret);
	if (sig !== expectedSig) {
		throw new Error("Invalid callback signature");
	}

	return { jobId, sourceVersionId: svid, sourceId: sid };
}
