import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import test from "node:test"
import { Sub2apiPlugin, Sub2apiSite1 } from "../index.mjs"

const BASE = "https://gemini-probe.example.com/gateway"
const IDS = ["gemini-3.8-flash-high", "gemini-4-argon-high"]
const GEMINI = "@ai-sdk/google"
const CHAT = "@ai-sdk/openai-compatible"
const auth = (key = "synthetic-probe-key", metadata = {}) => ({ type: "api", key, metadata: { baseURL: BASE, ...metadata } })
const catalog = (ids = IDS) => ({ data: ids.map((id) => ({ id })) })
const nativeCatalog = (ids = IDS) => ({ models: ids.map((id) => ({ name: "models/" + id, supportedGenerationMethods: ["generateContent"] })) })
const platformError = () => Response.json({ error: { code: 400, message: "API key group platform is not gemini", status: "INVALID_ARGUMENT" } }, { status: 400 })

function mockProbe(t, native = () => Response.json(nativeCatalog()), ids = IDS) {
  const calls = []
  t.mock.method(globalThis, "fetch", async (input, init) => {
    if (init?.credentials === "omit") return new Response(null, { status: 404 })
    const url = new URL(input instanceof Request ? input.url : input)
    const call = { url: url.href, path: url.pathname, init, headers: new Headers(init?.headers) }
    calls.push(call)
    if (url.pathname === "/gateway/v1/models") return Response.json(catalog(ids))
    if (url.pathname === "/gateway/v1beta/models") return native(call)
    if (url.pathname.endsWith("/backend-api/codex/models")) return Response.json({ models: [] })
    return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] })
  })
  return calls
}

test("auto Gemini switches to Chat Completions after the key's native catalog rejects its group", async (t) => {
  const calls = mockProbe(t, platformError)
  const lines = []
  t.mock.method(console, "error", (line) => lines.push(line))
  const plugin = await Sub2apiPlugin({}, { diagnostics: true })
  const found = await plugin.provider.models({}, { auth: auth() })
  for (const id of IDS) {
    assert.equal(found[id].api.npm, CHAT)
    assert.equal(found[id].api.url, BASE + "/v1")
    assert.equal(found[id].api.id, id)
  }
  assert.equal(calls.length, 2)
  assert.ok(calls.every((call) => call.init.method === undefined || call.init.method === "GET"))
  assert.ok(calls.every((call) => call.init.body === undefined && call.init.redirect === "error"))
  assert.ok(calls.every((call) => call.headers.get("authorization") === "Bearer synthetic-probe-key"))
  assert.equal(calls[1].headers.get("x-goog-api-key"), "synthetic-probe-key")
  assert.ok(lines.some((line) => line.includes('"event":"protocol.selected"') && line.includes('"to":"chat-completions"')))
  assert.equal(lines.join("\n").includes(IDS[0]), false)
  assert.equal(lines.join("\n").includes("synthetic-probe-key"), false)
  const loader = await plugin.auth.loader(async () => auth())
  const body = JSON.stringify({ model: IDS[0], messages: [{ role: "user", content: "hi" }], stream: true })
  await loader.fetch(loader.baseURL + "/chat/completions", { method: "POST", body })
  assert.equal(calls.length, 3)
  assert.equal(calls[2].init.body, body)
  assert.equal(calls[2].headers.get("authorization"), "Bearer synthetic-probe-key")
})

test("native Gemini remains native and every account's probe is isolated and coalesced", async (t) => {
  const calls = mockProbe(t, (call) => call.headers.get("authorization") === "Bearer chat-key" ? platformError() : Response.json(nativeCatalog()))
  const plugin = await Sub2apiPlugin()
  const [native, chat, same] = await Promise.all([
    plugin.provider.models({}, { auth: auth("native-key") }),
    plugin.provider.models({}, { auth: auth("chat-key") }),
    plugin.provider.models({}, { auth: auth("chat-key") }),
  ])
  assert.equal(native[IDS[0]].api.npm, GEMINI)
  assert.equal(chat[IDS[0]].api.npm, CHAT)
  assert.equal(same[IDS[0]].api.npm, CHAT)
  assert.equal(calls.filter((call) => call.path.endsWith("/v1beta/models")).length, 2)
  await plugin.provider.models({}, { auth: auth("chat-key") })
  assert.equal(calls.length, 4)
})

