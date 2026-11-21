#!/usr/bin/env node
/**
 * Minimal NDJSON JSON-RPC ACP stand-in for unit tests.
 * Modes via FAKE_ACP_MODE:
 *   ok | crash-on-start | fail-after-sent | hang-start
 *   hang-session-new | hang-set-config | hang-prompt | hang-close
 *   permission | permission-no-allow | flood | chunks-then-fail
 */
import { appendFileSync } from "node:fs";
import { stdin as stdinStream, stdout as stdoutStream } from "node:process";

const mode = process.env.FAKE_ACP_MODE || "ok";
const eventFile = process.env.FAKE_ACP_EVENT_FILE;

if (mode === "crash-on-start") {
  console.error("fake acp refusing to start");
  process.exit(1);
}

let buf = "";
let sessions = 0;
const pendingPermission = new Map();

function logEvent(event) {
  if (!eventFile) return;
  try {
    appendFileSync(eventFile, JSON.stringify(event) + "\n");
  } catch {
    // ignore
  }
}

function send(msg) {
  stdoutStream.write(JSON.stringify(msg) + "\n");
}

function sessionResult(sessionId) {
  return {
    sessionId,
    configOptions: [
      {
        id: "model",
        currentValue: "gemini-3.8-flash",
        options: [
          { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
          { value: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
        ],
      },
      {
        id: "thought_level",
        currentValue: "medium",
        options: [{ value: "low" }, { value: "medium" }, { value: "high" }],
      },
    ],
  };
}

function sendChunk(sessionId, text) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        sessionId,
        content: { type: "text", text },
      },
    },
  });
}

function permissionOptions(noAllow) {
  const options = [
    { optionId: "reject-once", kind: "reject_once", name: "Reject" },
    { optionId: "reject-always", kind: "reject_always", name: "Reject always" },
  ];
  if (!noAllow) {
    options.push(
      { optionId: "allow-once", kind: "allow_once", name: "Allow" },
      { optionId: "allow-always", kind: "allow_always", name: "Allow always" }
    );
  }
  return options;
}

function handleResponse(msg) {
  const pending = pendingPermission.get(msg.id);
  if (!pending) return;
  pendingPermission.delete(msg.id);
  logEvent({ type: "permission-result", id: msg.id, result: msg.result, error: msg.error });
  const sessionId = pending.sessionId;
  const requestId = pending.requestId;
  sendChunk(sessionId, JSON.stringify(msg.result ?? msg.error ?? {}));
  send({ jsonrpc: "2.0", id: requestId, result: { stopReason: "end_turn" } });
}

function handle(msg) {
  if (!msg || typeof msg !== "object") return;
  if (typeof msg.id !== "undefined" && !msg.method) {
    handleResponse(msg);
    return;
  }
  const { id, method, params } = msg;
  logEvent({ type: "request", method, id, params });
  if (method === "initialize") {
    if (mode === "hang-start") return;
    send({
      jsonrpc: "2.0",
      id,
      result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "fake-agy-acp" } },
    });
    return;
  }
  if (method === "session/new") {
    if (mode === "hang-session-new") return;
    sessions += 1;
    const sessionId = `ses_fake_${sessions}`;
    send({ jsonrpc: "2.0", id, result: sessionResult(sessionId) });
    return;
  }
  if (method === "session/set_config_option") {
    if (mode === "hang-set-config") return;
    send({
      jsonrpc: "2.0",
      id,
      result: {
        configOptions: [
          {
            id: "thought_level",
            currentValue: params?.configId === "thought_level" ? params?.value : "medium",
            options: [{ value: "low" }, { value: "medium" }, { value: "high" }],
          },
        ],
      },
    });
    return;
  }
  if (method === "session/prompt") {
    const sessionId = params?.sessionId;
    if (mode === "hang-prompt") return;
    if (mode === "fail-after-sent") {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: "quota exceeded: resource exhausted" },
      });
      return;
    }
    if (mode === "chunks-then-fail") {
      sessions; // keep counter
      if (!globalThis.__agyFailCount) globalThis.__agyFailCount = 0;
      globalThis.__agyFailCount += 1;
      if (globalThis.__agyFailCount === 1) {
        sendChunk(sessionId, "LEAKED_CHUNK");
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: "quota exceeded: resource exhausted" },
        });
        return;
      }
      sendChunk(sessionId, "ok");
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
      return;
    }
    if (mode === "flood") {
      sendChunk(sessionId, "F".repeat(150_000));
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
      return;
    }
    if (mode === "permission" || mode === "permission-no-allow") {
      const permId = `perm_${sessions}_${id}`;
      pendingPermission.set(permId, { sessionId, requestId: id });
      send({
        jsonrpc: "2.0",
        id: permId,
        method: "session/request_permission",
        params: {
          sessionId,
          options: permissionOptions(mode === "permission-no-allow"),
        },
      });
      return;
    }
    sendChunk(sessionId, "ok");
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }
  if (method === "session/close") {
    logEvent({ type: "close", sessionId: params?.sessionId });
    if (mode === "hang-close") return;
    if (typeof id !== "undefined") send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "session/cancel") {
    logEvent({ type: "cancel", sessionId: params?.sessionId });
    if (typeof id !== "undefined") send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (typeof id !== "undefined") {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
  }
}

stdinStream.setEncoding("utf8");
stdinStream.on("data", (chunk) => {
  buf += chunk;
  for (;;) {
    const nl = buf.indexOf("\n");
    if (nl < 0) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // ignore malformed
    }
  }
});
