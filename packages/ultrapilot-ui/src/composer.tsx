import { useState } from "react";

export function Composer({
	onSend,
	disabled,
}: {
	onSend: (text: string) => Promise<unknown> | unknown;
	disabled?: boolean;
}) {
	const [value, setValue] = useState("");
	return (
		<form
			onSubmit={async (event) => {
				event.preventDefault();
				if (!value.trim()) {
					return;
				}
				await onSend(value);
				setValue("");
			}}
			style={{ display: "flex", gap: 8 }}
		>
			<textarea
				value={value}
				onChange={(event) => setValue(event.target.value)}
				disabled={disabled}
				rows={4}
				style={{ flex: 1, borderRadius: 10, padding: 12 }}
			/>
			<button type="submit" disabled={disabled} style={{ padding: "0 16px" }}>
				Send
			</button>
		</form>
	);
}
