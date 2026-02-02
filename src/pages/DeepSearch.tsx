import { marked } from "marked";
import { createSignal, For, Show } from "solid-js";
import { Header } from "~/components/Header";

interface Message {
	role: "user" | "assistant";
	content: string;
	isLoading?: boolean;
	isError?: boolean;
}

interface TraceItem {
	tool: string;
	detail: string;
	input?: unknown;
	output?: unknown;
}

interface Citation {
	id: string;
	score: number;
	section_id: string | null;
	section_label: string | null;
	section_number: string | null;
	section_title: string | null;
	chapter_id: string | null;
	title_id: string | null;
	text: string | null;
}

interface SearchPayload {
	query: string;
	searches: string[];
	answer: string;
	steps: Array<{ name: string; detail: string }>;
	trace: TraceItem[];
	citations: Citation[];
}

const buildSectionHref = (sectionId: string | null): string | null => {
	if (!sectionId || typeof sectionId !== "string") return null;
	const rawId = sectionId.replace(/^secs?_/, "");
	const [title, suffix] = rawId.split("-", 2);
	if (!title || !suffix) return null;
	return `/statutes/cgs/section/${title}/${suffix}`;
};

export default function DeepSearchPage() {
	const [messages, setMessages] = createSignal<Message[]>([
		{
			role: "assistant",
			content:
				"Ask about licensing, enforcement, or any statute. I will cite the most relevant sections.",
		},
	]);
	const [inputValue, setInputValue] = createSignal("");
	const [isSubmitting, setIsSubmitting] = createSignal(false);
	const [trace, setTrace] = createSignal<TraceItem[]>([]);
	const [citations, setCitations] = createSignal<Citation[]>([]);
	const [searches, setSearches] = createSignal<string[]>([]);
	const [steps, setSteps] = createSignal<
		Array<{ name: string; detail: string }>
	>([]);
	const [history, setHistory] = createSignal<
		Array<{ role: string; content: string }>
	>([]);

	let threadRef: HTMLDivElement | undefined;

	const scrollToBottom = () => {
		if (threadRef) {
			threadRef.scrollTop = threadRef.scrollHeight;
		}
	};

	const handleSubmit = async (e: Event) => {
		e.preventDefault();
		const query = inputValue().trim();
		if (!query || isSubmitting()) return;

		setInputValue("");
		setIsSubmitting(true);
		setTrace([]);
		setCitations([]);
		setSearches([]);
		setSteps([]);

		// Add user message
		setMessages((prev) => [...prev, { role: "user", content: query }]);

		// Add loading message
		const loadingIndex = messages().length + 1;
		setMessages((prev) => [
			...prev,
			{ role: "assistant", content: "Searching the index...", isLoading: true },
		]);
		scrollToBottom();

		try {
			const response = await fetch("/api/search", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					query,
					history: history().slice(-6),
				}),
			});

			const contentType = response.headers.get("content-type") ?? "";

			if (!response.ok && !contentType.includes("text/event-stream")) {
				const text = await response.text();
				throw new Error(`Search API failed (${response.status}): ${text}`);
			}

			let payload: SearchPayload | null = null;

			if (contentType.includes("text/event-stream")) {
				const reader = response.body?.getReader();
				if (!reader) throw new Error("Streaming response missing body.");

				const decoder = new TextDecoder();
				let buffer = "";
				const traceItems: TraceItem[] = [];

				const processEvent = (block: string) => {
					const lines = block.split("\n");
					let eventName = "message";
					const dataLines: string[] = [];

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
						traceItems.push(data as TraceItem);
						setTrace([...traceItems]);
					} else if (eventName === "final") {
						payload = data as SearchPayload;
					} else if (eventName === "error") {
						const errorData = data as {
							message?: string;
							stack?: string;
							trace?: TraceItem[];
						};
						const errorMessage =
							errorData.stack ?? errorData.message ?? "Search request failed.";
						setMessages((prev) =>
							prev.map((m, i) =>
								i === loadingIndex
									? { role: "assistant", content: errorMessage, isError: true }
									: m,
							),
						);
						if (errorData.trace) {
							setTrace(errorData.trace);
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
			} else {
				payload = await response.json();
			}

			if (payload) {
				const { answer } = payload;
				setMessages((prev) =>
					prev.map((m, i) =>
						i === loadingIndex ? { role: "assistant", content: answer } : m,
					),
				);
				setCitations(payload.citations);
				setSearches(payload.searches);
				setSteps(payload.steps);
				setTrace(payload.trace);
				setHistory((prev) => [
					...prev,
					{ role: "user", content: query },
					{ role: "assistant", content: answer },
				]);
			}
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			setMessages((prev) =>
				prev.map((m, i) =>
					i === loadingIndex
						? { role: "assistant", content: errorMessage, isError: true }
						: m,
				),
			);
		} finally {
			setIsSubmitting(false);
			scrollToBottom();
		}
	};

	return (
		<>
			<Header />
			<main class="chat-layout">
				<section class="chat-panel">
					<div class="chat-header">
						<p class="eyebrow">Agentic RAG Search</p>
						<h1>Ask the CGA in natural language.</h1>
						<p class="lead">
							The agent embeds your question, retrieves the most relevant
							sections, and responds with cited statute snippets.
						</p>
					</div>

					<div class="chat-thread" ref={threadRef} aria-live="polite">
						<For each={messages()}>
							{(message) => (
								<div class={`message ${message.role}`}>
									<div class="message-role">
										{message.role === "user" ? "You" : "Assistant"}
									</div>
									<div class="message-body">
										<Show
											when={!message.isLoading && !message.isError}
											fallback={
												<Show
													when={message.isError}
													fallback={<p>{message.content}</p>}
												>
													<pre>{message.content}</pre>
												</Show>
											}
										>
											<div
												class="markdown"
												innerHTML={marked.parse(message.content) as string}
											/>
										</Show>
									</div>
								</div>
							)}
						</For>
					</div>

					<form class="chat-form" onSubmit={handleSubmit}>
						<label class="chat-label" for="chat-input">
							Ask a question
						</label>
						<div class="chat-input-row">
							<textarea
								id="chat-input"
								name="query"
								rows={2}
								placeholder="Ex: What are the penalties for unlicensed daycare operations?"
								value={inputValue()}
								onInput={(e) => setInputValue(e.currentTarget.value)}
								disabled={isSubmitting()}
								required
							/>
							<button type="submit" disabled={isSubmitting()}>
								Send
							</button>
						</div>
						<div class="chat-hint">
							Add detail for better results, like a title number or chapter.
						</div>
					</form>
				</section>

				<aside class="chat-aside">
					<div class="chat-aside-card">
						<h2>Sources</h2>
						<Show
							when={citations().length > 0}
							fallback={
								<p class="muted">
									Matches will appear here with links to the full statute text.
								</p>
							}
						>
							<div class="source-list">
								<For each={citations().slice(0, 6)}>
									{(citation) => {
										const label = () =>
											citation.section_label ??
											citation.section_number ??
											"Section";
										const title = () =>
											citation.section_title
												? ` — ${citation.section_title}`
												: "";
										const href = () => buildSectionHref(citation.section_id);

										return (
											<div class="source-card">
												<div class="source-title">
													{label()}
													{title()}
												</div>
												<div class="source-snippet">
													{citation.text?.slice(0, 140) ?? ""}
												</div>
												<Show when={href()}>
													{(h) => (
														<a class="source-link" href={h()}>
															Open section
														</a>
													)}
												</Show>
											</div>
										);
									}}
								</For>
							</div>
						</Show>
					</div>

					<div class="chat-aside-card">
						<h2>Workflow</h2>
						<ul class="workflow-list">
							<Show
								when={steps().length > 0 || searches().length > 0}
								fallback={
									<>
										<li>Interpret the question.</li>
										<li>Retrieve from Pinecone.</li>
										<li>Synthesize with citations.</li>
									</>
								}
							>
								<Show when={searches().length > 0}>
									<li>Search queries: {searches().join(" | ")}</li>
								</Show>
								<For each={steps()}>
									{(step) => (
										<li>
											{step.name}: {step.detail}
										</li>
									)}
								</For>
							</Show>
						</ul>
					</div>

					<div class="chat-aside-card">
						<h2>Trace</h2>
						<ul class="workflow-list">
							<Show when={trace().length > 0} fallback={<li>No trace yet.</li>}>
								<For each={trace()}>
									{(item) => (
										<li>
											<div>
												{item.tool}: {item.detail}
											</div>
											<pre>
												{JSON.stringify(
													{
														input: item.input ?? null,
														output: item.output ?? null,
													},
													null,
													2,
												)}
											</pre>
										</li>
									)}
								</For>
							</Show>
						</ul>
					</div>
				</aside>
			</main>
		</>
	);
}
