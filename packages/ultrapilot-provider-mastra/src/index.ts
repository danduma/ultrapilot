// @ultrapilot/provider-mastra — internal UltraPilot provider package.
//
// This is the ONLY workspace package allowed to depend on @mastra/*. Application
// code must NEVER import this package directly; it is selected behind
// @ultrapilot/runtime and returned as a @ultrapilot/core `ModelAdapter`, so the
// provider/framework is never named in app code.
//
// Behavior is ported in Tasks 3-6 (profile mapping, message codec, Gemini
// signature guard, Mastra runtime + tool routing).

export * from "./mastra-runtime";
export * from "./message-codec";
export * from "./gemini-signature-guard";
export * from "./tool-routing";
export * from "./tool-conversion";
export * from "./retryable-error";
