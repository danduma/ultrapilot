import { describe, expect, it } from "bun:test";
import * as providerMastra from "../index";

describe("@ultrapilot/provider-mastra package", () => {
	it("loads its public entrypoint", () => {
		expect(providerMastra).toBeDefined();
	});
});