test("missing Gemini metadata endpoints select chat but transient or ambiguous failures never guess", async (t) => {
  for (const [status, body, expected] of [
    [404, { error: { message: "Not found" } }, CHAT],
    [405, {}, CHAT],
    [501, {}, CHAT],
    [400, { error: { message: "API key group platform is not gemini" } }, CHAT],
    [400, { error: { message: "Invalid model parameter" } }, GEMINI],
    [401, { error: { message: "invalid API key" } }, GEMINI],
    [403, { error: { message: "permission denied" } }, GEMINI],
    [429, {}, GEMINI],
    [500, {}, GEMINI],
    [503, {}, GEMINI],
    [200, { models: [] }, GEMINI],
    [200, { data: IDS.map((id) => ({ id })) }, GEMINI],
  ]) {
    await t.test(String(status) + " " + expected, async (t) => {
      const calls = mockProbe(t, () => Response.json(body, { status }))
      const plugin = await Sub2apiPlugin()
      const found = await plugin.provider.models({}, { auth: auth() })
      assert.equal(found[IDS[0]].api.npm, expected)
      assert.equal(calls.length, 2)
      assert.ok(calls.every((call) => call.init.body === undefined))
    })
  }
})

test("protocol probes honor per-protocol headers and account precedence without credential overrides", async (t) => {
  const calls = mockProbe(t, (call) => {
    assert.equal(call.headers.get("x-probe"), "account")
    assert.equal(call.headers.get("x-native"), "native")
    assert.equal(call.headers.get("authorization"), "Bearer header-key")
    assert.equal(call.headers.get("x-goog-api-key"), "header-key")
    return platformError()
  })
  const plugin = await Sub2apiPlugin({}, { headers: { "X-Probe": "global" }, protocolHeaders: { gemini: { "X-Probe": "protocol", "X-Native": "native" } } })
  const found = await plugin.provider.models({}, { auth: auth("header-key", { headers: { "X-Probe": "account" } }) })
  assert.equal(found[IDS[0]].api.npm, CHAT)
  assert.equal(calls.length, 2)
})

test("explicit protocols and excluded Gemini models do not trigger auto probes", async (t) => {
  const calls = mockProbe(t, () => { assert.fail("explicit protocols must not be probed") })
  for (const options of [
    { protocol: "gemini" },
    { protocol: "chat-completions" },
    { modelProtocols: Object.fromEntries(IDS.map((id) => [id, "gemini"])) },
    { excludeModels: IDS },
    { includeModels: [] },
  ]) {
    const plugin = await Sub2apiPlugin({}, options)
    await plugin.provider.models({}, { auth: auth() })
  }
  assert.equal(calls.length, 5)
})

test("native probe results expire with model query TTL and changing account headers never reuses another scope", async (t) => {
  let now = 1000
  let native = false
  t.mock.method(Date, "now", () => now)
  const calls = mockProbe(t, () => native ? Response.json(nativeCatalog()) : platformError())
  const plugin = await Sub2apiPlugin({}, { query: { modelsTtlMs: 100 } })
  assert.equal((await plugin.provider.models({}, { auth: auth() }))[IDS[0]].api.npm, CHAT)
  native = true
  now += 99
  assert.equal((await plugin.provider.models({}, { auth: auth() }))[IDS[0]].api.npm, CHAT)
  now++
  assert.equal((await plugin.provider.models({}, { auth: auth() }))[IDS[0]].api.npm, GEMINI)
  assert.equal(calls.length, 4)
  await plugin.provider.models({}, { auth: auth("synthetic-probe-key", { headers: { "X-Group": "different" } }) })
  assert.equal(calls.length, 6)
})

test("custom Gemini paths probe the configured endpoint and never change explicit account routing", async (t) => {
  const calls = []
  t.mock.method(globalThis, "fetch", async (input, init) => {
    if (init?.credentials === "omit") return new Response(null, { status: 404 })
    const url = String(input)
    calls.push(url)
    if (url.endsWith("/v1/models")) return Response.json(catalog())
    assert.equal(url, BASE + "/antigravity/v1beta/models")
    return Response.json(nativeCatalog())
  })
  const plugin = await Sub2apiSite1({}, { sites: [{ id: "custom", url: BASE, apiPaths: { gemini: "/antigravity/v1beta" } }] })
  const found = await plugin.provider.models({}, { auth: auth() })
  assert.equal(found[IDS[0]].api.npm, GEMINI)
  assert.equal(found[IDS[0]].api.url, BASE + "/antigravity/v1beta")
  assert.equal(calls.length, 2)
})

