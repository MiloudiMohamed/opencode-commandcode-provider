import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "fs"
import { join, dirname } from "path"
import { homedir } from "os"
import { execSync } from "child_process"
import { fileURLToPath } from "url"

const __dirname = typeof import.meta.dir === "string"
  ? import.meta.dir
  : dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, "..")
const MODELS_JSON = join(PROJECT_ROOT, "models.json")
const GLOBAL_CONFIG = join(homedir(), ".config", "opencode", "opencode.jsonc")
const NPM_PACKAGE = "command-code"
const TMP_DIR = join("/tmp", "cc-model-sync")

interface ModelEntry {
  id: string
  name: string
  tier: "premium" | "open-source"
  reasoning: boolean
  tool_call: boolean
  cost: { input: number; output: number; cache_read?: number; cache_write?: number }
  limit: { context: number; output: number }
}

async function fetchLatestBundle(): Promise<{ source: string; version: string }> {
  console.log(`Fetching latest ${NPM_PACKAGE} metadata...`)
  const metaResp = await fetch(`https://registry.npmjs.org/${NPM_PACKAGE}/latest`)
  if (!metaResp.ok) throw new Error(`npm registry returned ${metaResp.status}`)
  const meta = await metaResp.json()
  const version = meta.version as string
  const tarball = meta.dist.tarball as string
  console.log(`  Latest version: ${version}`)
  console.log(`  Tarball: ${tarball}`)

  mkdirSync(TMP_DIR, { recursive: true })
  const tgzPath = join(TMP_DIR, `${NPM_PACKAGE}.tgz`)

  console.log("Downloading tarball...")
  const tarballResp = await fetch(tarball)
  if (!tarballResp.ok) throw new Error(`tarball download returned ${tarballResp.status}`)
  const buffer = Buffer.from(await tarballResp.arrayBuffer())
  writeFileSync(tgzPath, buffer)

  console.log("Extracting...")
  execSync(`tar -xzf "${tgzPath}" -C "${TMP_DIR}"`, { stdio: "pipe" })

  const cliPath = join(TMP_DIR, "package", "dist", "cli.mjs")
  const indexPath = join(TMP_DIR, "package", "dist", "index.mjs")

  let bundlePath = existsSync(cliPath) ? cliPath : indexPath
  if (!existsSync(bundlePath)) throw new Error(`Bundle not found at ${cliPath} or ${indexPath}`)

  const source = readFileSync(bundlePath, "utf-8")
  rmSync(TMP_DIR, { recursive: true, force: true })

  return { source, version }
}

function normalizeBundleCode(code: string): string {
  return code
    .replace(/!0/g, "true")
    .replace(/!1/g, "false")
    .replace(/(\d+)e(\d+)/g, (_match: string, mantissa: string, exponent: string) =>
      String(Number(mantissa) * Math.pow(10, Number(exponent))))
}

function findBalanced(source: string, start: number, open: string, close: string): string {
  let depth = 0
  let quote: string | undefined
  let escaped = false

  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (quote) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }

  throw new Error(`Unbalanced ${open}${close} expression in CLI bundle`)
}

function lastMatch(source: string, pattern: RegExp): RegExpExecArray | undefined {
  pattern.lastIndex = 0
  let result: RegExpExecArray | undefined
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    result = match
  }
  return result
}

function extractStringBindings(source: string): Record<string, unknown> {
  const bindings: Record<string, unknown> = {}
  const strings = /\b([A-Za-z_$][\w$]*)\s*=\s*"([^"]*)"/g
  let match: RegExpExecArray | null
  while ((match = strings.exec(source)) !== null) {
    bindings[match[1]] = match[2]
  }

  const aliases = /\b([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)/g
  for (let pass = 0; pass < 3; pass++) {
    aliases.lastIndex = 0
    while ((match = aliases.exec(source)) !== null) {
      const value = bindings[match[2]]
      if (value !== undefined) bindings[match[1]] = value
    }
  }
  return bindings
}

function evaluateBundleExpression(code: string, bindings: Record<string, unknown>): any {
  const reserved = new Set([
    "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete",
    "do", "else", "enum", "export", "extends", "false", "finally", "for", "function", "if", "implements",
    "import", "in", "instanceof", "interface", "let", "new", "null", "package", "private", "protected",
    "public", "return", "static", "super", "switch", "this", "throw", "true", "try", "typeof", "var",
    "void", "while", "with", "yield", "arguments", "eval",
  ])
  const referenced = new Set(normalizeBundleCode(code).match(/[A-Za-z_$][\w$]*/g) ?? [])
  const keys = Object.keys(bindings).filter((key) => referenced.has(key) && !reserved.has(key))
  return Function(...keys, `"use strict"; return (${normalizeBundleCode(code)})`)(...keys.map((key) => bindings[key]))
}

