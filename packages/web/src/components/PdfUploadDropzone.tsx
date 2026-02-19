import { For } from "solid-js";
import type { SourceVersionRecord } from "../lib/types";
import "../styles/pdf-upload.css";

interface PdfUploadDropzoneProps {
	sourceVersions: SourceVersionRecord[];
	selectedSourceVersionId: string;
	onSourceVersionChange: (sourceVersionId: string) => void;
	onFileSelected: (file: File) => void;
}

export function PdfUploadDropzone(props: PdfUploadDropzoneProps) {
	let fileInput: HTMLInputElement | undefined;

	const handleDrop = (event: DragEvent) => {
		event.preventDefault();
		const file = event.dataTransfer?.files[0];
		if (!file) return;
		props.onFileSelected(file);
	};

	const handleDropzoneClick = (event: MouseEvent) => {
		const target = event.target as HTMLElement | null;
		if (target?.closest(".pdf-upload-options")) return;
		fileInput?.click();
	};

	return (
		<section
			class="pdf-dropzone"
			onDragOver={(event) => event.preventDefault()}
			onDrop={handleDrop}
			onClick={handleDropzoneClick}
			onKeyPress={(event) => {
				if (event.key === "Enter" || event.key === " ") fileInput?.click();
			}}
			aria-label="PDF drop zone"
			tabindex="0"
		>
			<h1 class="pdf-dropzone-title">Upload PDF</h1>
			<p>Drag and drop a PDF file here, or click to select</p>
			<div class="pdf-upload-options">
				<label class="pdf-upload-field">
					<span>USC source version</span>
					<select
						class="pdf-upload-select"
						value={props.selectedSourceVersionId}
						onChange={(event) =>
							props.onSourceVersionChange(event.currentTarget.value)
						}
					>
						<For each={props.sourceVersions}>
							{(version) => (
								<option value={version.id}>
									{version.id} ({version.version_date})
								</option>
							)}
						</For>
					</select>
				</label>
			</div>
			<input
				type="file"
				accept="application/pdf"
				class="pdf-file-input-hidden"
				ref={fileInput}
				onChange={(event) => {
					const file = event.target.files?.[0];
					if (!file) return;
					props.onFileSelected(file);
				}}
			/>
			<button type="button" class="pdf-primary-button">
				Select File
			</button>
		</section>
	);
}
