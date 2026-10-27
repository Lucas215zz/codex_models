#!/usr/bin/env node
/**
 * Codex 模型路由器 (codex-model-router)
 * ------------------------------------
 * 零依赖 Node 服务。Codex 只配一个 provider 指向本服务（默认 http://127.0.0.1:8788/v1），
 * 本服务按请求体里的 model 字段自动分流到对应渠道：
 *   - wire=responses 的渠道：原样透传（OpenAI Responses API）
 *   - wire=chat 的渠道：把 Responses 请求翻译成 Chat Completions，再把结果翻译回来
 *     （含 SSE 流式翻译，支持文本与工具调用）
 * 仅监听 127.0.0.1，不对外暴露。
 *
 * 用法：node server.mjs   （或双击 start.cmd）
 * 调试：http://127.0.0.1:8788/__routes   查看路由表
 */

import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "router-config.json"), "utf8"));
const PORT = CFG.port || 8788;
const LOG_FILE = path.join(__dirname, "router.log");
const UPSTREAM_TIMEOUT_MS = 300000;
// 直连失败检测超时：socket 无数据超过该时长即判定直连不通，快速回退代理。
// 取30s 是为了兼顾「首 token 慢但连接正常」的长思考场景。
const DIRECT_FAILFAST_MS = 30000;

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- 路由匹配
function pickChannel(model) {
  if (!model) return null;
  const m = String(model).toLowerCase();
  let best = null;
  let bestLen = -1;
  for (const [name, ch] of Object.entries(CFG.channels)) {
    for (const p of ch.match || []) {
      const pl = p.toLowerCase();
      if (m.startsWith(pl) && pl.length > bestLen) {
        best = { name, ch };
        bestLen = pl.length;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------- 模型名前缀改写
// 中转商为了和官方模型名区分，客户端侧用 "4z-gpt-6-sol" 这种带前缀的名字，
// 转发给上游时要把前缀去掉，还原成 "gpt-6-sol"。
// 渠道里配 stripPrefix: "4z-" 即可；不配就原样透传。
function upstreamModelName(model, channel) {
  const p = channel && channel.stripPrefix;
  if (!p || !model) return model;
  const s = String(model);
  if (s.toLowerCase().startsWith(String(p).toLowerCase())) return s.slice(p.length);
  return s;
}

// ---------------------------------------------------------------- Key 解析
// 优先读 keys/<渠道名>.txt —— 给不懂 JSON 的同学准备：
// 用记事本打开、粘贴 sk- 开头的 key、保存，即时生效，无需重启路由器。
// 文件里只要是中文（说明还是占位说明文字）就忽略，继续用 router-config.json 里的值。
// 渠道配了 keyFile 就用那个文件名，同一家中转商的多个渠道可以共用一个 key 文件。
function resolveKey(channelName, channel) {
  try {
    const keyFile = path.join(__dirname, "keys", (channel.keyFile || channelName) + ".txt");
    if (fs.existsSync(keyFile)) {
      const t = fs.readFileSync(keyFile, "utf8").trim();
      if (t.length >= 16 && !/[\u4e00-\u9fa5]/.test(t)) return t;
    }
  } catch { /* ignore */ }
  return channel.key;
}

// ---------------------------------------------------------------- 代理支持
// 部分渠道（如 kkidc、minimax）直连不通、需要走系统代理。策略：先直连，网络层失败再走代理重试。
//
// 代理地址来源优先级：
//   1. 路由器的 proxy 配置（router-config.json 里的 proxy 字段）—— 不用依赖环境变量，
//      因为路由器常常是双击 start.cmd 启动的，拿不到 shell 里的代理变量。
//   2. 环境变量 HTTPS_PROXY / HTTP_PROXY
//   3. Windows 系统代理（读注册表 ProxyServer）
function getProxyUrl() {
  // 优先级：配置 > 环境变量 > 系统代理。
  // 反过来的话，路由器一旦继承了沙箱注入的 http_proxy=127.0.0.1:58050，
  // 就会把本该直连的上游请求错误地塞进沙箱代理，表现为上游卡死直到超时。
  if (CFG.proxy) return CFG.proxy;
  const fromEnv =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy || null;
  if (fromEnv) return fromEnv;
  return getWindowsSystemProxy();
}

// 读 Windows 系统代理（WinINET）
function getWindowsSystemProxy() {
  try {
    const out = execFileSync(
      "reg",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyServer"],
      { encoding: "utf8", timeout: 5000, windowsHide: true },
    );
    const m = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
    if (!m) return null;
    const raw = m[1].trim();
    // 形如 127.0.0.1:7897 或 http=127.0.0.1:7897;https=127.0.0.1:7897
    const pick = raw.includes("=") ? (raw.match(/https=([^;]+)/) || raw.match(/http=([^;]+)/)) : [null, raw];
    const host = pick && pick[1] ? pick[1].trim() : null;
    if (!host) return null;
    return host.startsWith("http") ? host : `http://${host}`;
  } catch {
    return null;
  }
}

function httpsViaProxy(proxyUrl, targetUrl, options, bodyBuf) {
  return new Promise((resolve, reject) => {
    let pu;
    try { pu = new URL(proxyUrl); } catch { return reject(new Error("bad proxy url")); }
    const target = new URL(targetUrl);
    const proxyReq = http.request({
      host: pu.hostname,
      port: pu.port || 80,
      method: "CONNECT",
      path: `${target.hostname}:443`,
      headers: { Host: `${target.hostname}:443` },
    });
    proxyReq.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error("proxy connect failed: " + res.statusCode));
      }
      const tlsSock = tls.connect({ socket, servername: target.hostname }, () => {
        const req = https.request(targetUrl, {
          method: options.method,
          headers: options.headers,
          agent: false,
          createConnection: () => tlsSock,
        }, resolve);
        req.on("error", reject);
        req.setTimeout(UPSTREAM_TIMEOUT_MS, () => req.destroy(new Error("upstream timeout")));
        if (bodyBuf) req.write(bodyBuf);
        req.end();
      });
      tlsSock.on("error", reject);
    });
    proxyReq.on("error", reject);
    proxyReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => proxyReq.destroy(new Error("proxy timeout")));
    proxyReq.end();
  });
}

