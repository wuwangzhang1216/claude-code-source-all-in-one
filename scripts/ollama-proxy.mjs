#!/usr/bin/env node
//
// Anthropic Messages API → Ollama proxy.
//
// Lets the Claude Code CLI run against a local Ollama model by exposing
// /v1/messages on a local port and translating to Ollama's /api/chat.
//
// Usage:
//   node scripts/ollama-proxy.mjs               # listens on 0.0.0.0:11435
//   PORT=12345 node scripts/ollama-proxy.mjs    # custom port
//   OLLAMA_HOST=http://host:11434 node scripts/ollama-proxy.mjs
//   OLLAMA_MODEL=qwen2.5-coder:7b ./start.sh    # pin a single model
//
// Then point Claude Code at it:
//   export ANTHROPIC_BASE_URL=http://localhost:11435
//   export ANTHROPIC_API_KEY=ollama-local       # any non-empty value
//   ./start.sh
//
// Env knobs:
//   PORT                 listen port (default 11435)
//   HOST                 listen host (default 127.0.0.1)
//   OLLAMA_HOST          upstream Ollama URL (default http://127.0.0.1:11434)
//   OLLAMA_MODEL         force a single model regardless of request
//   OLLAMA_NUM_CTX       context window (default 8192)
//   OLLAMA_KEEP_ALIVE    Ollama keep-alive (default 30m)
//   PROXY_DEBUG          set to 1 to log every request/response
//   PROMPTED_TOOLS       set to 1 to inject tools via prompt instead of native FC
//   OLLAMA_THINK         set to 1 to enable model "thinking" (default off — agents
//                        want answers, not reasoning traces). Thinking text, when
//                        enabled, is forwarded as plain text deltas.

import http from 'node:http'
import { randomUUID } from 'node:crypto'

const PORT = Number(process.env.PORT || 11435)
const HOST = process.env.HOST || '127.0.0.1'
const OLLAMA_HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '')
const FORCED_MODEL = process.env.OLLAMA_MODEL || ''
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX || 8192)
const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '30m'
const DEBUG = process.env.PROXY_DEBUG === '1'
const PROMPTED_TOOLS = process.env.PROMPTED_TOOLS === '1'
const ALLOW_THINKING = process.env.OLLAMA_THINK === '1'

const log = (...a) => DEBUG && console.error('[ollama-proxy]', ...a)

// ---------------------------------------------------------------------------
// Anthropic → Ollama request translation
// ---------------------------------------------------------------------------

function flattenSystem(system) {
  if (!system) return ''
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return system
      .map(b => (typeof b === 'string' ? b : (b?.text ?? '')))
      .filter(Boolean)
      .join('\n\n')
  }
  return ''
}

function flattenContent(content) {
  if (typeof content === 'string') return { text: content, toolCalls: [], toolResults: [] }
  if (!Array.isArray(content)) return { text: '', toolCalls: [], toolResults: [] }
  const textParts = []
  const toolCalls = []
  const toolResults = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (block.text) textParts.push(block.text)
        break
      case 'tool_use':
        toolCalls.push({
          id: block.id,
          function: { name: block.name, arguments: block.input ?? {} },
        })
        break
      case 'tool_result': {
        let body = block.content
        if (Array.isArray(body)) {
          body = body.map(x => (typeof x === 'string' ? x : x?.text ?? '')).join('\n')
        }
        toolResults.push({ tool_use_id: block.tool_use_id, content: String(body ?? '') })
        break
      }
      // image / document blocks are ignored — most local models can't use them.
      default:
        break
    }
  }
  return { text: textParts.join('\n'), toolCalls, toolResults }
}

function toolsToOllama(tools) {
  if (!Array.isArray(tools)) return undefined
  const out = []
  for (const t of tools) {
    if (!t?.name) continue
    out.push({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    })
  }
  return out.length ? out : undefined
}

