/** Runtime switches for the persistent ACP path and pre-warm. */

export function runningUnderBunTest(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv
): boolean {
  if (env.BUN_TEST === "1") return true;
  return argv.includes("test") && argv.some((a) => /(^|\/)bun(\.exe)?$/.test(a) || a.includes("bun-test"));
}

export function isAcpEnabled(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): boolean {
  if (env.OPENCODE_AGY_ACP === "0" || env.OPENCODE_AGY_FORCE_PRINT === "1") return false;
  // Unit tests stay on the --print path unless they opt in with OPENCODE_AGY_ACP=1.
  if (runningUnderBunTest(env, argv) && env.OPENCODE_AGY_ACP !== "1") return false;
  return true;
}
