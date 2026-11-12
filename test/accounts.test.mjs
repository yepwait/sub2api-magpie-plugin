import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import test from "node:test"
import { Sub2apiPlugin, Sub2apiSite1, Sub2apiSite2, Sub2apiSite3 } from "../index.mjs"

const BASE = "https://accounts.example.com/gateway"
const GROUPS = [
  { key: "synthetic-gpt-key", ids: ["gpt-6.1-sol"], npm: "@ai-sdk/openai", suffix: "responses" },
  { key: "synthetic-claude-key", ids: ["claude-opus-5-5", "claude-sonnet-5-5"], npm: "@ai-sdk/anthropic", suffix: "messages" },
  { key: "synthetic-gemini-key", ids: ["gemini-3.8-flash-high", "gemini-4-argon-high"], npm: "@ai-sdk/google", suffix: "models/gemini-3.8-flash-high:streamGenerateContent" },
]
const account = (group, baseURL = BASE, metadata = {}) => ({ type: "api", key: group.key, metadata: { baseURL, ...metadata } })
const payload = (group) => group.npm === "@ai-sdk/google"
  ? { contents: [{ role: "user", parts: [{ text: "hi" }] }] }
  : group.npm === "@ai-sdk/anthropic"
    ? { model: group.ids[0], max_tokens: 16, messages: [{ role: "user", content: "hi" }] }
    : { model: group.ids[0], input: "hi" }

function mockAccounts(t) {
  const sent = []
  const queries = []
  t.mock.method(globalThis, "fetch", async (input, init) => {
    if (init?.credentials === "omit") return new Response(null, { status: 404 })
    const url = new URL(input instanceof Request ? input.url : input)
    const headers = new Headers(init?.headers)
    const group = GROUPS.find((group) => headers.get("authorization") === "Bearer " + group.key)
    assert.ok(group, "the selected account always supplies authentication")
    if (url.pathname.endsWith("/v1/models")) {
      queries.push(group.key)
      return Response.json({ data: group.ids.map((id) => ({ id })) })
    }
    if (url.pathname.endsWith("/backend-api/codex/models")) return Response.json({ models: [] })
    sent.push({ url: url.href, headers, body: init?.body, input })
    return Response.json({ ok: true })
  })
  return { sent, queries }
}

test("same-address GPT, Claude and Gemini accounts keep their own catalogs and concurrent credentials", async (t) => {
  const { sent, queries } = mockAccounts(t)
  const plugin = await Sub2apiPlugin()
  // Create transports before discovery, as a host with cached loaders can do.
  const loaders = await Promise.all(GROUPS.map((group) => plugin.auth.loader(async () => account(group))))
  const catalogs = await Promise.all(GROUPS.map((group) => plugin.provider.models({}, { auth: account(group) })))
  assert.deepEqual(queries.sort(), GROUPS.map((group) => group.key).sort())
  for (const [index, group] of GROUPS.entries()) {
    assert.equal(loaders[index].baseURL, BASE + "/v1")
    assert.deepEqual(Object.keys(catalogs[index]), group.ids)
    assert.equal(catalogs[index][group.ids[0]].api.npm, group.npm)
  }
  const sends = GROUPS.flatMap((group, index) => [0, 1, 2].map(async () => {
    const result = await loaders[index].fetch(loaders[index].baseURL + "/" + group.suffix, {
      method: "POST", body: JSON.stringify(payload(group)),
      headers: { authorization: "Bearer wrong-account", "x-api-key": "wrong-account", "x-goog-api-key": "wrong-account" },
    })
    assert.equal(result.status, 200)
  }))
  await Promise.all(sends)
  assert.equal(sent.length, 9)
  for (const call of sent) {
    const group = GROUPS.find((group) => call.headers.get("authorization") === "Bearer " + group.key)
    assert.equal(call.headers.get("x-api-key"), group.key)
    assert.equal(call.headers.get("x-goog-api-key"), group.key)
    assert.equal(call.url, BASE + (group.npm === "@ai-sdk/google" ? "/v1beta/" : "/v1/") + group.suffix)
    if (group.npm !== "@ai-sdk/google") assert.equal(JSON.parse(call.body).model, group.ids[0])
  }
})