function describeToolsForPrompt(tools) {
  if (!Array.isArray(tools) || !tools.length) return ''
  const lines = [
    '',
    '# Available tools',
    '',
    'You may invoke a tool by emitting a single line:',
    '<tool_call>{"name": "<tool>", "arguments": {<json>}}</tool_call>',
    'Emit one tool_call at a time and stop generating after it.',
    '',
  ]
  for (const t of tools) {
    lines.push(`## ${t.name}`)
    if (t.description) lines.push(t.description.trim())
    if (t.input_schema) {
      lines.push('Schema:')
      lines.push('```json')
      lines.push(JSON.stringify(t.input_schema))
      lines.push('```')
    }
    lines.push('')
  }
  return lines.join('\n')
}

function buildOllamaMessages(req) {
  const out = []
  let system = flattenSystem(req.system)
  if (PROMPTED_TOOLS && req.tools?.length) system += describeToolsForPrompt(req.tools)
  if (system) out.push({ role: 'system', content: system })

  for (const m of req.messages || []) {
    const { text, toolCalls, toolResults } = flattenContent(m.content)
    if (m.role === 'user') {
      // Tool results from the user role become role:"tool" messages in Ollama.
      for (const r of toolResults) {
        out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: r.content })
      }
      if (text) out.push({ role: 'user', content: text })
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: text || '' }
      if (toolCalls.length) {
        msg.tool_calls = toolCalls.map(tc => ({
          function: { name: tc.function.name, arguments: tc.function.arguments },
        }))
      }
      out.push(msg)
    } else {
      out.push({ role: m.role, content: text })
    }
  }
  return out
}

function buildOllamaRequest(req) {
  const model = FORCED_MODEL || req.model || 'llama3.1'
  const ollamaReq = {
    model,
    messages: buildOllamaMessages(req),
    stream: req.stream !== false,
    keep_alive: KEEP_ALIVE,
    // Disable reasoning by default — agent loops want answers/tool calls, not
    // long internal monologues. Ignored by models that don't support `think`.
    think: ALLOW_THINKING,
    options: {
      num_ctx: NUM_CTX,
      num_predict: req.max_tokens ?? -1,
      temperature: req.temperature ?? 0.7,
    },
  }
  if (Array.isArray(req.stop_sequences) && req.stop_sequences.length) {
    ollamaReq.options.stop = req.stop_sequences
  }
  if (typeof req.top_p === 'number') ollamaReq.options.top_p = req.top_p
  if (typeof req.top_k === 'number') ollamaReq.options.top_k = req.top_k

  if (!PROMPTED_TOOLS) {
    const tools = toolsToOllama(req.tools)
    if (tools) ollamaReq.tools = tools
  }
  return ollamaReq
}

// ---------------------------------------------------------------------------
// Ollama → Anthropic SSE translation
// ---------------------------------------------------------------------------