function parseModelEntries(source: string): ModelEntry[] {
  const modelAnchor = 'SONNET_4_6:{id:"claude-sonnet-4-6"'
  const modelAnchorIdx = source.indexOf(modelAnchor)
  if (modelAnchorIdx < 0) throw new Error("Could not find model catalog anchor")

  // The minifier renames these variables between releases. Identify the
  // structures by their contents instead of depending on generated names.
  const directCostMatch = lastMatch(
    source.slice(0, modelAnchorIdx),
    /([A-Za-z_$][\w$]*)=\{\[/g,
  )
  if (!directCostMatch) throw new Error("Could not find direct model cost catalog")

  const directCostStart = source.indexOf("{", directCostMatch.index)
  const directCostCode = findBalanced(source, directCostStart, "{", "}")
  const directBindings = extractStringBindings(source.slice(0, directCostStart))
  const directCosts = evaluateBundleExpression(directCostCode, directBindings)

  const costMap = new Map<string, { input: number; output: number; cache_read?: number; cache_write?: number }>()
  for (const arr of Object.values(directCosts) as any[]) {
    for (const entry of arr) {
      const colonIdx = entry.id.indexOf(":")
      const bareId = colonIdx >= 0 ? entry.id.slice(colonIdx + 1) : entry.id
      costMap.set(bareId, {
        input: entry.promptCost,
        output: entry.completionCost,
        ...(entry.cacheHitCost > 0 && { cache_read: entry.cacheHitCost }),
        ...(entry.cacheWrite5mCost > 0 && { cache_write: entry.cacheWrite5mCost }),
      })
    }
  }

  const gatewayPattern = /[A-Za-z_$][\w$]*=\[\{canonicalId:"[^"]+",(?:gatewaySlug|openrouterSlug|slug):/g
  const gatewayRegion = source.slice(directCostStart)
  let gatewayMatch: RegExpExecArray | null
  const gatewayArrays: any[] = []
  while ((gatewayMatch = gatewayPattern.exec(gatewayRegion)) !== null) {
    const arrayStart = directCostStart + gatewayMatch.index + gatewayMatch[0].indexOf("[")
    const arrayCode = findBalanced(source, arrayStart, "[", "]")
    const bindings = extractStringBindings(source.slice(0, arrayStart))

    for (const name of arrayCode.match(/(?:effectiveFrom|peakWindowsUtc|canonicalId):([A-Za-z_$][\w$]*)/g) ?? []) {
      const variable = name.slice(name.indexOf(":") + 1)
      if (bindings[variable] === undefined) bindings[variable] = variable === "peakWindowsUtc" ? [] : ""
    }

    gatewayArrays.push(evaluateBundleExpression(arrayCode, bindings))
  }

  for (const gatewayEntries of gatewayArrays) {
    for (const entry of gatewayEntries) {
      if (entry.promptCost !== undefined) {
        costMap.set(entry.canonicalId, {
          input: entry.promptCost,
          output: entry.completionCost,
          ...(entry.cacheReadCost > 0 && { cache_read: entry.cacheReadCost }),
          ...(entry.cacheWriteCost > 0 && { cache_write: entry.cacheWriteCost }),
          ...(entry.cacheWrite5mCost > 0 && { cache_write: entry.cacheWrite5mCost }),
        })
      } else {
        const firstProvider = entry.order?.[0]
        const provider = (firstProvider && entry.providers?.[firstProvider]) || Object.values(entry.providers ?? {})[0] as any
        if (provider && typeof provider === "object") {
          costMap.set(entry.canonicalId, {
            input: provider.promptCost,
            output: provider.completionCost,
            ...(provider.cacheReadCost > 0 && { cache_read: provider.cacheReadCost }),
            ...(provider.cacheWriteCost > 0 && { cache_write: provider.cacheWriteCost }),
            ...(provider.cacheWrite5mCost > 0 && { cache_write: provider.cacheWrite5mCost }),
          })
        }
      }
    }
  }

  let modelStart = modelAnchorIdx
  let depth = 0
  for (; modelStart >= 0; modelStart--) {
    if (source[modelStart] === "}") depth++
    else if (source[modelStart] === "{") {
      if (depth === 0) break
      depth--
    }
  }

  const modelCode = findBalanced(source, modelStart, "{", "}")
  const modelBindings = extractStringBindings(source.slice(0, modelStart))
  modelBindings.isLingFlashFreeEnded = () => false
  const modelsMap = evaluateBundleExpression(modelCode, modelBindings)

  const entries: ModelEntry[] = []

  for (const [, m] of Object.entries(modelsMap) as [string, any][]) {
    const tier = m.provider === "anthropic" || m.provider === "openai" || m.vendorLabel === "OpenAI"
      ? "premium"
      : "open-source"
    const cost = costMap.get(m.id)
    if (!cost) throw new Error(`Missing pricing data for model ${m.id}`)
    const contextLimit = m.contextWindow || 200000
    const outputLimit = m.maxOutputTokens || 65536

    entries.push({
      id: m.id,
      name: m.id.toLowerCase().endsWith("-free") && !m.name.includes("Free")
        ? `${m.name} (Free)`
        : m.name,
      tier,
      reasoning: Boolean(m.reasoning || (m.reasoningEfforts && m.reasoningEfforts.length > 0)),
      tool_call: true,
      cost,
      limit: { context: contextLimit, output: outputLimit },
    })
  }

  entries.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === "premium" ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return entries
}

function toConfigKey(id: string): string {
  const slashIdx = id.indexOf("/")
  const short = slashIdx >= 0 ? id.slice(slashIdx + 1) : id
  return short.toLowerCase()
}

function generateOpencodeModels(entries: ModelEntry[]): Record<string, unknown> {
  const models: Record<string, unknown> = {}
  for (const entry of entries) {
    const key = toConfigKey(entry.id)
    const costObj: Record<string, number> = { input: entry.cost.input, output: entry.cost.output }
    if (entry.cost.cache_read !== undefined) costObj.cache_read = entry.cost.cache_read
    if (entry.cost.cache_write !== undefined) costObj.cache_write = entry.cost.cache_write

    models[key] = {
      id: entry.id,
      name: entry.name,
      reasoning: entry.reasoning,
      tool_call: entry.tool_call,
      cost: costObj,
      limit: entry.limit,
    }
  }
  return models
}

function stripJsonc(input: string): string {
  let out = ""
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (ch === '"') {
      const start = i
      i++
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\") i++
        i++
      }
      i++
      out += input.slice(start, i)
    } else if (ch === "/" && input[i + 1] === "/") {
      while (i < input.length && input[i] !== "\n") i++
    } else if (ch === "/" && input[i + 1] === "*") {
      i += 2
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++
      i += 2
    } else {
      out += ch
      i++
    }
  }
  return out.replace(/,\s*([}\]])/g, "$1")
}