test("wrong-account model checks fail locally for all protocols without exposing names or switching keys", async (t) => {
  const { sent } = mockAccounts(t)
  const lines = []
  t.mock.method(console, "error", (line) => lines.push(line))
  const plugin = await Sub2apiPlugin({}, { diagnostics: true })
  const catalogs = await Promise.all(GROUPS.map((group) => plugin.provider.models({}, { auth: account(group) })))
  const loader = await plugin.auth.loader(async () => account(GROUPS[0]))
  const claude = await plugin.auth.loader(async () => account(GROUPS[1]))
  // The user's single-Claude-account control: the model/key pair itself works.
  await claude.fetch(claude.baseURL + "/messages", { method: "POST", body: JSON.stringify(payload(GROUPS[1])) })
  assert.equal(sent.length, 1)
  sent.length = 0
  for (const [suffix, body] of [
    ["messages", { model: GROUPS[1].ids[0], messages: [] }],
    ["responses", { model: GROUPS[1].ids[0], input: "hi" }],
    ["chat/completions", { model: GROUPS[1].ids[0], messages: [] }],
    ["models/" + GROUPS[2].ids[0] + ":generateContent", { contents: [] }],
  ]) {
    await assert.rejects(loader.fetch(loader.baseURL + "/" + suffix, { method: "POST", body: JSON.stringify(body) }), (error) => {
      assert.match(error.message, /not listed for this Sub2API account/)
      assert.match(error.message, /stopped locally before contacting Sub2API/)
      assert.equal(error.kind, "model-account-mismatch")
      assert.equal(error.signIn, undefined)
      for (const group of GROUPS) {
        assert.equal(error.message.includes(group.key), false)
        for (const id of group.ids) assert.equal(error.message.includes(id), false)
      }
      return true
    })
  }
  assert.equal(sent.length, 0)
  assert.deepEqual(Object.keys(catalogs[1]), GROUPS[1].ids)
  const events = lines.map((line) => JSON.parse(line.slice(line.indexOf("{"))))
  const ready = events.filter((entry) => entry.event === "models.ready")
  assert.equal(ready.length, 3)
  assert.equal(new Set(ready.map((entry) => entry.accountRef)).size, 3)
  for (const entry of ready) assert.match(entry.accountRef, /^[0-9a-f]{12}$/)
  const rejected = events.filter((entry) => entry.event === "inference.model_rejected")
  assert.equal(rejected.length, 4)
  const gptReady = ready.find((entry) => entry.visible === GROUPS[0].ids.length)
  for (const entry of rejected) {
    assert.equal(entry.accountRef, gptReady.accountRef)
    assert.equal(entry.catalogModels, 1)
  }
  assert.deepEqual(rejected.map((entry) => entry.source), ["body", "body", "body", "path"])
  for (const value of [BASE, ...GROUPS.flatMap((group) => [group.key, ...group.ids])]) assert.equal(lines.join("\n").includes(value), false)
})

test("account diagnostics preserve unsigned-in and invalid-configuration results", async (t) => {
  const lines = []
  t.mock.method(console, "error", (line) => lines.push(line))
  t.mock.method(globalThis, "fetch", async () => { assert.fail("invalid configuration must not make a request") })
  for (const diagnostics of [false, true]) {
    const plugin = await Sub2apiPlugin({}, { diagnostics })
    assert.deepEqual(await plugin.auth.loader(async () => undefined), {})
    assert.deepEqual(await plugin.provider.models({}), {})
    assert.deepEqual(await plugin.auth.usage(async () => undefined), { error: "not signed in" })
    for (const metadata of [
      { baseURL: "ftp://invalid.example.com" },
      { headers: { authorization: "private-header-value" } },
    ]) {
      const auth = account(GROUPS[0], BASE, metadata)
      let message
      await assert.rejects(plugin.auth.loader(async () => auth), (error) => {
        message = error.message
        assert.equal(message.includes("private-header-value"), false)
        return true
      })
      await assert.rejects(plugin.provider.models({}, { auth }), (error) => error.message === message)
      assert.deepEqual(await plugin.auth.usage(async () => auth), { error: message, windows: [] })
    }
  }
  assert.equal(lines.length, 0)
})