test("protocol cache keys include native paths and final protocol headers", async (t) => {
  const calls = []
  t.mock.method(globalThis, "fetch", async (input, init) => {
    if (init?.credentials === "omit") return new Response(null, { status: 404 })
    const url = String(input)
    if (url.endsWith("/v1/models")) return Response.json(catalog())
    const headers = new Headers(init?.headers)
    calls.push({ url, group: headers.get("x-native-group") })
    return url.endsWith("/native/v1beta/models") || headers.get("x-native-group") === "native"
      ? Response.json(nativeCatalog()) : platformError()
  })
  const plugin = await Sub2apiPlugin()
  assert.equal((await plugin.provider.models({}, { auth: auth() }))[IDS[0]].api.npm, CHAT)
  assert.equal((await plugin.provider.models({}, { auth: auth("synthetic-probe-key", { apiPaths: { gemini: "/native/v1beta" } }) }))[IDS[0]].api.npm, GEMINI)
  assert.equal((await plugin.provider.models({}, { auth: auth("synthetic-probe-key", { protocolHeaders: { gemini: { "X-Native-Group": "native" } } }) }))[IDS[0]].api.npm, GEMINI)
  assert.equal((await plugin.provider.models({}, { auth: auth() }))[IDS[0]].api.npm, CHAT)
  assert.equal(calls.length, 3)
})

test("native metadata redirects are rejected without sending credentials to the new destination", async (t) => {
  const calls = []
  t.mock.method(globalThis, "fetch", async (input, init) => {
    if (init?.credentials === "omit") return new Response(null, { status: 404 })
    const url = String(input)
    calls.push(url)
    if (url.endsWith("/v1/models")) return Response.json(catalog())
    assert.equal(init.redirect, "error")
    return new Response(null, { status: 302, headers: { location: "https://outside.example.com/models" } })
  })
  const plugin = await Sub2apiPlugin()
  const found = await plugin.provider.models({}, { auth: auth() })
  assert.equal(found[IDS[0]].api.npm, GEMINI)
  assert.equal(calls.length, 2)
  assert.equal(calls.some((url) => url.includes("outside")), false)
})

test("network errors, invalid JSON and reflected credentials cannot cause protocol fallback or leak into logs", async (t) => {
  for (const mode of ["network", "json", "size", "stream"]) {
    await t.test(mode, async (t) => {
      const lines = []
      t.mock.method(console, "error", (line) => lines.push(line))
      mockProbe(t, () => {
        if (mode === "network") throw new Error("secret-upstream-error")
        if (mode === "json") return new Response("secret-not-json", { status: 400 })
        if (mode === "size") return Response.json({ error: { message: "API key group platform is not gemini" } }, { status: 400, headers: { "content-length": "99999999" } })
        return new Response("data: secret\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })
      })
      const plugin = await Sub2apiPlugin({}, { diagnostics: true })
      assert.equal((await plugin.provider.models({}, { auth: auth() }))[IDS[0]].api.npm, GEMINI)
      assert.equal(lines.join("\n").includes("secret"), false)
    })
  }
})

test("protocol metadata caches are invalidated with this key's auth scope, not another key's", async (t) => {
  let refused = false
  let probes = 0
  t.mock.method(globalThis, "fetch", async (input, init) => {
    if (init?.credentials === "omit") return new Response(null, { status: 404 })
    const url = String(input)
    const key = new Headers(init?.headers).get("authorization")
    if (url.endsWith("/usage")) return new Response(null, { status: refused && key === "Bearer first-key" ? 401 : 200 })
    if (url.endsWith("/v1/models")) return Response.json(catalog())
    probes++
    return refused ? Response.json(nativeCatalog()) : platformError()
  })
  const plugin = await Sub2apiPlugin()
  for (const key of ["first-key", "other-key"]) assert.equal((await plugin.provider.models({}, { auth: auth(key) }))[IDS[0]].api.npm, CHAT)
  assert.equal(probes, 2)
  refused = true
  assert.equal((await plugin.auth.usage(async () => auth("first-key"))).signIn, "expired")
  assert.equal((await plugin.provider.models({}, { auth: auth("first-key") }))[IDS[0]].api.npm, GEMINI)
  assert.equal((await plugin.provider.models({}, { auth: auth("other-key") }))[IDS[0]].api.npm, CHAT)
  assert.equal(probes, 3)
})

test("only automatic visible Gemini models switch; explicit native models and GPT/Claude keep their APIs", async (t) => {
  const ids = [...IDS, "gpt-test", "claude-test", "deepseek-chat"]
  mockProbe(t, platformError, ids)
  const plugin = await Sub2apiPlugin({}, { protocol: "responses", modelProtocols: { [IDS[0]]: "auto", [IDS[1]]: "gemini", "claude-test": "anthropic", "deepseek-chat": "chat-completions" } })
  const found = await plugin.provider.models({}, { auth: auth() })
  assert.equal(found[IDS[0]].api.npm, CHAT)
  assert.equal(found[IDS[1]].api.npm, GEMINI)
  assert.equal(found["gpt-test"].api.npm, "@ai-sdk/openai")
  assert.equal(found["claude-test"].api.npm, "@ai-sdk/anthropic")
  assert.equal(found["deepseek-chat"].api.npm, CHAT)
})

test("the protocol probe budget bounds a stalled error body and cancels it without falling back", async (t) => {
  let cancelled = false
  const calls = mockProbe(t, () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"error":')) },
    cancel() { cancelled = true },
  }), { status: 400, headers: { "content-type": "application/json" } }))
  const plugin = await Sub2apiPlugin({}, { query: { timeoutMs: 15 } })
  // AbortSignal.timeout is unref'ed; a fetch mock has no socket keeping Node up.
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    const found = await plugin.provider.models({}, { auth: auth() })
    assert.equal(found[IDS[0]].api.npm, GEMINI)
    assert.equal(cancelled, true)
    assert.equal(calls.length, 2)
  } finally {
    clearTimeout(keepAlive)
  }
})

