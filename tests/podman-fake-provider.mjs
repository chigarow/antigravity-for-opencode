import { createServer } from "node:http";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

const captureDir = process.env.CAPTURE_DIR;
const mode = process.env.PROVIDER_MODE ?? "normal";
const port = Number.parseInt(process.env.PROVIDER_PORT ?? "8787", 10);

if (!captureDir) {
  process.stderr.write("CAPTURE_DIR is required\n");
  process.exit(1);
}

await mkdir(captureDir, { recursive: true });
let sequence = 0;

const readBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const sendCompletion = (response, requestBody) => {
  const model = typeof requestBody?.model === "string" ? requestBody.model : "harness";
  const id = `chatcmpl-harness-${sequence}`;
  if (requestBody?.stream === true) {
    response.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "HARNESS_OK" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "HARNESS_OK" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
};

const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "unexpected endpoint" } }));
    return;
  }

  let parsed;
  try {
    const raw = await readBody(request);
    parsed = JSON.parse(raw);
  } catch (error) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: `malformed request body: ${error.message}` } }));
    return;
  }

  sequence += 1;
  const seqStr = String(sequence).padStart(4, "0");
  const captureFile = join(captureDir, `capture-${seqStr}.json`);

  try {
    await writeFile(captureFile, `${JSON.stringify(parsed, null, 2)}\n`);
    await appendFile(join(captureDir, "requests.log"), `${new Date().toISOString()} capture-${seqStr}\n`);
  } catch (error) {
    process.stderr.write(`failed to write capture: ${error.message}\n`);
  }

  if (mode === "unexpected") {
    try {
      await writeFile(join(captureDir, "unexpected-capture.json"), `${JSON.stringify(parsed, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`failed to write unexpected capture: ${error.message}\n`);
    }
  }

  if (mode === "timeout") {
    return;
  }

  sendCompletion(response, parsed);
});

server.on("error", (error) => {
  process.stderr.write(`server error: ${error.message}\n`);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  process.stderr.write(`uncaught exception: ${error.message}\n`);
});

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`unhandled rejection: ${String(reason)}\n`);
});

server.listen(port, "0.0.0.0", async () => {
  try {
    await writeFile(join(captureDir, "ready"), `${port}\n`);
  } catch (error) {
    process.stderr.write(`failed to write ready signal: ${error.message}\n`);
    process.exit(1);
  }
});

const stop = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