test("Gemini URL models are checked exactly without consuming bodies or accepting another body's model", async (t) => {
  const group = GROUPS[2]
  const { sent } = mockAccounts(t)
  const plugin = await Sub2apiPlugin({}, { query: { modelsTtlMs: 0 } })
  const auth = account(group)
  await plugin.provider.models({}, { auth })
  const loader = await plugin.auth.loader(async () => auth)
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{}")); controller.close() } })
  const request = new Request(loader.baseURL + "/models/" + group.ids[0] + ":countTokens", { method: "POST", body: stream, duplex: "half" })
  await loader.fetch(request)
  assert.equal(request.bodyUsed, false)
  assert.equal(await request.text(), "{}")
  assert.equal(sent.length, 1)
  await assert.rejects(loader.fetch(loader.baseURL + "/models/gemini-other-account:generateContent", {
    method: "POST", body: JSON.stringify({ model: group.ids[0], contents: [] }),
  }), /not listed/)
  await assert.rejects(loader.fetch(loader.baseURL + "/models/" + group.ids[0] + "-fast:generateContent", {
    method: "POST", body: "{}",
  }), /not listed/)
  assert.equal(sent.length, 1)
  // Filters narrow only the matching account/selection catalog scope.
  const filteredAuth = account(group, BASE, { excludeModels: [group.ids[0]] })
  await plugin.provider.models({}, { auth: filteredAuth })
  const filtered = await plugin.auth.loader(async () => filteredAuth)
  await assert.rejects(filtered.fetch(filtered.baseURL + "/models/" + group.ids[0] + ":generateContent", { method: "POST", body: "{}" }), /not listed/)
  // The original selection remains separate and still accepts its listed ID.
  await loader.fetch(loader.baseURL + "/models/" + group.ids[0] + ":generateContent", { method: "POST", body: "{}" })
  assert.equal(sent.length, 2)
})

test("Gemini path validation supports custom paths, percent encoding and namespaced model IDs", async (t) => {
  const ids = ["vendor/gemini-test", "gemini alias", "gemini-real-fast"]
  const sent = []
  t.mock.method(globalThis, "fetch", async (input, init) => {
    if (init?.credentials === "omit") return new Response(null, { status: 404 })
    if (String(input).endsWith("/v1/models")) return Response.json({ data: ids.map((id) => ({ id })) })
    sent.push(input instanceof Request ? input.url : String(input))
    return Response.json({ ok: true })
  })
  const plugin = await Sub2apiPlugin({}, { protocol: "gemini", apiPaths: { gemini: "/native/v1beta" } })
  const auth = account(GROUPS[2])
  await plugin.provider.models({}, { auth })
  const loader = await plugin.auth.loader(async () => auth)
  for (const id of ids) {
    for (const action of ["generateContent", "streamGenerateContent", "countTokens"]) {
      await loader.fetch(loader.baseURL + "/models/" + encodeURIComponent(id) + ":" + action, { method: "POST", body: "{}" })
      assert.equal(sent.at(-1), BASE + "/native/v1beta/models/" + encodeURIComponent(id) + ":" + action)
    }
  }
  for (const value of ["gemini%ZZ", "gemini-unlisted", "gemini-real-fast-fast"]) {
    await assert.rejects(loader.fetch(loader.baseURL + "/models/" + value + ":generateContent", { method: "POST", body: "{}" }), /not listed/)
  }
  assert.equal(sent.length, 9)
})

test("inference removes caller query credentials on every protocol without changing other parameters", async (t) => {
  const { sent } = mockAccounts(t)
  const plugin = await Sub2apiPlugin()
  for (const group of GROUPS) {
    const loader = await plugin.auth.loader(async () => account(group))
    const address = new URL(loader.baseURL + "/" + group.suffix)
    address.searchParams.append("key", "caller-key")
    address.searchParams.append("key", "caller-duplicate-key")
    address.searchParams.append("api_key", "caller-other-key")
    address.searchParams.append("alt", "sse")
    address.searchParams.append("trace", "a/b")
    const controller = new AbortController()
    const body = JSON.stringify(payload(group))
    const request = new Request(address, {
      method: "POST", body, headers: { "x-trace": "kept" }, signal: controller.signal,
    })
    await loader.fetch(request)
    const call = sent.at(-1)
    assert.ok(call.input instanceof Request)
    assert.equal(call.input.method, "POST")
    assert.equal(request.bodyUsed, false)
    assert.equal(await request.text(), body)
    controller.abort()
    assert.equal(call.input.signal.aborted, true)
    const url = new URL(call.url)
    assert.equal(url.searchParams.has("key"), false)
    assert.equal(url.searchParams.has("api_key"), false)
    assert.equal(url.searchParams.get("alt"), "sse")
    assert.equal(url.searchParams.get("trace"), "a/b")
    assert.equal(sent.at(-1).headers.get("x-trace"), "kept")
  }
  const loader = await plugin.auth.loader(async () => account(GROUPS[0]))
  const url = loader.baseURL + "/responses?trace=a%20b&raw=%7e"
  await loader.fetch(url, { method: "POST", body: JSON.stringify(payload(GROUPS[0])) })
  assert.equal(sent.at(-1).url, url)
})

