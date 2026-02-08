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

export async function signCallbackToken(
	params: CallbackParams,
	secret: string,
): Promise<string> {
	const exp = String(Date.now() + 3600_000);
	const payload = `${params.jobId}|${params.sourceVersionId}|${params.sourceId}|${exp}`;
	const sig = await hmacSha256(payload, secret);
	return btoa(
		JSON.stringify({
			jobId: params.jobId,
			svid: params.sourceVersionId,
			sid: params.sourceId,
			exp,
			sig,
		}),
	);
}

export async function verifyCallbackToken(
	token: string,
	secret: string,
): Promise<CallbackParams> {
	const { jobId, svid, sid, exp, sig } = JSON.parse(atob(token)) as {
		jobId: string;
		svid: string;
		sid: string;
		exp: string;
		sig: string;
	};

	if (!jobId || !svid || !sid || !exp || !sig) {
		throw new Error("Missing callback token fields");
	}

	const expiry = Number(exp);
	if (Date.now() > expiry) {
		throw new Error("Callback token expired");
	}

	const payload = `${jobId}|${svid}|${sid}|${exp}`;
	const expectedSig = await hmacSha256(payload, secret);
	if (sig !== expectedSig) {
		throw new Error("Invalid callback token signature");
	}

	return { jobId, sourceVersionId: svid, sourceId: sid };
}

export function extractBearerToken(request: Request): string {
	const auth = request.headers.get("Authorization");
	if (!auth?.startsWith("Bearer ")) {
		throw new Error("Missing Bearer token");
	}
	return auth.slice(7);
}
