import { marked } from "marked";

const chatRoot = document.querySelector(".chat-layout") as HTMLElement | null;
const endpoint = chatRoot?.dataset.endpoint ?? "";
const thread = document.querySelector("#chat-thread") as HTMLDivElement | null;
const form = document.querySelector("#chat-form") as HTMLFormElement | null;
const input = document.querySelector(
	"#chat-input",
) as HTMLTextAreaElement | null;
const sourceList = document.querySelector("#source-list") as HTMLElement | null;
const workflowList = document.querySelector(
	"#workflow-list",
) as HTMLUListElement | null;
const traceList = document.querySelector(
	"#trace-list",
) as HTMLUListElement | null;

const history: Array<{ role: string; content: string }> = [];

const buildSectionHref = (sectionId: string | null) => {
	if (!sectionId || typeof sectionId !== "string") return null;
	const rawId = sectionId.replace(/^secs?_/, "");
	const [title, suffix] = rawId.split("-", 2);
	if (!title || !suffix) return null;
	return `/sections/${title}/${suffix}/`;
};

const appendMessage = (role: "user" | "assistant", content: string | Node) => {
	const wrapper = document.createElement("div");
	wrapper.className = `message ${role}`;
	const roleEl = document.createElement("div");
	roleEl.className = "message-role";
	roleEl.textContent = role === "user" ? "You" : "Assistant";
	const body = document.createElement("div");
	body.className = "message-body";
	if (typeof content === "string") {
		body.textContent = content;
	} else {
		body.appendChild(content);
	}
	wrapper.appendChild(roleEl);
	wrapper.appendChild(body);
	thread?.appendChild(wrapper);
	wrapper.scrollIntoView({ behavior: "smooth", block: "end" });
	return wrapper;
};

const renderAssistant = (payload: Record<string, unknown>) => {
	const container = document.createElement("div");
	const answer = document.createElement("div");
	answer.className = "markdown";
	answer.innerHTML = marked.parse(String(payload.answer ?? "")) as string;
	container.appendChild(answer);

	if (Array.isArray(payload.steps) && payload.steps.length) {
		const steps = document.createElement("ul");
		steps.className = "agent-steps";
		payload.steps.forEach((step: { name: string; detail: string }) => {
			const li = document.createElement("li");
			li.textContent = `${step.name}: ${step.detail}`;
			steps.appendChild(li);
		});
		container.appendChild(steps);
	}

	if (Array.isArray(payload.citations) && payload.citations.length) {
		const citations = document.createElement("div");
		citations.className = "message-sources";
		payload.citations.slice(0, 5).forEach((item: Record<string, unknown>) => {
			const card = document.createElement("div");
			card.className = "source-card";
			const title = document.createElement("div");
			title.className = "source-title";
			const label = item.section_label ?? item.section_number ?? "Section";
			const suffix = item.section_title ? ` — ${item.section_title}` : "";
			title.textContent = `${label}${suffix}`;
			const snippet = document.createElement("div");
			snippet.className = "source-snippet";
			snippet.textContent = item.text ? String(item.text).slice(0, 180) : "";
			const link = buildSectionHref(item.section_id as string | null);
			if (link) {
				const anchor = document.createElement("a");
				anchor.className = "source-link";
				anchor.href = link;
				anchor.textContent = "Open section";
				card.appendChild(title);
				card.appendChild(snippet);
				card.appendChild(anchor);
			} else {
				card.appendChild(title);
				card.appendChild(snippet);
			}
			citations.appendChild(card);
		});
		container.appendChild(citations);
	}

	return container;
};

const renderSources = (citations: Array<Record<string, unknown>>) => {
	if (!sourceList) return;
	sourceList.innerHTML = "";
	if (!Array.isArray(citations) || citations.length === 0) {
		const empty = document.createElement("p");
		empty.className = "muted";
		empty.textContent = "No citations returned yet.";
		sourceList.appendChild(empty);
		return;
	}
	citations.slice(0, 6).forEach((item) => {
		const card = document.createElement("div");
		card.className = "source-card";
		const label = item.section_label ?? item.section_number ?? "Section";
		const suffix = item.section_title ? ` — ${item.section_title}` : "";
		const header = document.createElement("div");
		header.className = "source-title";
		header.textContent = `${label}${suffix}`;
		const snippet = document.createElement("div");
		snippet.className = "source-snippet";
		snippet.textContent = item.text ? String(item.text).slice(0, 140) : "";
		const link = buildSectionHref(item.section_id as string | null);
		if (link) {
			const anchor = document.createElement("a");
			anchor.className = "source-link";
			anchor.href = link;
			anchor.textContent = "Open section";
			card.appendChild(header);
			card.appendChild(snippet);
			card.appendChild(anchor);
		} else {
			card.appendChild(header);
			card.appendChild(snippet);
		}
		sourceList.appendChild(card);
	});
};

