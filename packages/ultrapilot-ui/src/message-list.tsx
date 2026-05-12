import type { AssistantMessage } from "@ultrapilot/core/types";

function getPartKey(
	messageId: string,
	index: number,
	part: AssistantMessage["parts"][number],
) {
	if (part.type === "tool-call" || part.type === "tool-result") {
		return `${messageId}:${part.type}:${part.toolCallId}`;
	}

	if (part.type === "text" || part.type === "reasoning") {
		return `${messageId}:${part.type}:${part.text.slice(0, 24)}:${index}`;
	}

	return `${messageId}:${index}`;
}

export function MessageList({ messages }: { messages: AssistantMessage[] }) {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
			{messages.map((message) => (
				<div
					key={message.id}
					style={{
						alignSelf: message.role === "user" ? "flex-end" : "stretch",
						background: message.role === "user" ? "#111827" : "#f3f4f6",
						color: message.role === "user" ? "#fff" : "#111827",
						borderRadius: 12,
						padding: 12,
					}}
				>
					{message.parts.map((part, index) => (
						<div
							key={getPartKey(message.id, index, part)}
							style={{ whiteSpace: "pre-wrap" }}
						>
							{part.type === "text" || part.type === "reasoning"
								? part.text
								: part.type === "tool-call"
									? `Tool call: ${part.toolName} ${JSON.stringify(part.args)}`
									: `Tool result: ${part.toolName} ${JSON.stringify(part.result)}`}
						</div>
					))}
				</div>
			))}
		</div>
	);
}