function makeMessageId() {
  return 'msg_' + randomUUID().replace(/-/g, '').slice(0, 24)
}
function makeToolUseId() {
  return 'toolu_' + randomUUID().replace(/-/g, '').slice(0, 22)
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function mapStopReason(ollamaReason, hadToolCalls) {
  if (hadToolCalls) return 'tool_use'
  switch (ollamaReason) {
    case 'stop':
      return 'end_turn'
    case 'length':
      return 'max_tokens'
    case 'load':
    case 'unload':
      return 'end_turn'
    default:
      return 'end_turn'
  }
}

// Extract <tool_call>{...}</tool_call> blocks from text — used in PROMPTED_TOOLS mode.
function extractPromptedToolCalls(text) {
  const calls = []
  const re = /<tool_call>([\s\S]*?)<\/tool_call>/g
  let stripped = text
  let m
  while ((m = re.exec(text)) != null) {
    try {
      const parsed = JSON.parse(m[1].trim())
      if (parsed && typeof parsed === 'object' && parsed.name) {
        calls.push({ name: parsed.name, arguments: parsed.arguments ?? parsed.input ?? {} })
      }
    } catch {
      // ignore malformed
    }
  }
  if (calls.length) stripped = text.replace(re, '').trim()
  return { text: stripped, calls }
}

async function streamOllamaToAnthropic(req, res, body) {
  const ollamaReq = buildOllamaRequest({ ...body, stream: true })
  log('->', ollamaReq.model, 'msgs:', ollamaReq.messages.length, 'tools:', ollamaReq.tools?.length || 0)

  let upstream
  try {
    upstream = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ollamaReq),
    })
  } catch (err) {
    return sendError(res, 502, 'api_error', `Cannot reach Ollama at ${OLLAMA_HOST}: ${err.message}`)
  }

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => '')
    return sendError(res, upstream.status || 502, 'api_error', `Ollama error: ${errText || upstream.statusText}`)
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })

  const messageId = makeMessageId()
  const modelName = body.model || ollamaReq.model

  sseWrite(res, 'message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: modelName,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
    },
  })

  // Active content block bookkeeping
  let blockIndex = -1
  let textBlockOpen = false
  let openToolBlocks = new Map() // index -> { id, name, sentArgs }
  let hadToolCalls = false
  let stopReason = 'stop'
  let usage = { input_tokens: 0, output_tokens: 0 }
  let promptedBuffer = ''

  const openTextBlock = () => {
    if (textBlockOpen) return
    blockIndex += 1
    sseWrite(res, 'content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'text', text: '' },
    })
    textBlockOpen = true
  }

  const closeTextBlock = () => {
    if (!textBlockOpen) return
    sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex })
    textBlockOpen = false
  }

  const emitToolCall = (call) => {
    hadToolCalls = true
    closeTextBlock()
    blockIndex += 1
    const id = call.id || makeToolUseId()
    sseWrite(res, 'content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'tool_use', id, name: call.name, input: {} },
    })
    const args = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {})
    sseWrite(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'input_json_delta', partial_json: args },
    })
    sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex })
  }

  const reader = upstream.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  // NDJSON stream consumer
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        let chunk
        try {
          chunk = JSON.parse(line)
        } catch {
          log('parse fail:', line)
          continue
        }
        if (chunk.error) {
          sseWrite(res, 'error', { type: 'error', error: { type: 'api_error', message: chunk.error } })
          continue
        }
        const contentPiece = chunk.message?.content || ''
        const thinkingPiece = ALLOW_THINKING ? (chunk.message?.thinking || '') : ''
        const piece = contentPiece || thinkingPiece
        const toolCalls = chunk.message?.tool_calls || []

        if (PROMPTED_TOOLS && piece) {
          // Buffer text so we can strip <tool_call> blocks before forwarding deltas.
          promptedBuffer += piece
          const lastClose = promptedBuffer.lastIndexOf('</tool_call>')
          if (lastClose >= 0) {
            const safeChunk = promptedBuffer.slice(0, lastClose + '</tool_call>'.length)
            promptedBuffer = promptedBuffer.slice(lastClose + '</tool_call>'.length)
            const { text, calls } = extractPromptedToolCalls(safeChunk)
            if (text) {
              openTextBlock()
              sseWrite(res, 'content_block_delta', {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'text_delta', text },
              })
            }
            for (const c of calls) emitToolCall(c)
          } else if (!promptedBuffer.includes('<tool_call')) {
            // Safe to flush — no partial tool tag in flight
            openTextBlock()
            sseWrite(res, 'content_block_delta', {
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'text_delta', text: promptedBuffer },
            })
            promptedBuffer = ''
          }
        } else if (piece) {
          openTextBlock()
          sseWrite(res, 'content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'text_delta', text: piece },
          })
        }

        for (const tc of toolCalls) {
          emitToolCall({
            id: tc.id,
            name: tc.function?.name,
            arguments: tc.function?.arguments,
          })
        }

        if (chunk.done) {
          // Flush any leftover prompted text buffer
          if (PROMPTED_TOOLS && promptedBuffer) {
            const { text, calls } = extractPromptedToolCalls(promptedBuffer)
            if (text) {
              openTextBlock()
              sseWrite(res, 'content_block_delta', {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'text_delta', text },
              })
            }
            for (const c of calls) emitToolCall(c)
            promptedBuffer = ''
          }
          stopReason = chunk.done_reason || 'stop'
          usage = {
            input_tokens: chunk.prompt_eval_count ?? 0,
            output_tokens: chunk.eval_count ?? 0,
          }
        }
      }
    }
  } catch (err) {
    log('stream error:', err.message)
    sseWrite(res, 'error', { type: 'error', error: { type: 'api_error', message: err.message } })
  }

  closeTextBlock()
  sseWrite(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: mapStopReason(stopReason, hadToolCalls), stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  })
  sseWrite(res, 'message_stop', { type: 'message_stop' })
  res.end()
}