const renderWorkflow = (
	steps: Array<{ name: string; detail: string }>,
	searches: string[],
) => {
	if (!workflowList || !Array.isArray(steps)) return;
	workflowList.innerHTML = "";
	if (Array.isArray(searches) && searches.length) {
		const header = document.createElement("li");
		header.textContent = `Search queries: ${searches.join(" | ")}`;
		workflowList.appendChild(header);
	}
	steps.forEach((step) => {
		const li = document.createElement("li");
		li.textContent = `${step.name}: ${step.detail}`;
		workflowList.appendChild(li);
	});
};

const renderTrace = (trace: Array<Record<string, unknown>>) => {
	if (!traceList) return;
	traceList.innerHTML = "";
	if (!Array.isArray(trace) || trace.length === 0) {
		const empty = document.createElement("li");
		empty.textContent = "No trace available yet.";
		traceList.appendChild(empty);
		return;
	}
	trace.forEach((item) => {
		const li = document.createElement("li");
		const title = document.createElement("div");
		title.textContent = `${item.tool}: ${item.detail}`;
		const pre = document.createElement("pre");
		pre.textContent = JSON.stringify(
			{ input: item.input ?? null, output: item.output ?? null },
			null,
			2,
		);
		li.appendChild(title);
		li.appendChild(pre);
		traceList.appendChild(li);
	});
};

if (!endpoint) {
	appendMessage(
		"assistant",
		"Missing PUBLIC_SEARCH_API_URL. Set it to your deployed Worker URL so I can call the search API.",
	);
	if (form) {
		form.querySelector("button")?.setAttribute("disabled", "true");
		input?.setAttribute("disabled", "true");
	}
}

form?.addEventListener("submit", async (event) => {
	event.preventDefault();
	const value = input?.value?.trim();
	if (!value) return;
	if (input) input.value = "";
	appendMessage("user", value);
	history.push({ role: "user", content: value });

	const thinking = appendMessage("assistant", "Searching the index...");

	let payload: Record<string, unknown> | null = null;
	try {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: value,
				history: history.slice(-6),
			}),
		});
		const contentType = response.headers.get("content-type") ?? "";
		if (!response.ok && !contentType.includes("text/event-stream")) {
			const text = await response.text();
			let detail = text;
			try {
				const json = JSON.parse(text);
				detail = JSON.stringify(json, null, 2);
			} catch {}
			throw new Error(`Search API failed (${response.status}):\n${detail}`);
		}

		if (!contentType.includes("text/event-stream")) {
			payload = await response.json();
		} else {
			const reader = response.body?.getReader();
			if (!reader) {
				throw new Error("Streaming response missing body.");
			}
			const decoder = new TextDecoder();
			let buffer = "";
			const traceItems: Array<Record<string, unknown>> = [];
			renderTrace(traceItems);

			const processEvent = (block: string) => {
				const lines = block.split("\n");
				let eventName = "message";
				const dataLines = [];
				for (const line of lines) {
					if (line.startsWith("event:")) {
						eventName = line.slice(6).trim();
					} else if (line.startsWith("data:")) {
						dataLines.push(line.slice(5).trim());
					}
				}
				const raw = dataLines.join("\n");
				let data: unknown = raw;
				try {
					data = JSON.parse(raw);
				} catch {}
				if (eventName === "trace") {
					traceItems.push(data as Record<string, unknown>);
					renderTrace(traceItems);
				} else if (eventName === "final") {
					payload = data as Record<string, unknown>;
				} else if (eventName === "error") {
					const errorBody = thinking.querySelector(".message-body");
					if (errorBody) {
						const message =
							(data as Record<string, unknown>)?.stack ??
							(data as Record<string, unknown>)?.message ??
							"Search request failed.";
						const pre = document.createElement("pre");
						pre.textContent = String(message);
						errorBody.innerHTML = "";
						errorBody.appendChild(pre);
					}
					if (Array.isArray((data as Record<string, unknown>)?.trace)) {
						renderTrace(
							(data as Record<string, unknown>).trace as Array<
								Record<string, unknown>
							>,
						);
					}
				}
			};

			while (true) {
				const { value: chunk, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(chunk, { stream: true });
				let idx = buffer.indexOf("\n\n");
				while (idx !== -1) {
					const block = buffer.slice(0, idx);
					buffer = buffer.slice(idx + 2);
					if (block.trim()) {
						processEvent(block);
					}
					idx = buffer.indexOf("\n\n");
				}
			}
		}
	} catch (error) {
		const body = thinking.querySelector(".message-body");
		if (body) {
			const message =
				(error as Error)?.stack ??
				(error as Error)?.message ??
				"Search request failed.";
			const pre = document.createElement("pre");
			pre.textContent = message;
			body.innerHTML = "";
			body.appendChild(pre);
		}
		return;
	}

	if (payload) {
		const rendered = renderAssistant(payload);
		const body = thinking.querySelector(".message-body");
		if (body) {
			body.innerHTML = "";
			body.appendChild(rendered);
		}
		renderSources(payload.citations as Array<Record<string, unknown>>);
		renderWorkflow(
			payload.steps as Array<{ name: string; detail: string }>,
			payload.searches as string[],
		);
		renderTrace(payload.trace as Array<Record<string, unknown>>);
		history.push({ role: "assistant", content: String(payload.answer ?? "") });
	}
});