function httpsDirect(targetUrl, options, bodyBuf, timeoutMs = DIRECT_FAILFAST_MS) {
  return new Promise((resolve, reject) => {
    // 本地上游（如 SSH 隧道后的 WorkBuddy 网关 http://127.0.0.1:18788）是明文 http，
    // 其余渠道都是 https://。按协议挑模块。
    const mod = String(targetUrl).startsWith("http://") ? http : https;
    const req = mod.request(targetUrl, {
      method: options.method,
      headers: options.headers,
    }, resolve);
    req.on("error", reject);
    // 连接阶段单独计时：连不上就快速报错，好让 auto 模式回退到代理。
    // 连上之后换成长超时——上游慢是常态（agentaipilot 首字节常要 20s+），
    // 之前统一 30s 短超时会误杀正常请求。
    let connected = false;
    const connectTimer = setTimeout(() => {
      if (!connected) req.destroy(new Error("upstream connect timeout"));
    }, timeoutMs);
    req.on("socket", (sock) => {
      const onReady = () => {
        if (connected) return;
        connected = true;
        clearTimeout(connectTimer);
      };
      if (sock.connecting) sock.once("connect", onReady);
      else onReady();
    });
    req.on("timeout", () => req.destroy(new Error("upstream timeout")));
    req.setTimeout(UPSTREAM_TIMEOUT_MS);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

const NET_ERROR_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "EHOSTUNREACH", "ENETUNREACH", "EPROTO", "ECONNABORTED", "ERR_SOCKET_CONNECTION_TIMEOUT",
]);

// viaProxy 语义：
//   "direct"  -> 强制直连，绝不走代理
//   "auto"    -> 先直连，网络层错误时回退到默认代理
//   代理地址   -> 强制走该代理
function resolveProxyMode(channel) {
  const v = channel.viaProxy;
  if (v === "direct") return { mode: "direct", proxy: null };
  if (!v || v === "auto") return { mode: "auto", proxy: getProxyUrl() };
  return { mode: "fixed", proxy: v };
}

async function sendUpstream(targetUrl, options, bodyBuf, channel) {
  const { mode, proxy } = resolveProxyMode(channel);

  if (mode === "direct") {
    return await httpsDirect(targetUrl, options, bodyBuf);
  }
  if (mode === "fixed") {
    log(`强制走代理 ${proxy} -> ${targetUrl}`);
    return await httpsViaProxy(proxy, targetUrl, options, bodyBuf);
  }

  // auto：直连优先，失败再回退代理
  try {
    return await httpsDirect(targetUrl, options, bodyBuf);
  } catch (err) {
    // 明文 http 上游不能走 CONNECT 代理（代理只支持 https 隧道），失败就直接抛。
    if (proxy && NET_ERROR_CODES.has(err.code || "") && !String(targetUrl).startsWith("http://")) {
      log(`直连失败(${err.code})，经代理 ${proxy} 重试 -> ${targetUrl}`);
      return httpsViaProxy(proxy, targetUrl, options, bodyBuf);
    }
    throw err;
  }
}

// ---------------------------------------------------------------- Responses -> Chat 请求翻译
function responsesToChat(r) {
  const messages = [];
  if (r.instructions) messages.push({ role: "system", content: r.instructions });

  let input = r.input;
  if (typeof input === "string") {
    input = [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }];
  }
  if (!Array.isArray(input)) input = [];

  const flushToolCalls = (buf) => {
    if (!buf.length) return;
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: buf.map((tc) => ({
        id: tc.call_id || tc.id || "call_" + Math.random().toString(36).slice(2, 10),
        type: "function",
        function: { name: tc.name, arguments: tc.arguments || "{}" },
      })),
    });
  };

  let pendingToolCalls = [];
  for (const item of input) {
    if (item.type === "function_call") {
      // 连续的 function_call 合并成一条带多个 tool_calls 的 assistant 消息
      pendingToolCalls.push(item);
      continue;
    }
    flushToolCalls(pendingToolCalls);
    pendingToolCalls = [];

    if (item.type === "function_call_output") {
      const out = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
      messages.push({ role: "tool", tool_call_id: item.call_id, content: out });
    } else if (item.type === "reasoning") {
      // 推理过程不回放
    } else if (item.type === "message" || item.role) {
      const role = item.role === "system" ? "system" : item.role === "assistant" ? "assistant" : "user";
      let content = "";
      if (typeof item.content === "string") content = item.content;
      else if (Array.isArray(item.content)) {
        content = item.content
          .map((c) => (typeof c === "string" ? c : c.text || c.content || ""))
          .filter(Boolean)
          .join("\n");
      }
      messages.push({ role, content });
    }
  }
  flushToolCalls(pendingToolCalls);

  const chat = { model: r.model, messages, stream: !!r.stream };
  if (r.max_output_tokens) chat.max_tokens = r.max_output_tokens;
  if (r.temperature != null) chat.temperature = r.temperature;
  if (r.top_p != null) chat.top_p = r.top_p;
  if (Array.isArray(r.tools) && r.tools.length) {
    const tools = r.tools
      .filter((t) => t.type === "function")
      .map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description || "",
          parameters: t.parameters || { type: "object", properties: {} },
        },
      }));
    if (tools.length) chat.tools = tools;
  }
  if (r.tool_choice) {
    if (r.tool_choice === "auto" || r.tool_choice === "none") chat.tool_choice = r.tool_choice;
    else if (r.tool_choice.type === "function" && r.tool_choice.name) {
      chat.tool_choice = { type: "function", function: { name: r.tool_choice.name } };
    }
  }
  if (r.reasoning && r.reasoning.effort) chat.reasoning_effort = r.reasoning.effort;
  return chat;
}

