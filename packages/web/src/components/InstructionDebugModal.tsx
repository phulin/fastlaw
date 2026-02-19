import { For, Show } from "solid-js";
import { renderMarkdown } from "../lib/markdown";
import { formatEditTree, formatParseTree } from "../lib/pdf/debug-formatters";
import "../styles/pdf-instruction-modal.css";
import type { InstructionPageItem } from "./PageRow";

interface InstructionDebugModalProps {
	item: InstructionPageItem | null;
	onClose: () => void;
}

export function InstructionDebugModal(props: InstructionDebugModalProps) {
	return (
		<Show when={props.item}>
			{(selected) => {
				const item = selected();
				const instruction = item.instruction;
				const effect = item.amendmentEffect;
				const workflowDebug = item.workflowDebug;
				const instructionPageRange = `${instruction.startPage}-${instruction.endPage}`;

				return (
					<div class="pdf-instruction-modal-backdrop">
						<div
							class="pdf-instruction-modal"
							role="dialog"
							aria-modal="true"
							aria-label="Instruction debug workflow"
						>
							<header class="pdf-instruction-modal-header">
								<h2 class="pdf-instruction-modal-title">
									Instruction Debug Workflow
								</h2>
								<button
									type="button"
									class="pdf-secondary-button"
									onClick={props.onClose}
								>
									Close
								</button>
							</header>

							<div class="pdf-instruction-modal-content">
								<div class="pdf-instruction-modal-grid">
									<div class="pdf-instruction-modal-kv">
										<span>Bill section</span>
										<code>{instruction.billSection ?? "n/a"}</code>
									</div>
									<div class="pdf-instruction-modal-kv">
										<span>USC citation</span>
										<code>{instruction.uscCitation ?? "n/a"}</code>
									</div>
									<div class="pdf-instruction-modal-kv">
										<span>Section path</span>
										<code>{item.sectionPath ?? "n/a"}</code>
									</div>
									<div class="pdf-instruction-modal-kv">
										<span>Status</span>
										<code>{effect?.status ?? "uncomputed"}</code>
									</div>
									<div class="pdf-instruction-modal-kv">
										<span>Instruction pages</span>
										<code>{instructionPageRange}</code>
									</div>
									<div class="pdf-instruction-modal-kv">
										<span>Root target path</span>
										<code>{instruction.targetScopePath || "n/a"}</code>
									</div>
								</div>

								<section class="pdf-instruction-modal-section">
									<h3>Section Text (Amendatory Instruction)</h3>
									<div
										class="pdf-instruction-modal-markdown markdown"
										innerHTML={renderMarkdown(workflowDebug.sectionText)}
									/>
								</section>

								<section class="pdf-instruction-modal-section">
									<h3>Paragraph Split</h3>
									<pre class="pdf-instruction-modal-code">
										{workflowDebug.splitLines
											.map(
												(line, index) => `${index + 1}. ${line || "(blank)"}`,
											)
											.join("\n")}
									</pre>
								</section>

								<section class="pdf-instruction-modal-section">
									<h3>Parse Tree</h3>
									<div class="pdf-instruction-modal-grid">
										<div class="pdf-instruction-modal-kv">
											<span>Parser status</span>
											<code>
												{workflowDebug.parsedInstruction ? "parsed" : "failed"}
											</code>
										</div>
										<div class="pdf-instruction-modal-kv">
											<span>Parse offset</span>
											<code>
												{workflowDebug.parsedInstruction
													? String(workflowDebug.parsedInstruction.parseOffset)
													: "n/a"}
											</code>
										</div>
									</div>
									<pre class="pdf-instruction-modal-code">
										{formatParseTree(workflowDebug.parsedInstruction)}
									</pre>
								</section>

								<section class="pdf-instruction-modal-section">
									<h3>Edit Tree</h3>
									<div class="pdf-instruction-modal-grid">
										<div class="pdf-instruction-modal-kv">
											<span>Translation status</span>
											<code>
												{workflowDebug.translatedEditTree
													? "built"
													: "unavailable"}
											</code>
										</div>
										<div class="pdf-instruction-modal-kv">
											<span>Translation issues</span>
											<code>
												{workflowDebug.translatedEditTree
													? String(
															workflowDebug.translatedEditTree.issues.length,
														)
													: "n/a"}
											</code>
										</div>
									</div>
									<Show when={workflowDebug.translatedEditTree}>
										{(translation) => (
											<>
												<Show when={translation().issues.length > 0}>
													<pre class="pdf-instruction-modal-code">
														{translation()
															.issues.map(
																(issue, index) =>
																	`${index + 1}. ${issue.message}${
																		issue.nodeType
																			? ` [node=${issue.nodeType}]`
																			: ""
																	}${
																		issue.sourceText
																			? `\n   source: ${issue.sourceText}`
																			: ""
																	}`,
															)
															.join("\n")}
													</pre>
												</Show>
												<pre class="pdf-instruction-modal-code">
													{formatEditTree(translation().tree)}
												</pre>
											</>
										)}
									</Show>
								</section>

								<Show
									when={effect}
									fallback={
										<section class="pdf-instruction-modal-section">
											<h3>Apply Result</h3>
											<p>No section body was available for matching.</p>
										</section>
									}
								>
									{(resolvedEffect) => (
										<section class="pdf-instruction-modal-section">
											<h3>Apply Result</h3>
											<div class="pdf-instruction-modal-grid">
												<div class="pdf-instruction-modal-kv">
													<span>Apply status</span>
													<code>{resolvedEffect().status}</code>
												</div>
												<div class="pdf-instruction-modal-kv">
													<span>Failure reason</span>
													<code>
														{resolvedEffect().debug.failureReason ?? "none"}
													</code>
												</div>
												<div class="pdf-instruction-modal-kv">
													<span>Section text length</span>
													<code>
														{String(resolvedEffect().debug.sectionTextLength)}
													</code>
												</div>
												<div class="pdf-instruction-modal-kv">
													<span>Operation count</span>
													<code>
														{String(resolvedEffect().debug.operationCount)}
													</code>
												</div>
												<div class="pdf-instruction-modal-kv">
													<span>Final edits</span>
													<code>{String(resolvedEffect().changes.length)}</code>
												</div>
											</div>
											<Show
												when={resolvedEffect().changes.length > 0}
												fallback={<p>No final edits were produced by apply.</p>}
											>
												<For each={resolvedEffect().changes}>
													{(change, index) => (
														<article class="pdf-instruction-attempt">
															<h4>Edit {index() + 1}</h4>
															<div class="pdf-instruction-modal-kv">
																<span>Deleted</span>
																<pre class="pdf-instruction-modal-code">
																	{change.deleted || "(none)"}
																</pre>
															</div>
															<div class="pdf-instruction-modal-kv">
																<span>Inserted</span>
																<pre class="pdf-instruction-modal-code">
																	{change.inserted || "(none)"}
																</pre>
															</div>
														</article>
													)}
												</For>
											</Show>
											<For each={resolvedEffect().debug.operationAttempts}>
												{(attempt, index) => (
													<article class="pdf-instruction-attempt">
														<h4>Attempt {index() + 1}</h4>
														<div class="pdf-instruction-modal-grid">
															<div class="pdf-instruction-modal-kv">
																<span>Operation</span>
																<code>{attempt.operationType}</code>
															</div>
															<div class="pdf-instruction-modal-kv">
																<span>Outcome</span>
																<code>{attempt.outcome}</code>
															</div>
															<div class="pdf-instruction-modal-kv">
																<span>Target path</span>
																<code>{attempt.targetPath ?? "n/a"}</code>
															</div>
															<div class="pdf-instruction-modal-kv">
																<span>Scoped range</span>
																<code>
																	{attempt.scopedRange
																		? `${attempt.scopedRange.start}-${attempt.scopedRange.end} (${attempt.scopedRange.length} chars)`
																		: "none"}
																</code>
															</div>
															<div class="pdf-instruction-modal-kv">
																<span>Search kind</span>
																<code>{attempt.searchTextKind}</code>
															</div>
															<div class="pdf-instruction-modal-kv">
																<span>Search index</span>
																<code>
																	{attempt.searchIndex === null
																		? "none"
																		: String(attempt.searchIndex)}
																</code>
															</div>
														</div>
														<div class="pdf-instruction-modal-kv">
															<span>Search text</span>
															<pre class="pdf-instruction-modal-code">
																{attempt.searchText ?? "n/a"}
															</pre>
														</div>
														<div class="pdf-instruction-modal-kv">
															<span>Scoped text preview</span>
															<pre class="pdf-instruction-modal-code">
																{attempt.scopedRange?.preview ?? "n/a"}
															</pre>
														</div>
														<div class="pdf-instruction-modal-kv">
															<span>Operation text</span>
															<pre class="pdf-instruction-modal-code">
																{attempt.nodeText}
															</pre>
														</div>
													</article>
												)}
											</For>
										</section>
									)}
								</Show>
							</div>
						</div>
					</div>
				);
			}}
		</Show>
	);
}
