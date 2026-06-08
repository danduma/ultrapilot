import { describe, expect, it } from "bun:test";
import * as runtime from "../index";

describe("@ultrapilot/runtime facade", () => {
	it("exposes a configured-provider factory", () => {
		expect(typeof runtime.createConfiguredUltraPilotProvider).toBe("function");
	});

	it("does not name a provider framework in its public export surface", () => {
		for (const key of Object.keys(runtime)) {
			expect(key.toLowerCase().includes("mastra")).toBe(false);
		}
	});
});