test("same-address site providers isolate their keys without synthetic URL tags", async (t) => {
  const { sent } = mockAccounts(t)
  const options = { sites: [
    { id: "gpt-site", url: BASE, protocol: "responses" },
    { id: "claude-site", url: BASE, protocol: "anthropic" },
    { id: "gemini-site", url: BASE, protocol: "gemini" },
  ] }
  for (const [index, factory] of [Sub2apiSite1, Sub2apiSite2, Sub2apiSite3].entries()) {
    const group = GROUPS[index]
    const plugin = await factory({}, options)
    const found = await plugin.provider.models({}, { auth: account(group) })
    const loader = await plugin.auth.loader(async () => account(group))
    assert.deepEqual(Object.keys(found), group.ids)
    assert.equal(loader.baseURL, BASE + "/v1")
    assert.equal(found[group.ids[0]].api.npm, group.npm)
    assert.equal(found[group.ids[0]].providerID, plugin.provider.id)
    await loader.fetch(loader.baseURL + "/" + group.suffix, { method: "POST", body: JSON.stringify(payload(group)) })
    assert.equal(sent.at(-1).headers.get("authorization"), "Bearer " + group.key)
  }
})

test("real HTTP same-address multi-key requests reach the matching native endpoint once", async (t) => {
  const calls = []
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost")
    const group = GROUPS.find((group) => req.headers.authorization === "Bearer " + group.key)
    res.setHeader("content-type", "application/json")
    if (!group) { res.writeHead(404).end(); return }
    if (url.pathname === "/gateway/v1/models") {
      res.end(JSON.stringify({ data: group.ids.map((id) => ({ id })) }))
      return
    }
    if (url.pathname.endsWith("/backend-api/codex/models")) { res.end('{"models":[]}'); return }
    let body = ""
    for await (const chunk of req) body += chunk
    calls.push({ url: req.url, headers: req.headers, body, group })
    const expected = "/gateway/" + (group.npm === "@ai-sdk/google" ? "v1beta/" : "v1/") + group.suffix
    const ok = url.pathname === expected && !url.searchParams.has("key") && !url.searchParams.has("api_key")
      && (group.npm !== "@ai-sdk/anthropic" || req.headers["x-api-key"] === group.key)
      && (group.npm !== "@ai-sdk/google" || req.headers["x-goog-api-key"] === group.key)
    res.writeHead(ok ? 200 : 400).end(JSON.stringify({ ok }))
  })
  server.listen(0, "127.0.0.1")
  try { await once(server, "listening") } catch (error) {
    if (!["EPERM", "EACCES"].includes(error.code)) throw error
    t.skip("This environment does not allow listening on a local TCP port")
    return
  }
  t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}/gateway`
  const plugin = await Sub2apiPlugin()
  await Promise.all(GROUPS.map((group) => plugin.provider.models({}, { auth: account(group, base) })))
  const loaders = await Promise.all(GROUPS.map((group) => plugin.auth.loader(async () => account(group, base))))
  await Promise.all(GROUPS.map(async (group, index) => {
    const query = group.npm === "@ai-sdk/google" ? "?alt=sse&key=caller-key&api_key=caller-other-key" : ""
    const response = await loaders[index].fetch(loaders[index].baseURL + "/" + group.suffix + query, {
      method: "POST", body: JSON.stringify(payload(group)), headers: { "content-type": "application/json" },
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).ok, true)
  }))
  assert.equal(calls.length, 3)
  for (const call of calls) assert.equal(call.headers.authorization, "Bearer " + call.group.key)
})
