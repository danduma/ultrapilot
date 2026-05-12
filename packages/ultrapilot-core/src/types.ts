export type AssistantRole = "system" | "user" | "assistant" | "tool";

/**
 * Per-part provider metadata. Used to carry data the model wire format
 * requires us to round-trip verbatim across replays — e.g. Gemini's
 * `thoughtSignature`, which must accompany every tool-call sent back as
 * history or the API rejects the request.
 *
 * Shape mirrors AI SDK / Mastra: { providerId: { fieldName: value, ... } }.
 */
export type PartProviderOptions = Record<string, Record<string, unknown>>;

export type TextPart = {
	type: "text";
	text: string;
	providerOptions?: PartProviderOptions;
};

export type ReasoningPart = {
	type: "reasoning";
	text: string;
	providerOptions?: PartProviderOptions;
};

export type ToolCallPart = {
	type: "tool-call";
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	providerOptions?: PartProviderOptions;
};

export type ToolResultPart = {
	type: "tool-result";
	toolCallId: string;
	toolName: string;
	result: unknown;
	isError: boolean;
};

export type AssistantMessagePart =
	| TextPart
	| ReasoningPart
	| ToolCallPart
	| ToolResultPart;

export type AssistantMessage = {
	id: string;
	threadId: string;
	branchId: string;
	role: AssistantRole;
	createdAt: string;
	parts: AssistantMessagePart[];
	metadata: Record<string, unknown>;
};

export type AssistantThread = {
	id: string;
	title: string | null;
	createdAt: string;
	updatedAt: string;
	activeBranchId: string | null;
	metadata: Record<string, unknown>;
};

export type AssistantBranch = {
	id: string;
	threadId: string;
	name: string;
	parentBranchId: string | null;
	sourceMessageId: string | null;
	createdAt: string;
	updatedAt: string;
};

export type AssistantRunStatus =
	| "idle"
	| "running"
	| "retrying"
	| "completed"
	| "failed";

export type AssistantRun = {
	id: string;
	threadId: string;
	branchId: string;
	status: AssistantRunStatus;
	attemptCount: number;
	errorMessage?: string;
	createdAt: string;
	updatedAt: string;
	metadata: Record<string, unknown>;
};

export type AssistantCheckpoint = {
	id: string;
	threadId: string;
	branchId: string;
	messageId: string;
	summary: string;
	createdAt: string;
	metadata: Record<string, unknown>;
};

export type AssistantEventType =
	| "run.started"
	| "run.retrying"
	| "run.completed"
	| "run.failed"
	| "message.created"
	| "tool.called"
	| "tool.completed";

export type AssistantEvent = {
	id: string;
	type: AssistantEventType;
	timestamp: number;
	data: Record<string, unknown>;
};

export type AssistantToolCall = {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
};

export type AssistantToolSchema = {
	type: string;
	properties?: Record<string, unknown>;
	required?: string[];
	[key: string]: unknown;
};

export type AssistantToolDefinition = {
	description: string;
	inputSchema: AssistantToolSchema;
	execute?: (args: Record<string, unknown>) => Promise<unknown> | unknown;
};