test("a failed fallback inference preserves its response and never tries more models, keys or protocols", async (t) => {
  mockProbe(t, platformError)
  const plugin = await Sub2apiPlugin()
  await plugin.provider.models({}, { auth: auth() })
  const loader = await plugin.auth.loader(async () => auth())
  t.mock.restoreAll()
  for (const status of [400, 401, 403, 404, 429, 500, 503]) {
    let sends = 0
    const response = Response.json({ error: { message: "chat does not serve the selected model" } }, { status })
    t.mock.method(globalThis, "fetch", async (_, init) => {
      sends++
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer synthetic-probe-key")
      return response
    })
    const body = JSON.stringify({ model: IDS[0], messages: [], stream: true })
    assert.equal(await loader.fetch(loader.baseURL + "/chat/completions", { method: "POST", body }), response)
    assert.equal(sends, 1)
    t.mock.restoreAll()
  }
})

test("a cached native request is not secretly retried in chat when inference fails", async (t) => {
  const calls = mockProbe(t)
  const plugin = await Sub2apiPlugin()
  await plugin.provider.models({}, { auth: auth() })
  const loader = await plugin.auth.loader(async () => auth())
  t.mock.restoreAll()
  let sent = 0
  const response = platformError()
  t.mock.method(globalThis, "fetch", async () => { sent++; return response })
  assert.equal(await loader.fetch(loader.baseURL + "/models/" + IDS[0] + ":generateContent", { method: "POST", body: '{"contents":[]}' }), response)
  assert.equal(sent, 1)
  assert.equal(calls.length, 2)
})

test("real HTTP auto discovery changes Gemini's advertised protocol before a single chat inference", async (t) => {
  const calls = []
  const server = createServer(async (req, res) => {
    let body = ""
    for await (const chunk of req) body += chunk
    calls.push({ path: req.url, method: req.method, body, headers: req.headers })
    res.setHeader("content-type", "application/json")
    if (req.url === "/gateway/v1/models") { res.end(JSON.stringify(catalog())); return }
    if (req.url === "/gateway/v1beta/models") {
      res.writeHead(400).end(JSON.stringify({ error: { message: "API key group platform is not gemini" } }))
      return
    }
    if (req.url === "/gateway/v1/chat/completions") {
      res.setHeader("content-type", "text/event-stream")
      res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
      return
    }
    res.writeHead(404).end()
  })
  server.listen(0, "127.0.0.1")
  try { await once(server, "listening") } catch (error) {
    if (!["EPERM", "EACCES"].includes(error.code)) throw error
    t.skip("This environment does not allow listening on a local TCP port")
    return
  }
  t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}/gateway`
  const account = auth("loopback-key", { baseURL: base })
  const plugin = await Sub2apiPlugin()
  const found = await plugin.provider.models({}, { auth: account })
  assert.equal(found[IDS[0]].api.npm, CHAT)
  const loader = await plugin.auth.loader(async () => account)
  const response = await loader.fetch(found[IDS[0]].api.url + "/chat/completions", {
    method: "POST", body: JSON.stringify({ model: IDS[0], messages: [{ role: "user", content: "hi" }], stream: true }),
  })
  assert.match(await response.text(), /"content":"ok"/)
  const own = calls.filter((call) => call.headers.authorization)
  assert.deepEqual(own.map((call) => call.method), ["GET", "GET", "POST"])
  for (const call of own) assert.equal(call.headers.authorization, "Bearer loopback-key")
  assert.equal(JSON.parse(own[2].body).model, IDS[0])
})
