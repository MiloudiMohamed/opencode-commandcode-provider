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

function parseModelEntries(source: string): ModelEntry[] {
  // 1. Extract yI (direct provider costs)
  const yIAnchor = 'id:"anthropic:claude-sonnet-5"'
  const yIAnchorIdx = source.indexOf(yIAnchor)
  if (yIAnchorIdx < 0) throw new Error("Could not find yI anchor in CLI bundle")

  const varIdx = source.lastIndexOf("var cI=", yIAnchorIdx)
  const eqIdx = source.indexOf("yI=", varIdx)
  const varsDecl = source.slice(varIdx, eqIdx).replace(/,\s*$/, ";")
  const objectStart = source.indexOf("{", eqIdx)

  let yIEnd = objectStart
  let depth = 0
  for (; yIEnd < source.length; yIEnd++) {
    if (source[yIEnd] === "{") depth++
    else if (source[yIEnd] === "}") {
      depth--
      if (depth === 0) break
    }
  }
  const yIObjectCode = source.slice(objectStart, yIEnd + 1)
  const fnCosts = new Function(`${varsDecl} return (${yIObjectCode});`)
  const costsObj = fnCosts()

  const costMap = new Map<string, { input: number; output: number; cache_read?: number; cache_write?: number }>()
  for (const arr of Object.values(costsObj) as any[]) {
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

  // 2. Extract bI and EI (gateway costs)
  const bIAnchorIdx = source.indexOf('bI=[{canonicalId:"zai-org/GLM-5"')
  if (bIAnchorIdx >= 0) {
    const startBracket = source.indexOf("[", bIAnchorIdx)
    let endBracket = startBracket
    depth = 0
    for (; endBracket < source.length; endBracket++) {
      if (source[endBracket] === "[") depth++
      else if (source[endBracket] === "]") {
        depth--
        if (depth === 0) break
      }
    }
    const bICode = source.slice(startBracket, endBracket + 1).replace(/!0/g, "true").replace(/!1/g, "false")
    const bIArray = new Function(`var kI="MiniMaxAI/MiniMax-M3-Free"; return (${bICode});`)()

    const EIVarIdx = source.indexOf("EI=[", endBracket)
    let EIArray: any[] = []
    if (EIVarIdx >= 0) {
      const EIStartBracket = source.indexOf("[", EIVarIdx)
      let EIEndBracket = EIStartBracket
      depth = 0
      for (; EIEndBracket < source.length; EIEndBracket++) {
        if (source[EIEndBracket] === "[") depth++
        else if (source[EIEndBracket] === "]") {
          depth--
          if (depth === 0) break
        }
      }
      const EICode = source.slice(EIStartBracket, EIEndBracket + 1).replace(/!0/g, "true").replace(/!1/g, "false")
      EIArray = new Function(`var kI="MiniMaxAI/MiniMax-M3-Free"; return (${EICode});`)()
    }

    const gatewayEntries = [...bIArray, ...EIArray]
    for (const g of gatewayEntries) {
      const firstProvName = g.order && g.order[0] ? g.order[0] : Object.keys(g.providers)[0]
      const prov = g.providers[firstProvName] || Object.values(g.providers)[0]
      if (prov) {
        costMap.set(g.canonicalId, {
          input: prov.promptCost,
          output: prov.completionCost,
          ...(prov.cacheReadCost > 0 && { cache_read: prov.cacheReadCost }),
          ...(prov.cacheWriteCost > 0 && { cache_write: prov.cacheWriteCost }),
        })
      }
    }
  }

  // 3. Extract Models Catalog
  const catAnchor = 'SONNET_4_6:{id:"claude-sonnet-4-6"'
  const catAnchorIdx = source.indexOf(catAnchor)
  if (catAnchorIdx < 0) throw new Error("Could not find model catalog anchor")

  let catStart = catAnchorIdx
  depth = 0
  for (; catStart >= 0; catStart--) {
    if (source[catStart] === "}") depth++
    else if (source[catStart] === "{") {
      if (depth === 0) break
      depth--
    }
  }

  let catEnd = catStart
  depth = 0;
  for (; catEnd < source.length; catEnd++) {
    if (source[catEnd] === "{") depth++
    else if (source[catEnd] === "}") {
      depth--
      if (depth === 0) break
    }
  }

  const catObjectCode = source.slice(catStart, catEnd + 1).replace(/!0/g, "true").replace(/!1/g, "false")
  const specVars = 'var SI="chatComplete",wI="responses",kI="MiniMaxAI/MiniMax-M3-Free";'
  const helperStubs = "function isLingFlashFreeEnded(){ return false; }"

  const fnModels = new Function(`${varsDecl} ${specVars} ${helperStubs} return (${catObjectCode});`)
  const modelsMap = fnModels()

  const entries: ModelEntry[] = []

  for (const [, m] of Object.entries(modelsMap) as [string, any][]) {
    const tier = m.provider === "anthropic" || m.provider === "openai" ? "premium" : "open-source"
    const cost = costMap.get(m.id) || { input: 0, output: 0 }
    const contextLimit = m.contextWindow || 200000
    const outputLimit = m.maxOutputTokens || 65536

    entries.push({
      id: m.id,
      name: m.name,
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
