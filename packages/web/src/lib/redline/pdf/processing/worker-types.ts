import type { PageItem, PageLayout } from "../models";

export interface WorkerPageItemsPayload {
	items: { item: PageItem; pageNumber: number }[];
}

export interface ProcessingWorkerStartMessage {
	type: "start";
	jobId: number;
	fileBuffer: ArrayBuffer;
	targetPage: number;
	sourceVersionId: string;
	numAmendColors: number;
	windowRadius: number;
}

export type ProcessingWorkerRequest = ProcessingWorkerStartMessage;

export interface ProcessingWorkerLayoutsMessage {
	type: "layouts";
	jobId: number;
	layouts: PageLayout[];
}

export interface ProcessingWorkerWindowItemsMessage {
	type: "windowItems";
	jobId: number;
	payload: WorkerPageItemsPayload;
}

export interface ProcessingWorkerAllItemsMessage {
	type: "allItems";
	jobId: number;
	payload: WorkerPageItemsPayload;
}

export interface ProcessingWorkerErrorMessage {
	type: "error";
	jobId: number;
	error: string;
}

export type ProcessingWorkerResponse =
	| ProcessingWorkerLayoutsMessage
	| ProcessingWorkerWindowItemsMessage
	| ProcessingWorkerAllItemsMessage
	| ProcessingWorkerErrorMessage;
