// @ultrapilot/runtime — stable, app-facing runtime facade.
//
// Application (web/desktop) code imports THIS package, never
// @ultrapilot/provider-mastra. The active provider implementation is selected
// internally (Mastra-backed today) and returned as a @ultrapilot/core
// `ModelAdapter`, so no provider/framework name ever crosses into app code.
// This indirection is what the static boundary test enforces and what makes the
// provider swappable.

export {
	createConfiguredUltraPilotProvider,
	type ConfiguredProviderInput,
} from "./default-provider";

// Framework-agnostic provider DTOs are re-exported through the facade so app
// code types its provider profile via @ultrapilot/runtime, never importing the
// provider package directly. (Type-only: erased at runtime, so the facade's
// runtime export surface still names no provider framework.)
export type {
	UltraPilotProviderKind,
	UltraPilotProviderProfile,
} from "@ultrapilot/provider-mastra";
