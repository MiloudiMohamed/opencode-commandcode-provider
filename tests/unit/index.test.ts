import { expect, test, beforeAll, afterAll } from "bun:test"
import { createCommandCode } from "../../index.js"

let originalEnv: Record<string, string | undefined> = {}
beforeAll(() => {
  originalEnv.COMMANDCODE_API_KEY = process.env.COMMANDCODE_API_KEY
  delete process.env.COMMANDCODE_API_KEY
})
afterAll(() => {
  if (originalEnv.COMMANDCODE_API_KEY) process.env.COMMANDCODE_API_KEY = originalEnv.COMMANDCODE_API_KEY
})

test("throws when no API key is available", () => {
  expect(() => createCommandCode({ authPaths: [] })).toThrow("Command Code API key not found")
})

test("throws with descriptive message listing all options", () => {
  try {
    createCommandCode({ authPaths: [] })
    expect.unreachable("Should have thrown")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    expect(msg).toContain("COMMANDCODE_API_KEY")
    expect(msg).toContain("auth.json")
    expect(msg).toContain("apiKey")
  }
})

test("returns provider with languageModel when apiKey is provided", () => {
  const provider = createCommandCode({ apiKey: "sk-test" })
  expect(provider.languageModel).toBeDefined()
  expect(typeof provider.languageModel).toBe("function")
})

test("languageModel returns a model with correct provider and modelId", () => {
  const provider = createCommandCode({ apiKey: "sk-test" })
  const model = provider.languageModel("gpt-5.5")
  expect(model.provider).toBe("commandcode")
  expect(model.modelId).toBe("gpt-5.5")
  expect(model.specificationVersion).toBe("v3")
})

test("resolves API key from env var", () => {
  process.env.COMMANDCODE_API_KEY = "sk-from-env"
  const provider = createCommandCode()
  const model = provider.languageModel("test")
  expect(model).toBeDefined()
  delete process.env.COMMANDCODE_API_KEY
})

test("explicit apiKey takes priority over env var", () => {
  process.env.COMMANDCODE_API_KEY = "sk-from-env"
  const provider = createCommandCode({ apiKey: "sk-explicit" })
  const model = provider.languageModel("test")
  expect(model).toBeDefined()
  delete process.env.COMMANDCODE_API_KEY
})

test("each languageModel call returns a new instance", () => {
  const provider = createCommandCode({ apiKey: "sk-test" })
  const m1 = provider.languageModel("a")
  const m2 = provider.languageModel("b")
  expect(m1).not.toBe(m2)
  expect(m1.modelId).toBe("a")
  expect(m2.modelId).toBe("b")
})
