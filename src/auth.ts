import { readFileSync, existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"

export function resolveApiKey(options: {
  apiKey?: string
  env?: Record<string, string | undefined>
  authPaths?: string[]
}): string | undefined {
  if (options.apiKey) return options.apiKey

  const envKey = options.env?.COMMANDCODE_API_KEY ?? process.env.COMMANDCODE_API_KEY
  if (envKey) return envKey

  const authPaths = options.authPaths ?? [
    join(homedir(), ".commandcode", "auth.json"),
    join(homedir(), ".pi", "agent", "auth.json"),
  ]

  for (const p of authPaths) {
    if (!existsSync(p)) continue
    try {
      const parsed = JSON.parse(readFileSync(p, "utf-8"))
      if (typeof parsed === "object" && parsed !== null) {
        if (typeof parsed.apiKey === "string") return parsed.apiKey
        if (typeof parsed.commandcode === "string") return parsed.commandcode
        if (
          typeof parsed.commandcode === "object" &&
          parsed.commandcode !== null &&
          parsed.commandcode.type === "oauth" &&
          typeof parsed.commandcode.access === "string"
        ) {
          return parsed.commandcode.access
        }
      }
    } catch {
      // intentionally silent: skip unreadable or malformed auth files
      continue
    }
  }

  return undefined
}