// ---------------------------------------------------------------- Chat -> Responses 非流式翻译
function chatToResponse(c, model) {
  const choice = (c.choices && c.choices[0]) || {};
  const msg = choice.message || {};
  const output = [];
  let fullText = "";
  if (msg.content) {
    fullText = msg.content;
    output.push({
      type: "message", id: "msg_" + (c.id || Date.now()), role: "assistant", status: "completed",
      content: [{ type: "output_text", text: msg.content, annotations: [] }],
    });
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      output.push({
        type: "function_call",
        id: "fc_" + (tc.id || Math.random().toString(36).slice(2, 10)),
        call_id: tc.id || "call_" + Math.random().toString(36).slice(2, 10),
        name: tc.function && tc.function.name,
        arguments: (tc.function && tc.function.arguments) || "{}",
        status: "completed",
      });
    }
  }
  const u = c.usage || {};
  return {
    id: "resp_" + (c.id || Date.now()),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output,
    usage: {
      input_tokens: u.prompt_tokens || 0,
      output_tokens: u.completion_tokens || 0,
      total_tokens: u.total_tokens || 0,
      output_tokens_details: { reasoning_tokens: (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0 },
    },
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
  };
}

// ---------------------------------------------------------------- Chat -> Responses 流式翻译
function sseEvent(res, eventName, dataObj) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(dataObj)}\n\n`);
}

function translateChatStream(upstreamRes, clientRes, model) {
  clientRes.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const respId = "resp_" + Date.now();
  let started = false;
  let textOutputIndex = null;
  let nextOutputIndex = 0;
  const tools = new Map(); // chat tool index -> {outputIndex, itemId, callId, name, args}
  let fullText = "";
  let usage = null;
  let buf = "";

  const ensureStarted = () => {
    if (started) return;
    started = true;
    sseEvent(clientRes, "response.created", { type: "response.created", response: { id: respId, object: "response", created_at: Math.floor(Date.now() / 1000), status: "in_progress", model, output: [] } });
    sseEvent(clientRes, "response.in_progress", { type: "response.in_progress", response: { id: respId, status: "in_progress", model, output: [] } });
  };

  const finish = () => {
    if (!started) {
      // 上游什么都没给，也要给一个合法的 completed
      ensureStarted();
    }
    const output = [];
    if (textOutputIndex !== null) {
      output.push({ type: "message", id: "msg_" + respId, role: "assistant", status: "completed", content: [{ type: "output_text", text: fullText, annotations: [] }] });
      sseEvent(clientRes, "response.output_item.done", { type: "response.output_item.done", output_index: textOutputIndex, item: { type: "message", id: "msg_" + respId, role: "assistant", status: "completed", content: [{ type: "output_text", text: fullText, annotations: [] }] } });
    }
    for (const t of tools.values()) {
      output.push({ type: "function_call", id: t.itemId, call_id: t.callId, name: t.name, arguments: t.args, status: "completed" });
      sseEvent(clientRes, "response.output_item.done", { type: "response.output_item.done", output_index: t.outputIndex, item: { type: "function_call", id: t.itemId, call_id: t.callId, name: t.name, arguments: t.args, status: "completed" } });
    }
    sseEvent(clientRes, "response.completed", {
      type: "response.completed",
      response: {
        id: respId, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model, output,
        usage: usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0, output_tokens_details: { reasoning_tokens: 0 } },
      },
    });
    clientRes.end();
  };

  const handleChunk = (obj) => {
    if (obj.usage) usage = { input_tokens: obj.usage.prompt_tokens || 0, output_tokens: obj.usage.completion_tokens || 0, total_tokens: obj.usage.total_tokens || 0, output_tokens_details: { reasoning_tokens: (obj.usage.completion_tokens_details && obj.usage.completion_tokens_details.reasoning_tokens) || 0 } };
    const choice = obj.choices && obj.choices[0];
    if (!choice) return;
    const delta = choice.delta || {};

    if (delta.content) {
      ensureStarted();
      if (textOutputIndex === null) {
        textOutputIndex = nextOutputIndex++;
        sseEvent(clientRes, "response.output_item.added", { type: "response.output_item.added", output_index: textOutputIndex, item: { type: "message", id: "msg_" + respId, role: "assistant", content: [], status: "in_progress" } });
      }
      fullText += delta.content;
      sseEvent(clientRes, "response.output_text.delta", { type: "response.output_text.delta", item_id: "msg_" + respId, output_index: textOutputIndex, content_index: 0, delta: delta.content });
    }

    if (Array.isArray(delta.tool_calls)) {
      ensureStarted();
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        let t = tools.get(idx);
        if (!t) {
          t = { outputIndex: nextOutputIndex++, itemId: "fc_" + (tc.id || Math.random().toString(36).slice(2, 10)), callId: tc.id || "call_" + Math.random().toString(36).slice(2, 10), name: "", args: "" };
          tools.set(idx, t);
          sseEvent(clientRes, "response.output_item.added", { type: "response.output_item.added", output_index: t.outputIndex, item: { type: "function_call", id: t.itemId, call_id: t.callId, name: tc.function && tc.function.name, arguments: "", status: "in_progress" } });
        }
        if (tc.id && !t.callId.startsWith("call_")) t.callId = tc.id;
        if (tc.function && tc.function.name) t.name = tc.function.name;
        if (tc.function && tc.function.arguments) {
          t.args += tc.function.arguments;
          sseEvent(clientRes, "response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: t.itemId, output_index: t.outputIndex, delta: tc.function.arguments });
        }
      }
    }
  };

  const drain = () => {
    let sep;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const rawEvent = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const dataLines = rawEvent.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
      if (!dataLines.length) continue;
      const dataStr = dataLines.join("\n");
      if (dataStr === "[DONE]") { finish(); return; }
      try { handleChunk(JSON.parse(dataStr)); } catch { /* 忽略坏行 */ }
    }
  };

  upstreamRes.on("data", (chunk) => { buf += chunk.toString("utf8"); drain(); });
  upstreamRes.on("end", () => { finish(); });
  upstreamRes.on("error", () => { try { clientRes.end(); } catch { /* ignore */ } });
}

// ---------------------------------------------------------------- 主服务
const server = http.createServer(async (req, res) => {
  const url = req.url || "/";

  // 调试端点
  if (url === "/__routes") {
    const table = Object.entries(CFG.channels).map(([name, ch]) => ({
      channel: name, label: ch.label, wire: ch.wire, base: ch.base, match: ch.match,
      stripPrefix: ch.stripPrefix || null,
      keyFile: ch.keyFile || name,
      key_set: (() => { const k = resolveKey(name, ch); return !!(k && !k.includes("填入")); })(),
    }));
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ port: PORT, default: CFG.defaultChannel, channels: table }, null, 2));
  }

  // 读请求体
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const bodyBuf = Buffer.concat(chunks);

  let parsed = null;
  try { parsed = JSON.parse(bodyBuf.toString("utf8")); } catch { /* GET 或空体 */ }

  // 调试：把请求体摘要写进日志（只记字段名和长度，不记 prompt 原文）
  // 排查用：Codex 桌面端和 CLI 发的请求体不同，502 只在 GUI 出现时必须能看见差异。
  if (parsed && process.env.ROUTER_DEBUG_BODY === "1") {
    const summary = {
      bytes: bodyBuf.length,
      model: parsed.model,
      stream: parsed.stream,
      store: parsed.store,
      include: parsed.include,
      reasoning: parsed.reasoning,
      tool_count: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
      tool_types: Array.isArray(parsed.tools) ? [...new Set(parsed.tools.map((t) => t.type))] : [],
      instructions_len: typeof parsed.instructions === "string" ? parsed.instructions.length : 0,
      input_len: JSON.stringify(parsed.input || "").length,
      top_keys: Object.keys(parsed).sort(),
    };
    log(`[debug-body] ${JSON.stringify(summary)}`);

    // 保存完整 body 到临时文件，便于离线重放定位 502
    if (process.env.ROUTER_SAVE_BODY === "1") {
      try {
        const p = path.join(os.tmpdir(), "router-last-request.json");
        fs.writeFileSync(p, bodyBuf);
        log(`[debug-body] 完整请求体已保存: ${p}`);
      } catch (e) {
        log(`[debug-body] 保存请求体失败: ${e.message}`);
      }
    }
  }

  // /models 聚合端点（Codex 一般用不到，留着方便排查）
  if (req.method === "GET" && url.replace(/^\/v1/, "") === "/models") {
    const data = [];
    for (const [, ch] of Object.entries(CFG.channels)) {
      for (const m of ch.models || []) data.push({ id: m, object: "model", owned_by: "router", created: Math.floor(Date.now() / 1000) });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data }));
  }

  const model = parsed && parsed.model;
  const picked = pickChannel(model);
  const channelName = picked ? picked.name : CFG.defaultChannel;
  const channel = CFG.channels[channelName];

  if (!channel) {
    res.writeHead(500, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "路由器未配置任何渠道", type: "router_error" } }));
  }

  const apiKey = resolveKey(channelName, channel);

  // 未填 key 的渠道给出明确报错
  if (!apiKey || apiKey.includes("填入")) {
    log(`[${channelName}] 渠道未配置 API Key，拒绝请求 model=${model}`);
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: `渠道 ${channel.label} 未配置 API Key：请用记事本打开 ${path.join(__dirname, "keys", (channel.keyFile || channelName) + ".txt")}，粘贴 sk- 开头的 key，保存后即时生效`, type: "router_error" } }));
  }

  // 客户端侧模型名 -> 上游真实模型名（去掉 4z- 之类的前缀）
  const upstreamModel = upstreamModelName(model, channel);

  log(`${req.method} ${url} model=${model}${upstreamModel !== model ? ` -> 上游 ${upstreamModel}` : ""} -> ${channelName} (${channel.wire})`);

  try {
    if (channel.wire === "responses") {
      // ---- 透传模式 ----
      const target = channel.base.replace(/\/+$/, "") + "/responses";
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        Accept: "text/event-stream",
      };
      // 需要改写模型名时，重建请求体
      let outBody = bodyBuf;
      if (upstreamModel !== model && parsed) {
        try {
          const b = { ...parsed, model: upstreamModel };
          outBody = Buffer.from(JSON.stringify(b));
        } catch (e) {
          log(`[${channelName}] 重建请求体失败: ${e.message}`);
        }
      }
      const upstream = await sendUpstream(target, { method: "POST", headers }, outBody, channel);
      const respHeaders = { ...upstream.headers };
      delete respHeaders["content-encoding"]; // Node 已自动解压
      delete respHeaders["content-length"];
      delete respHeaders["transfer-encoding"];

      // 上游返回非 2xx 时，把状态码和响应体记进日志。
      // 排查用：客户端只会看到「502 Bad Gateway / content-length: 0」，
      // 真实原因（如上游限流、空响应）只有在这里才看得见。
      const upStatus = upstream.statusCode || 502;
      if (process.env.ROUTER_DEBUG_BODY === "1") {
        log(`[debug-upstream] status=${upstream.statusCode} headers=${JSON.stringify(upstream.headers).slice(0, 400)}`);
      }
      if (upStatus >= 400) {
        const errChunks = [];
        upstream.on("data", (c) => { if (errChunks.length < 32) errChunks.push(c); });
        upstream.on("end", () => {
          const t = Buffer.concat(errChunks).toString("utf8");
          log(`[${channelName}] 上游返回 ${upStatus} | body: ${t.slice(0, 500) || "(空)"}`);
        });
        upstream.on("error", (e) => log(`[${channelName}] 上游流错误: ${e.message}`));
      }

      res.writeHead(upStatus, respHeaders);
      upstream.pipe(res);
      upstream.on("error", (e) => { log(`上游流错误(${channelName}): ${e.message}`); try { res.end(); } catch { /* ignore */ } });
    } else {
      // ---- chat 翻译模式 ----
      // 翻译时用上游真实模型名，回给客户端时仍用客户端侧的名字
      const chatInput = upstreamModel !== model && parsed ? { ...parsed, model: upstreamModel } : parsed;
      const chatBody = responsesToChat(chatInput);
      const target = channel.base.replace(/\/+$/, "") + "/chat/completions";
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        Accept: "text/event-stream",
      };
      const upstream = await sendUpstream(target, { method: "POST", headers }, Buffer.from(JSON.stringify(chatBody)), channel);
      const status = upstream.statusCode || 502;
      if (status !== 200) {
        // 上游报错原样透传（带上状态码，方便定位）
        const errChunks = [];
        for await (const c of upstream) errChunks.push(c);
        const errText = Buffer.concat(errChunks).toString("utf8");
        log(`[${channelName}] 上游错误 ${status}: ${errText.slice(0, 300)}`);
        res.writeHead(status, { "Content-Type": "application/json" });
        return res.end(errText);
      }
      if (parsed.stream) {
        translateChatStream(upstream, res, model);
      } else {
        const outChunks = [];
        for await (const c of upstream) outChunks.push(c);
        let chatJson;
        try { chatJson = JSON.parse(Buffer.concat(outChunks).toString("utf8")); }
        catch (e) {
          res.writeHead(502, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: { message: "上游返回无法解析: " + e.message, type: "router_error" } }));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(chatToResponse(chatJson, model)));
      }
    }
  } catch (err) {
    log(`请求失败 model=${model} -> ${channelName}: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: `路由器转发失败: ${err.message}`, type: "router_error" } }));
    } else {
      try { res.end(); } catch { /* ignore */ }
    }
  }
});

server.listen(PORT, "127.0.0.1", () => {
  log(`==================================================`);
  log(`Codex 模型路由器已启动:  http://127.0.0.1:${PORT}/v1`);
  log(`路由表查看:              http://127.0.0.1:${PORT}/__routes`);
  log(`渠道: ${Object.entries(CFG.channels).map(([n, c]) => `${n}(${c.wire})`).join("  ")}`);
  log(`==================================================`);
});

// 开机自启可能有多条路径（计划任务 + 启动文件夹快捷脚本）同时拉起本服务。
// 端口已被占用说明另一个实例正在正常工作：安静退出，别打印堆栈，
// 也别让计划任务的“失败重启”策略每分钟重试一次。
server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    log(`端口 ${PORT} 已被占用，已有路由器实例在运行，本实例退出。`);
    process.exit(0);
  }
  log(`服务启动失败: ${err && err.message ? err.message : String(err)}`);
  process.exit(1);
});