function updateGlobalConfig(modelsObj: Record<string, unknown>) {
  if (!existsSync(GLOBAL_CONFIG)) {
    console.log(`  Global config not found at ${GLOBAL_CONFIG}, skipping`)
    return
  }

  const raw = readFileSync(GLOBAL_CONFIG, "utf-8")
  const jsonStr = stripJsonc(raw)

  let config: any
  try {
    config = JSON.parse(jsonStr)
  } catch {
    console.error("  Failed to parse global config as JSON after stripping comments")
    return
  }

  if (!config.provider) config.provider = {}
  if (!config.provider.commandcode) {
    config.provider.commandcode = {
      npm: "commandcode-go-opencode-provider",
      name: "Command Code",
      env: ["COMMANDCODE_API_KEY"],
    }
  }
  config.provider.commandcode.models = modelsObj

  const output = JSON.stringify(config, null, 2) + "\n"
  writeFileSync(GLOBAL_CONFIG, output, "utf-8")
  console.log(`  Updated ${GLOBAL_CONFIG}`)
}

async function main() {
  const args = process.argv.slice(2)
  const shouldUpdateGlobal = args.includes("--update-global")

  const { source, version } = await fetchLatestBundle()
  console.log(`Read CLI bundle v${version} (${(source.length / 1024).toFixed(0)} KB)`)

  console.log("Parsing model entries and pricing...")
  const entries = parseModelEntries(source)
  console.log(`  Found ${entries.length} models`)

  console.log(`\nWriting ${MODELS_JSON} with ${entries.length} models...`)
  writeFileSync(MODELS_JSON, JSON.stringify(entries, null, 2) + "\n", "utf-8")

  const versionPath = join(PROJECT_ROOT, "version.json")
  writeFileSync(versionPath, JSON.stringify({ version, updatedAt: new Date().toISOString() }, null, 2) + "\n", "utf-8")
  console.log(`Writing ${versionPath} (version ${version})...`)

  const modelsObj = generateOpencodeModels(entries)

  if (shouldUpdateGlobal) {
    console.log("Updating global config...")
    updateGlobalConfig(modelsObj)
  }

  console.log("\nModel list:")
  for (const entry of entries) {
    const cost = `$${entry.cost.input}/$${entry.cost.output}`
    console.log(`  ${entry.tier.padEnd(12)} ${entry.id.padEnd(38)} ${entry.name.padEnd(25)} ${cost}`)
  }

  if (!shouldUpdateGlobal) {
    console.log(`\nRun with --update-global to update ${GLOBAL_CONFIG}`)
  }

  console.log("\nDone.")
}

main()
