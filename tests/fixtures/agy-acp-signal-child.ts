import path from "node:path";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { getSharedAcpClient, setAcpLaunchForTests } from "../../src/agy-acp";

const root = mkdtempSync(path.join(tmpdir(), "agy-test-gemini-"));
const user = path.join(root, "user-gemini");
mkdirSync(user, { recursive: true });
process.env.OPENCODE_AGY_OVERLAY_DIR = path.join(root, "overlay");
process.env.OPENCODE_AGY_USER_GEMINI_DIR = user;

const fake = path.resolve(import.meta.dir, "../fake-agy-acp.mjs");
setAcpLaunchForTests({
  command: process.execPath,
  argv: [fake],
  env: { FAKE_ACP_MODE: "ok" },
});
await getSharedAcpClient({ cwd: path.resolve(import.meta.dir, "..") });
process.stdout.write("ready\n");
// Stay alive until a signal arrives.
await new Promise(() => {});