// ---------------------------------------------------------------------------
// Non-streaming variant — collect SSE into a single Anthropic Message JSON
// ---------------------------------------------------------------------------

async function nonStreamingResponse(req, res, body) {
  const ollamaReq = buildOllamaRequest({ ...body, stream: false })

  let upstream
  try {
    upstream = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ollamaReq),
    })
  } catch (err) {
    return sendError(res, 502, 'api_error', `Cannot reach Ollama at ${OLLAMA_HOST}: ${err.message}`)
  }
  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '')
    return sendError(res, upstream.status, 'api_error', `Ollama error: ${errText}`)
  }
  const data = await upstream.json()
  const text = data.message?.content || (ALLOW_THINKING ? data.message?.thinking || '' : '')
  const toolCalls = data.message?.tool_calls || []
  let promptedCalls = []
  let cleanText = text
  if (PROMPTED_TOOLS) {
    const r = extractPromptedToolCalls(text)
    cleanText = r.text
    promptedCalls = r.calls
  }
  const allCalls = [
    ...toolCalls.map(tc => ({ name: tc.function?.name, arguments: tc.function?.arguments })),
    ...promptedCalls,
  ]
  const content = []
  if (cleanText) content.push({ type: 'text', text: cleanText })
  for (const c of allCalls) {
    content.push({ type: 'tool_use', id: makeToolUseId(), name: c.name, input: c.arguments ?? {} })
  }
  const responseBody = {
    id: makeMessageId(),
    type: 'message',
    role: 'assistant',
    model: body.model || ollamaReq.model,
    content,
    stop_reason: mapStopReason(data.done_reason || 'stop', allCalls.length > 0),
    stop_sequence: null,
    usage: {
      input_tokens: data.prompt_eval_count ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: data.eval_count ?? 0,
    },
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(responseBody))
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function sendError(res, status, type, message) {
  if (res.headersSent) {
    try { res.end() } catch {}
    return
  }
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'error', error: { type, message } }))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(text.length / 4))
}

const server = http.createServer(async (req, res) => {
  // Health endpoint for sanity checks
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, upstream: OLLAMA_HOST, forced_model: FORCED_MODEL || null }))
    return
  }

  if (req.method !== 'POST') {
    return sendError(res, 405, 'invalid_request_error', 'Method not allowed')
  }

  // Strip query string for path matching
  const path = (req.url || '').split('?')[0]

  let body
  try {
    body = await readBody(req)
  } catch (err) {
    return sendError(res, 400, 'invalid_request_error', `Invalid JSON: ${err.message}`)
  }

  log(req.method, path, 'stream=' + (body.stream !== false))

  if (path === '/v1/messages' || path === '/v1/messages/') {
    if (body.stream === false) return nonStreamingResponse(req, res, body)
    return streamOllamaToAnthropic(req, res, body)
  }

  if (path === '/v1/messages/count_tokens') {
    const sys = flattenSystem(body.system)
    let total = estimateTokens(sys)
    for (const m of body.messages || []) {
      const { text } = flattenContent(m.content)
      total += estimateTokens(text)
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ input_tokens: total }))
  }

  return sendError(res, 404, 'not_found_error', `Unknown endpoint: ${path}`)
})

server.listen(PORT, HOST, () => {
  console.error(`[ollama-proxy] listening on http://${HOST}:${PORT}`)
  console.error(`[ollama-proxy] upstream Ollama: ${OLLAMA_HOST}`)
  if (FORCED_MODEL) console.error(`[ollama-proxy] forced model: ${FORCED_MODEL}`)
  if (PROMPTED_TOOLS) console.error(`[ollama-proxy] tool mode: prompt-injection (PROMPTED_TOOLS=1)`)
  console.error(`[ollama-proxy] Point Claude Code at it:`)
  console.error(`    export ANTHROPIC_BASE_URL=http://${HOST}:${PORT}`)
  console.error(`    export ANTHROPIC_API_KEY=ollama-local`)
})
