import { resolveApiKey } from "./src/auth.js"
import { CommandCodeLanguageModel } from "./src/model.js"

export interface CommandCodeProviderOptions {
  name?: string
  apiKey?: string
  baseURL?: string
  headers?: Record<string, string>
  ccVersion?: string
}

export function createCommandCode(options: CommandCodeProviderOptions = {}) {
  const apiKey = resolveApiKey({ apiKey: options.apiKey })
  if (!apiKey) {
    throw new Error(
      "Command Code API key not found. Set COMMANDCODE_API_KEY env var, create ~/.commandcode/auth.json, or pass apiKey option.",
    )
  }

  return {
    languageModel(modelId: string): CommandCodeLanguageModel {
      return new CommandCodeLanguageModel(modelId, {
        apiKey,
        baseURL: typeof options.baseURL === "string" ? options.baseURL : undefined,
        headers: typeof options.headers === "object" && options.headers !== null ? options.headers as Record<string, string> : undefined,
        ccVersion: options.ccVersion,
      })
    },
  }
}
