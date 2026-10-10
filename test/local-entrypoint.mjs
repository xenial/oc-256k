import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { Host } from "@opencode/plugin/host"

const directory = fileURLToPath(new URL("../", import.meta.url))
const entrypoints = Host.resolve({ directory })
assert.ok(entrypoints.server, "OpenCode must resolve a local directory's server entrypoint")
const loaded = await Host.load(entrypoints.server)
assert.equal(loaded.default.id, "oc-256k")
assert.equal(typeof loaded.default.setup, "function")
console.log("OpenCode's Bun host resolves and loads the local plugin directory")
