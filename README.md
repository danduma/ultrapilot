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
| `@ultrapilot/provider-google` | Google Gemini `ModelAdapter` via token.js |
| `@ultrapilot/provider-openai` | OpenAI `ModelAdapter` via token.js |

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
