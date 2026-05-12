export async function editAndRegenerateFromMessage<T>({
	messageId,
	text,
	truncateBranch,
	replaceMessageAndGenerate,
}: {
	messageId: string;
	text: string;
	truncateBranch: (messageId: string) => Promise<unknown>;
	replaceMessageAndGenerate: (messageId: string, text: string) => Promise<T>;
}) {
	await truncateBranch(messageId);
	return replaceMessageAndGenerate(messageId, text);
}

export async function rerunFromMessage<T>({
	messageId,
	truncateBranch,
	regenerate,
}: {
	messageId: string;
	truncateBranch: (messageId: string) => Promise<unknown>;
	regenerate: () => Promise<T>;
}) {
	await truncateBranch(messageId);
	return regenerate();
}
