# ultrapilot

An abstraction layer for LLM assistants. Provider-agnostic core, framework adapters, and storage backends.

## Packages

| Package | Description |
| --- | --- |
| `@ultrapilot/core` | Assistant runtime, context window, provider interface, storage interface |
| `@ultrapilot/next` | Next.js route handlers |
| `@ultrapilot/react` | React hooks (`useAssistantThread`, `useThreadList`) |
| `@ultrapilot/ui` | Headless React UI components |
| `@ultrapilot/storage-sqlite` | SQLite/libSQL storage adapter |
| `@ultrapilot/runtime` | Stable app-facing runtime facade — selects the active provider and returns it as a `ModelAdapter` |
| `@ultrapilot/provider-mastra` | Internal Mastra-backed provider implementation (the only package that depends on `@mastra/*`) |

Bring your own model: implement the `ModelAdapter` interface from `@ultrapilot/core/provider` against whatever you use (Mastra, AI SDK, direct SDK, Bedrock, etc.).

## Application boundary

Applications integrate **only** the stable packages (`@ultrapilot/core`, `@ultrapilot/next`, `@ultrapilot/react`, `@ultrapilot/runtime`, `@ultrapilot/storage-sqlite`, `@ultrapilot/ui`). Provider/framework-specific implementations live **behind** the runtime facade:

- `@ultrapilot/runtime` exposes `createConfiguredUltraPilotProvider(input): ModelAdapter`. App code calls this and never imports a provider package or names the active framework.
- `@ultrapilot/provider-mastra` is internal. App code must not import it; the runtime selects it. It is the only workspace package allowed to depend on `@mastra/*`.
- One-shot generation (`generateText` / `generateObject` / `generateMultimodal`) and the chat assistant (`createUltraPilot`) both ride the same `ModelAdapter` seam, so swapping providers never touches app code.

In the OpenCut / DirectorsCut fork this boundary is enforced by a permanent static test (`apps/web/src/lib/ultrapilot/static-boundary.test.ts`) that fails CI if web/desktop app code imports Mastra or any direct provider transport.

## Install (workspace)

```bash
bun install
bun test
```

## Consume from another repo (git-only)

Add as a submodule and include in your workspace globs:

```bash
git submodule add git@github.com:danduma/ultrapilot.git external/ultrapilot
```

Then in your root `package.json`:

```json
{
  "workspaces": ["apps/*", "packages/*", "external/ultrapilot/packages/*"]
}
```
