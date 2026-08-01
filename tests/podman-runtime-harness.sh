#!/usr/bin/env bash
# Explicit Podman proof harness. Intentionally named outside Bun's *.test.* discovery.
set -Eeuo pipefail

readonly IMAGE="docker.io/library/node:22-bookworm-slim"
readonly LABEL_KEY="io.opencode-agy.harness.run"
readonly DEFAULT_SCENARIO="all"

usage() {
  cat >&2 <<'EOF'
Usage:
  podman-runtime-harness.sh --version VERSION --tarball FILE --evidence-dir DIR
    [--expected-outcome pass|fail] [--candidate-version VERSION]
    [--candidate-name NAME] [--candidate-sha256 SHA256]
    [--scenario all|positive|missing|override]
    [--provider-mode normal|timeout|unreachable|unexpected|extra|readiness-timeout]
    [--timeout SECONDS]

The harness is explicit: it never runs from `bun test`.
EOF
}

version=""
tarball=""
evidence_dir=""
evidence_dir_given=0
expected_outcome="pass"
candidate_version=""
requested_candidate_version=""
candidate_name_expected="opencode-agy"
candidate_sha256_expected=""
scenario="$DEFAULT_SCENARIO"
provider_mode="normal"
timeout_seconds=60
parse_error_code=""
parse_error_message=""

record_parse_error() {
  if [[ -z "$parse_error_code" ]]; then
    parse_error_code="$1"
    parse_error_message="$2"
  fi
}

while (($# > 0)); do
  case "$1" in
    --version)
      if (($# < 2)) || [[ "$2" == --* ]]; then
        record_parse_error "MISSING_VERSION" "missing value for --version"
        shift
      else
        version="$2"
        shift 2
      fi
      ;;
    --tarball)
      if (($# < 2)) || [[ "$2" == --* ]]; then
        record_parse_error "MISSING_TARBALL" "missing value for --tarball"
        shift
      else
        tarball="$2"
        shift 2
      fi
      ;;
    --evidence-dir)
      if (($# < 2)) || [[ "$2" == --* ]]; then
        record_parse_error "MISSING_EVIDENCE_DIR" "missing value for --evidence-dir"
        shift
      else
        evidence_dir="$2"
        evidence_dir_given=1
        shift 2
      fi
      ;;
    --expected-outcome|--expected)
      if (($# < 2)) || [[ "$2" == --* ]]; then
        record_parse_error "MISSING_EXPECTED_OUTCOME" "missing value for expected outcome"
        shift
      else
        expected_outcome="$2"
        shift 2
      fi
      ;;
    --candidate-version)
      if (($# < 2)) || [[ "$2" == --* ]]; then
        record_parse_error "MISSING_CANDIDATE_VERSION" "missing value for --candidate-version"
        shift
      else
        candidate_version="$2"
        requested_candidate_version="$2"
        shift 2
      fi
      ;;
    --candidate-name)
      if (($# < 2)) || [[ "$2" == --* ]]; then
        record_parse_error "MISSING_CANDIDATE_NAME" "missing value for --candidate-name"
        shift
      else
        candidate_name_expected="$2"
        shift 2
      fi
      ;;
    --candidate-sha256)
      if (($# < 2)) || [[ "$2" == --* ]]; then
        record_parse_error "MISSING_CANDIDATE_SHA256" "missing value for --candidate-sha256"
        shift
      else
        candidate_sha256_expected="$2"
        shift 2
      fi
      ;;
    --scenario)
      if (($# < 2)) || [[ "$2" == --* ]]; then
        record_parse_error "MISSING_SCENARIO" "missing value for --scenario"
        shift
      else
        scenario="$2"
        shift 2
      fi
      ;;
    --provider-mode)
      if (($# < 2)) || [[ "$2" == --* ]]; then
        record_parse_error "MISSING_PROVIDER_MODE" "missing value for --provider-mode"
        shift
      else
        provider_mode="$2"
        shift 2
      fi
      ;;
    --timeout)
      if (($# < 2)) || [[ "$2" == --* ]]; then
        record_parse_error "MISSING_TIMEOUT" "missing value for --timeout"
        shift
      else
        timeout_seconds="$2"
        shift 2
      fi
      ;;
    --help|-h)
      usage >&1
      exit 0
      ;;
    *)
      record_parse_error "UNEXPECTED_ARGUMENT" "unexpected argument: $1"
      shift
      ;;
  esac
done

if [[ "$evidence_dir_given" != 1 ]]; then
  printf '%s\n' "--evidence-dir is required; no evidence target was created" >&2
  usage
  exit 2
fi
if [[ -z "$evidence_dir" ]]; then
  printf '%s\n' "--evidence-dir must not be empty; no evidence target was created" >&2
  usage
  exit 2
fi

if ! mkdir -p "$evidence_dir" 2>/dev/null; then
  printf 'unable to create evidence directory: %s\n' "$evidence_dir" >&2
  exit 2
fi
if ! evidence_dir="$(cd "$evidence_dir" && pwd -P)"; then
  printf 'unable to canonicalize evidence directory: %s\n' "$evidence_dir" >&2
  exit 2
fi

run_id="$(date -u +%Y%m%d%H%M%S)-$$-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
run_dir="$evidence_dir/run-$run_id"
mkdir "$run_dir"
stage_dir=""
capture_dir=""
run_evidence_dir="$run_dir/runtime-evidence"
cleanup_file="$run_dir/cleanup.json"
summary_file="$run_dir/summary.json"
mkdir "$run_evidence_dir"

network_name="agy-harness-net-$run_id"
fake_name="agy-harness-fake-$run_id"
runtime_name="agy-harness-runtime-$run_id"
provider_alias="fake-provider-$run_id"
network_created=0
fake_created=0
runtime_created=0
podman_available=0
actual_status=2
actual_outcome="fail"
failure_code="PREFLIGHT"
failure_reason="harness has not completed preflight"
observed_failure_code=""
observed_failure_reason=""
harness_exit_code=2
host_arch=""
podman_arch=""
container_arch=""
candidate_version_actual=""
candidate_name_actual=""
candidate_package_path=""
tarball_sha256=""
identity_complete=false

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# shellcheck disable=SC2329
write_cleanup() {
  local containers_before=""
  local containers_after=""
  local networks_after=""
  local stage_removed=false
  local zero_labeled_resources=false
  local cleanup_verification="podman unavailable"
  set +e
  if [[ "$podman_available" == 1 ]] && command -v podman >/dev/null 2>&1; then
    containers_before="$(podman ps -aq --filter "label=${LABEL_KEY}=${run_id}" 2>&1)"
    if [[ -n "$containers_before" ]]; then
      while IFS= read -r container_id; do
        [[ -n "$container_id" ]] && podman rm --force "$container_id" >>"$run_dir/cleanup.log" 2>&1
      done <<< "$containers_before"
    fi
    if [[ "$network_created" == 1 ]] && podman network inspect "$network_name" >"$run_dir/network-cleanup-inspect.json" 2>&1; then
      if jq -e --arg key "$LABEL_KEY" --arg value "$run_id" '.[0].labels[$key] == $value' "$run_dir/network-cleanup-inspect.json" >/dev/null 2>&1; then
        podman network rm "$network_name" >>"$run_dir/cleanup.log" 2>&1
      fi
    fi
    containers_after="$(podman ps -aq --filter "label=${LABEL_KEY}=${run_id}" 2>&1)"
    networks_after="$(podman network ls -q --filter "label=${LABEL_KEY}=${run_id}" 2>&1)"
    cleanup_verification="Podman label-scoped audit"
    [[ -z "$containers_after" && -z "$networks_after" ]] && zero_labeled_resources=true
  else
    zero_labeled_resources=true
  fi
  if [[ -n "$stage_dir" ]]; then
    rm -rf -- "$stage_dir"
    [[ ! -e "$stage_dir" ]] && stage_removed=true
  else
    stage_removed=true
  fi
  jq -n \
    --arg before "$containers_before" \
    --arg after "$containers_after" \
    --arg networksAfter "$networks_after" \
    --arg verification "$cleanup_verification" \
    --argjson stageRemoved "$stage_removed" \
    --argjson zeroLabeledResources "$zero_labeled_resources" \
    --argjson resourcesCreated "$(jq -n --argjson network "$network_created" --argjson fake "$fake_created" --argjson runtime "$runtime_created" '{network:($network == 1),fakeContainer:($fake == 1),runtimeContainer:($runtime == 1)}')" \
    '{resourcesCreated:$resourcesCreated,containersBefore:$before,containersAfter:$after,networksAfter:$networksAfter,stageRemoved:$stageRemoved,zeroLabeledResources:$zeroLabeledResources,verification:$verification,cleanupLog:"cleanup.log"}' \
    >"$cleanup_file"
  set -e
}

# shellcheck disable=SC2329
write_evidence_index() {
  local index_file="$run_dir/evidence-index.json"
  node - "$run_dir" "$index_file" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const files = [];
const invalid = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (full === output) continue;
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    const relative = path.relative(root, full);
    const stat = fs.statSync(full);
    if (stat.size === 0) {
      invalid.push({ path: relative, reason: "zero-byte" });
      continue;
    }
    if (entry.name.endsWith(".json")) {
      try {
        JSON.parse(fs.readFileSync(full, "utf8"));
      } catch (error) {
        invalid.push({ path: relative, reason: `invalid-json:${error.message}` });
        continue;
      }
    }
    if (entry.name.endsWith(".jsonl")) {
      const lines = fs.readFileSync(full, "utf8").trim().split("\n").filter(Boolean);
      try {
        lines.forEach((line) => JSON.parse(line));
      } catch (error) {
        invalid.push({ path: relative, reason: `invalid-jsonl:${error.message}` });
        continue;
      }
    }
    files.push(relative);
  }
};
walk(root);
fs.writeFileSync(output, `${JSON.stringify({ files: files.sort(), invalid }, null, 2)}\n`);
if (invalid.length > 0) process.exitCode = 1;
NODE
}

# shellcheck disable=SC2329
write_summary() {
  local cleanup_json='{}'
  local files_json='[]'
  [[ -s "$cleanup_file" ]] && cleanup_json="$(<"$cleanup_file")"
  [[ -s "$run_dir/evidence-index.json" ]] && files_json="$(jq -c '.files' "$run_dir/evidence-index.json" 2>/dev/null || printf '[]')"
  jq -n \
    --arg runId "$run_id" \
    --arg status "$actual_outcome" \
    --arg observedFailureCode "$observed_failure_code" \
    --arg observedFailureReason "$observed_failure_reason" \
    --arg failureCode "$failure_code" \
    --arg failureReason "$failure_reason" \
    --arg expected "$expected_outcome" \
    --arg version "$version" \
    --arg candidateVersion "$candidate_version_actual" \
    --arg requestedCandidateVersion "$requested_candidate_version" \
    --arg candidateName "$candidate_name_actual" \
    --arg requestedCandidateName "$candidate_name_expected" \
    --arg candidatePath "$candidate_package_path" \
    --arg tarball "$tarball" \
    --arg sha256 "$tarball_sha256" \
    --arg expectedSha256 "$candidate_sha256_expected" \
    --arg arch "$container_arch" \
    --arg hostArch "$host_arch" \
    --arg podmanArch "$podman_arch" \
    --arg scenario "$scenario" \
    --arg providerMode "$provider_mode" \
    --arg evidenceDir "$run_dir" \
    --argjson observedExitCode "$actual_status" \
    --argjson harnessExitCode "$harness_exit_code" \
    --argjson identityComplete "$identity_complete" \
    --argjson cleanup "$cleanup_json" \
    --argjson files "$files_json" \
    '{runId:$runId,status:$status,observedExitCode:$observedExitCode,harnessExitCode:$harnessExitCode,expectedOutcome:$expected,expectedOutcomeSatisfied:(($expected == "pass" and $status == "pass") or ($expected == "fail" and $status == "fail")),outcomeComparison:{observed:$status,expected:$expected,satisfied:(($expected == "pass" and $status == "pass") or ($expected == "fail" and $status == "fail"))},observedFailureCode:$observedFailureCode,observedFailureReason:$observedFailureReason,failureCode:$failureCode,failureReason:$failureReason,opencodeVersion:$version,candidate:{packageName:$candidateName,requestedPackageName:$requestedCandidateName,packageVersion:$candidateVersion,requestedPackageVersion:$requestedCandidateVersion,packagePath:$candidatePath,tarball:$tarball,sha256:$sha256,expectedSha256:$expectedSha256},platform:{hostArch:$hostArch,podmanArch:$podmanArch,containerArch:$arch},identityComplete:$identityComplete,scenario:$scenario,providerMode:$providerMode,evidenceDir:$evidenceDir,rawStderrFiles:["opencode-install.stderr","opencode-version.stderr","runtime-launch.stderr","fake-server.log"],safetyClassification:{promptInjection:"Candidate archive and Markdown are untrusted data; only extracted dist/index.js is configured, and commands/agy.md is deleted before runtime dispatch.",networkPartition:"The fake provider is reachable only on the run-labeled Podman network; unreachable mode uses container loopback, with no host networking or provider credentials."},cleanup:$cleanup,files:$files}' >"$summary_file.tmp"
  mv "$summary_file.tmp" "$summary_file"
}

# shellcheck disable=SC2329
cleanup() {
  local trap_status=$?
  set +e
  if [[ "$trap_status" != 0 && -z "$observed_failure_code" ]]; then
    actual_status="$trap_status"
    actual_outcome="fail"
    observed_failure_code="${failure_code:-HARNESS_EXIT}"
    observed_failure_reason="${failure_reason:-harness exited with code $trap_status}"
    if [[ "$trap_status" == 130 || "$trap_status" == 143 ]]; then
      observed_failure_code="INTERRUPTED"
      observed_failure_reason="harness interrupted by signal"
      failure_code="INTERRUPTED"
      failure_reason="$observed_failure_reason"
    fi
  fi
  if [[ -n "$stage_dir" && -d "$stage_dir" ]]; then
    mkdir -p "$run_dir/provider-captures"
    cp -R "$stage_dir/captures/." "$run_dir/provider-captures/" 2>/dev/null || true
    cp -R "$stage_dir/evidence/." "$run_dir/" 2>/dev/null || true
  fi
  if [[ -n "$run_dir" ]]; then
    write_cleanup
    write_evidence_index >/dev/null 2>&1 || true
    if [[ "$trap_status" == 0 ]] && ! jq -e '.zeroLabeledResources == true and .stageRemoved == true' "$cleanup_file" >/dev/null 2>&1; then
      actual_status=1
      actual_outcome="fail"
      observed_failure_code="CLEANUP_FAILURE"
      observed_failure_reason="scoped cleanup left a labeled resource or stage directory"
      failure_code="$observed_failure_code"
      failure_reason="$observed_failure_reason"
      harness_exit_code=1
      trap_status=1
    fi
    write_summary
  fi
  trap - EXIT
  exit "$trap_status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if ! command -v jq >/dev/null 2>&1; then
  failure_code="PREFLIGHT_TOOL_MISSING"
  failure_reason="required command is missing: jq"
  printf '%s\n' "$failure_reason" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  failure_code="PREFLIGHT_TOOL_MISSING"
  failure_reason="required command is missing: node"
  printf '%s\n' "$failure_reason" >&2
  exit 2
fi
if ! command -v tar >/dev/null 2>&1; then
  failure_code="PREFLIGHT_TOOL_MISSING"
  failure_reason="required command is missing: tar"
  printf '%s\n' "$failure_reason" >&2
  exit 2
fi
if ! command -v podman >/dev/null 2>&1; then
  podman_available=0
  failure_code="PREFLIGHT_TOOL_MISSING"
  failure_reason="required command is missing: podman"
  printf '%s\n' "$failure_reason" >&2
  exit 2
fi
podman_available=1

if [[ -n "$parse_error_code" ]]; then
  failure_code="$parse_error_code"
  failure_reason="$parse_error_message"
  printf '%s\n' "$failure_reason" >&2
  usage
  exit 2
fi

is_semver() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; }
is_positive_integer() { [[ "$1" =~ ^[1-9][0-9]*$ ]]; }
is_sha256() { [[ "$1" =~ ^[0-9a-fA-F]{64}$ ]]; }
normalize_arch() {
  case "$1" in
    amd64|x86_64) printf '%s' amd64 ;;
    arm64|aarch64) printf '%s' arm64 ;;
    *) return 1 ;;
  esac
}

if ! is_semver "$version"; then
  failure_code="INVALID_OPENCODE_VERSION"
  failure_reason="--version must be an exact numeric semver; ranges/latest are rejected"
  printf '%s\n' "$failure_reason" >&2
  exit 2
fi
if [[ -n "$candidate_version" ]] && ! is_semver "$candidate_version"; then
  failure_code="INVALID_CANDIDATE_VERSION"
  failure_reason="--candidate-version must be an exact numeric semver"
  printf '%s\n' "$failure_reason" >&2
  exit 2
fi
if [[ -n "$candidate_sha256_expected" ]] && ! is_sha256 "$candidate_sha256_expected"; then
  failure_code="INVALID_CANDIDATE_SHA256"
  failure_reason="--candidate-sha256 must be exactly 64 hexadecimal characters"
  printf '%s\n' "$failure_reason" >&2
  exit 2
fi
case "$expected_outcome" in
  success) expected_outcome="pass" ;;
  failure) expected_outcome="fail" ;;
esac
case "$expected_outcome" in pass|fail) ;; *) failure_code="INVALID_EXPECTED_OUTCOME"; failure_reason="expected outcome must be pass or fail"; printf '%s\n' "$failure_reason" >&2; exit 2 ;; esac
case "$scenario" in all|positive|missing|override) ;; *) failure_code="INVALID_SCENARIO"; failure_reason="unknown scenario: $scenario"; printf '%s\n' "$failure_reason" >&2; exit 2 ;; esac
case "$provider_mode" in normal|timeout|unreachable|unexpected|extra|readiness-timeout) ;; *) failure_code="INVALID_PROVIDER_MODE"; failure_reason="unknown provider mode: $provider_mode"; printf '%s\n' "$failure_reason" >&2; exit 2 ;; esac
if ! is_positive_integer "$timeout_seconds"; then
  failure_code="INVALID_TIMEOUT"
  failure_reason="--timeout must be a positive integer"
  printf '%s\n' "$failure_reason" >&2
  exit 2
fi
if [[ ! -f "$tarball" || ! -r "$tarball" || ! -s "$tarball" ]]; then
  failure_code="MISSING_TARBALL"
  failure_reason="candidate tarball is missing, unreadable, or empty: $tarball"
  printf '%s\n' "$failure_reason" >&2
  exit 2
fi
if ! tarball="$(cd "$(dirname "$tarball")" && pwd -P)/$(basename "$tarball")"; then
  failure_code="INVALID_TARBALL_PATH"
  failure_reason="candidate tarball path cannot be canonicalized"
  printf '%s\n' "$failure_reason" >&2
  exit 2
fi

host_arch="$(uname -m)"
podman_arch="$(podman info --format '{{.Host.Arch}}' 2>"$run_dir/podman-info.stderr" || true)"
if [[ -z "$host_arch" || -z "$podman_arch" ]]; then
  failure_code="IDENTITY_MISSING"
  failure_reason="host or Podman architecture identity is unavailable"
  printf '%s\n' "$failure_reason" >&2
  exit 2
fi
if ! container_arch="$(normalize_arch "$podman_arch")"; then
  failure_code="UNSUPPORTED_ARCHITECTURE"
  failure_reason="unsupported Podman architecture: $podman_arch"
  printf '%s\n' "$failure_reason" >&2
  exit 2
fi
{
  printf 'run_id=%s\n' "$run_id"
  printf 'date_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'uname=%s\n' "$(uname -a)"
  printf 'host_arch=%s\n' "$host_arch"
  printf 'podman_arch=%s\n' "$podman_arch"
  printf 'podman_version='; podman --version
  podman info 2>&1
} >"$run_dir/host-identity.txt"

if ! tar -tzf "$tarball" >"$run_dir/tar-list.txt" 2>"$run_dir/tar-error.log"; then
  failure_code="INVALID_TARBALL"
  failure_reason="candidate is not a readable gzip tarball"
  printf '%s\n' "$failure_reason" >&2
  exit 2
fi

if ! node - "$tarball" >"$run_dir/archive-validation.json" 2>"$run_dir/archive-validation.stderr" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const archive = process.argv[2];
const bytes = zlib.gunzipSync(fs.readFileSync(archive));
const entries = [];
const seen = new Set();
const readField = (buffer, offset, length) => buffer.subarray(offset, offset + length).toString("utf8").replace(/\0.*$/s, "");
const readOctal = (buffer, offset, length) => {
  const value = readField(buffer, offset, length).trim().replace(/\0/g, "");
  return value === "" ? 0 : Number.parseInt(value, 8);
};
const fail = (message) => { throw new Error(message); };
const canonicalName = (name, type) => {
  if (name.length === 0 || name.startsWith("/") || name.includes("\\") || name.includes("\0")) fail(`unsafe member path: ${JSON.stringify(name)}`);
  const parts = name.split("/");
  const trailingSlash = type === "5" && name.endsWith("/");
  const meaningful = trailingSlash ? parts.slice(0, -1) : parts;
  if (meaningful.some((part) => part === "" || part === "." || part === "..")) fail(`non-canonical member path: ${JSON.stringify(name)}`);
  if (meaningful[0] !== "package") fail(`member outside package root: ${JSON.stringify(name)}`);
  const normalized = path.posix.normalize(name);
  const expected = trailingSlash && !normalized.endsWith("/") ? `${normalized}/` : normalized;
  if (name !== expected) fail(`security-ambiguous member path: ${JSON.stringify(name)}`);
  return trailingSlash ? normalized : normalized;
};
let offset = 0;
let ended = false;
while (offset + 512 <= bytes.length) {
  const header = bytes.subarray(offset, offset + 512);
  if (header.every((value) => value === 0)) { ended = true; break; }
  const namePart = readField(header, 0, 100);
  const prefix = readField(header, 345, 155);
  const name = prefix ? `${prefix}/${namePart}` : namePart;
  const type = readField(header, 156, 1) || "0";
  const link = readField(header, 157, 100);
  const size = readOctal(header, 124, 12);
  if (["x", "g", "L", "K"].includes(type)) {
    offset += 512 + Math.ceil(size / 512) * 512;
    continue;
  }
  const nameKey = canonicalName(name, type);
  const key = nameKey.endsWith("/") ? nameKey.slice(0, -1) : nameKey;
  if (seen.has(key)) fail(`duplicate or security-ambiguous member path: ${JSON.stringify(name)}`);
  seen.add(key);
  if (!["0", "5", "1", "2"].includes(type)) fail(`special/device/unsupported member type ${JSON.stringify(type)} at ${JSON.stringify(name)}`);
  if ((type === "1" || type === "2")) {
    if (!link || link.startsWith("/") || link.includes("\\") || link.includes("\0")) fail(`unsafe link target at ${JSON.stringify(name)}`);
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(nameKey), link));
    if (!target.startsWith("package/") || target === "package") fail(`link target escapes package root at ${JSON.stringify(name)} -> ${JSON.stringify(link)}`);
  }
  entries.push({ name: nameKey, type, link, size });
  offset += 512 + Math.ceil(size / 512) * 512;
  if (offset > bytes.length) fail(`member payload exceeds archive at ${JSON.stringify(name)}`);
}
if (!ended) fail("archive has no terminating zero blocks");
const index = entries.find((entry) => entry.name === "package/dist/index.js");
if (!index) fail("package/dist/index.js is absent");
if (index.type !== "0") fail("package/dist/index.js must be a regular file, not a link");
process.stdout.write(`${JSON.stringify({format: "gzip-tar", memberCount: entries.length, members: entries, validatedDistIndex: true}, null, 2)}\n`);
NODE
then
  failure_code="ARCHIVE_INVALID"
  archive_detail="$(tr '\n' ' ' <"$run_dir/archive-validation.stderr" | tr -s ' ')"
  failure_reason="pre-extraction archive validation rejected candidate: ${archive_detail:-unsafe archive}"
  printf '%s\n' "$failure_reason" >&2
  exit 2
fi

candidate_package_json="$(tar -xOf "$tarball" package/package.json 2>"$run_dir/candidate-package-error.log" || true)"
if ! jq -e 'type == "object" and (.name|type == "string") and (.version|type == "string") and (.main|type == "string")' >/dev/null <<<"$candidate_package_json"; then
  failure_code="CANDIDATE_MANIFEST_INVALID"
  failure_reason="candidate package/package.json is missing or malformed"
  printf '%s\n' "$failure_reason" >&2
  exit 2
fi
printf '%s\n' "$candidate_package_json" | jq . >"$run_dir/candidate-package.json"
candidate_name_actual="$(jq -r '.name' "$run_dir/candidate-package.json")"
candidate_version_actual="$(jq -r '.version' "$run_dir/candidate-package.json")"
candidate_package_path="/runtime/candidate/package"
if [[ "$candidate_name_actual" != "$candidate_name_expected" ]]; then
  failure_code="CANDIDATE_NAME_MISMATCH"
  failure_reason="candidate package name mismatch: expected $candidate_name_expected, got $candidate_name_actual"
  printf '%s\n' "$failure_reason" >&2
  exit 2
fi
if [[ -n "$requested_candidate_version" && "$candidate_version_actual" != "$requested_candidate_version" ]]; then
  failure_code="CANDIDATE_VERSION_MISMATCH"
  failure_reason="candidate package version mismatch: expected $requested_candidate_version, got $candidate_version_actual"
  printf '%s\n' "$failure_reason" >&2
  exit 2
fi
candidate_version="$candidate_version_actual"
tarball_sha256="$(sha256_file "$tarball")"
printf '%s  %s\n' "$tarball_sha256" "$tarball" >"$run_dir/tarball-sha256.txt"
if [[ -n "$candidate_sha256_expected" && "$tarball_sha256" != "${candidate_sha256_expected,,}" ]]; then
  failure_code="CANDIDATE_SHA256_MISMATCH"
  failure_reason="candidate tarball SHA-256 mismatch: expected $candidate_sha256_expected, got $tarball_sha256"
  printf '%s\n' "$failure_reason" >&2
  exit 2
fi

stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/opencode-agy-harness-$run_id.XXXXXX")"
capture_dir="$stage_dir/captures"
mkdir -p "$capture_dir" "$stage_dir/evidence"
cp -p "$tarball" "$stage_dir/candidate.tgz"
cp -p "$(dirname "$0")/podman-fake-provider.mjs" "$stage_dir/fake-provider.mjs"

cat >"$stage_dir/runtime.sh" <<'RUNTIME'
#!/usr/bin/env bash
set -Eeuo pipefail

: "${OPENCODE_VERSION:?}"
: "${PROVIDER_MODE:?}"
: "${SCENARIO:?}"
: "${HARNESS_TIMEOUT:?}"
: "${PODMAN_ARCH:?}"
: "${CANDIDATE_VERSION:?}"
: "${CANDIDATE_SHA256:?}"
: "${PROVIDER_ALIAS:?}"
readonly ROOT=/runtime
readonly PROJECT="$ROOT/project"
readonly HOME_DIR="$ROOT/home"
readonly CONFIG_HOME="$ROOT/config"
readonly CACHE_HOME="$ROOT/cache"
readonly CANDIDATE_ROOT="$ROOT/candidate"
readonly CANDIDATE="$CANDIDATE_ROOT/package"
readonly EVIDENCE=/input/evidence
readonly CAPTURES=/input/captures
runtime_failure_code="RUNTIME_FAILURE"
runtime_failure_message="runtime proof failed"

runtime_fail() {
  local code="$1"
  local message="$2"
  runtime_failure_code="$code"
  runtime_failure_message="$message"
  printf '%s\n' "$message" >&2
  node - "$code" "$message" <<'NODE' >"/input/evidence/failure.json"
const fs = require("node:fs");
const [code, message] = process.argv.slice(2);
fs.writeFileSync("/input/evidence/failure.json", `${JSON.stringify({ code, message })}\n`);
NODE
  exit 1
}

runtime_err_trap() {
  local code=$?
  runtime_fail "RUNTIME_COMMAND_FAILURE" "runtime command failed at line ${BASH_LINENO[0]:-unknown} with exit code $code"
}
trap runtime_err_trap ERR

mkdir -p "$PROJECT" "$HOME_DIR" "$CONFIG_HOME" "$CACHE_HOME" "$EVIDENCE" "$CAPTURES" "$PROJECT/.opencode"
node <<'NODE'
const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const actualSha = crypto.createHash("sha256").update(fs.readFileSync("/input/candidate.tgz")).digest("hex");
if (actualSha !== process.env.CANDIDATE_SHA256) process.exit(30);
const allowedKeys = ["HOME","XDG_CONFIG_HOME","XDG_CACHE_HOME","PATH","PWD","OPENCODE_CONFIG","OPENCODE_DISABLE_AUTOUPDATE","OPENCODE_DISABLE_DEFAULT_PLUGINS","NPM_CONFIG_AUDIT","NPM_CONFIG_FUND","NPM_CONFIG_UPDATE_NOTIFIER","NPM_CONFIG_CACHE","OPENCODE_VERSION","CANDIDATE_VERSION","CANDIDATE_SHA256","PROVIDER_MODE","SCENARIO","HARNESS_TIMEOUT","PODMAN_ARCH","PROVIDER_ALIAS"];
const values = Object.fromEntries(allowedKeys.filter((key) => Object.hasOwn(process.env, key)).map((key) => [key, process.env[key]]));
const sensitive = Object.keys(process.env).filter((key) => /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key));
fs.writeFileSync("/input/evidence/runtime-env.json", `${JSON.stringify({ allowedKeys, values, actualKeys: Object.keys(process.env).sort(), sensitiveKeysPresent: sensitive }, null, 2)}\n`);
NODE

mkdir -p "$CANDIDATE_ROOT"
tar --no-same-owner --no-same-permissions --delay-directory-restore -xzf /input/candidate.tgz -C "$CANDIDATE_ROOT" || runtime_fail "ARCHIVE_EXTRACTION_FAILURE" "validated candidate extraction failed"
node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const root = fs.realpathSync("/runtime/candidate/package");
const isContained = (candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const stat = fs.lstatSync(full);
    if (stat.isBlockDevice() || stat.isCharacterDevice() || stat.isFIFO() || stat.isSocket()) process.exit(33);
    const resolved = fs.realpathSync(full);
    if (!isContained(resolved)) process.exit(33);
    if (entry.isDirectory()) walk(full);
  }
};
walk(root);
const indexPath = path.join(root, "dist/index.js");
const indexStat = fs.lstatSync(indexPath);
if (!indexStat.isFile() || indexStat.isSymbolicLink()) process.exit(32);
if (!isContained(fs.realpathSync(indexPath))) process.exit(32);
const packageJsonPath = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
if (pkg.name !== "opencode-agy" || pkg.version !== process.env.CANDIDATE_VERSION || pkg.main !== "./dist/index.js") process.exit(31);
const commandPath = path.join(root, "commands/agy.md");
if (fs.existsSync(commandPath)) {
  const text = fs.readFileSync(commandPath, "utf8");
  const parts = text.split(/^---\s*$/m);
  if (parts.length < 3) process.exit(39);
  fs.writeFileSync("/input/evidence/candidate-template.txt", `${parts.slice(2).join("---").trim()}\n`);
} else if (process.env.SCENARIO === "positive" || process.env.SCENARIO === "all") {
  process.exit(39);
}
const actualSha = crypto.createHash("sha256").update(fs.readFileSync("/input/candidate.tgz")).digest("hex");
const runtimeUname = os.arch();
const osRelease = fs.readFileSync("/etc/os-release", "utf8");
const libc = require("node:child_process").execFileSync("getconf", ["GNU_LIBC_VERSION"], { encoding: "utf8" }).trim();
if (!libc.startsWith("glibc ")) process.exit(34);
const identity = {
  opencodeRequestedPackage: { name: "opencode-ai", version: process.env.OPENCODE_VERSION },
  opencodeInstalledPackage: null,
  opencodeCli: null,
  binary: null,
  platformPackage: null,
  container: { architecture: runtimeUname, uname: require("node:child_process").execFileSync("uname", ["-m"], { encoding: "utf8" }).trim(), osRelease, libc },
  podmanArchitecture: process.env.PODMAN_ARCH,
  candidate: { packageRoot: root, sha256: actualSha },
};
fs.writeFileSync("/input/evidence/runtime-identity-bootstrap.json", `${JSON.stringify(identity, null, 2)}\n`);
NODE
rm -f "$CANDIDATE/commands/agy.md"
[[ ! -e "$CANDIDATE/commands/agy.md" ]] || runtime_fail "MARKDOWN_RUNTIME_DEPENDENCY" "packaged commands/agy.md remained readable before runtime dispatch"

cat >"$PROJECT/package.json" <<'JSON'
{"name":"opencode-agy-podman-proof","private":true,"version":"1.0.0"}
JSON
printf '%s\n' "npm install --no-save --package-lock=false --no-audit --no-fund opencode-ai@$OPENCODE_VERSION" >"$EVIDENCE/install-command.txt"
(
  cd "$PROJECT"
  NPM_CONFIG_CACHE="$CACHE_HOME/npm" npm install --no-save --package-lock=false --no-audit --no-fund "opencode-ai@$OPENCODE_VERSION"
) >"$EVIDENCE/opencode-install.stdout" 2>"$EVIDENCE/opencode-install.stderr" || runtime_fail "OPENCODE_INSTALL_FAILURE" "exact opencode-ai installation failed; raw stderr is in opencode-install.stderr"

BIN="$PROJECT/node_modules/.bin/opencode"
[[ -x "$BIN" ]] || runtime_fail "OPENCODE_BINARY_MISSING" "opencode binary is missing after exact installation"
"$BIN" --version >"$EVIDENCE/opencode-version.txt" 2>"$EVIDENCE/opencode-version.stderr" || runtime_fail "OPENCODE_VERSION_COMMAND_FAILURE" "opencode --version failed; raw stderr is in opencode-version.stderr"
node "$PROJECT/node_modules/opencode-ai/bin/opencode" --version >/dev/null 2>&1 || true

node - "$PROJECT" "$BIN" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const child = require("node:child_process");
const project = process.argv[2];
const bin = process.argv[3];
const requested = process.env.OPENCODE_VERSION;
const rawCli = fs.readFileSync("/input/evidence/opencode-version.txt", "utf8");
const cli = rawCli.trim();
const versionMatch = cli.match(/\d+\.\d+\.\d+/);
const installedPath = path.join(project, "node_modules/opencode-ai/package.json");
const installed = JSON.parse(fs.readFileSync(installedPath, "utf8"));
const realBinary = fs.realpathSync(bin);
const archMap = { arm64: "arm64", x64: "amd64" };
const platformName = `${process.platform === "linux" ? "linux" : process.platform}-${archMap[process.arch] ?? process.arch}`;
const expectedPlatformName = `opencode-${platformName}`;
const matches = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".bin") continue;
      walk(full);
      continue;
    }
    if (entry.name !== "package.json") continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(full, "utf8"));
      if (pkg.name === expectedPlatformName) matches.push({ name: pkg.name, version: pkg.version, path: full });
    } catch {}
  }
};
walk(path.join(project, "node_modules"));
if (installed.name !== "opencode-ai" || installed.version !== requested) process.exit(35);
if (!versionMatch || versionMatch[0] !== requested) process.exit(38);
if (!realBinary) process.exit(36);
if (matches.length !== 1 || matches[0].version !== requested) process.exit(40);
const libc = child.execFileSync("getconf", ["GNU_LIBC_VERSION"], { encoding: "utf8" }).trim();
const identity = JSON.parse(fs.readFileSync("/input/evidence/runtime-identity-bootstrap.json", "utf8"));
identity.opencodeInstalledPackage = { name: installed.name, version: installed.version, path: installedPath };
identity.opencodeCli = { command: `${bin} --version`, raw: rawCli, exact: cli, parsedVersion: versionMatch[0] };
identity.binary = { requestedPath: bin, realpath: realBinary };
identity.platformPackage = matches[0];
identity.container.nodeArch = process.arch;
identity.container.nodeVersion = process.version;
identity.container.libc = libc;
identity.identityChecks = { installedMatchesRequested: true, cliMatchesRequested: true, binaryRealpathPresent: true, platformPackageMatchesRequested: true, containerArchitecturePresent: Boolean(identity.container.architecture), osIdentityPresent: Boolean(identity.container.osRelease), libcIdentityPresent: Boolean(libc) };
if (Object.values(identity.identityChecks).some((value) => value !== true)) process.exit(41);
fs.writeFileSync("/input/evidence/runtime-identity.json", `${JSON.stringify(identity, null, 2)}\n`);
fs.writeFileSync("/input/evidence/opencode-package.json", `${JSON.stringify(installed, null, 2)}\n`);
fs.writeFileSync("/input/evidence/platform-package.json", `${JSON.stringify(matches[0], null, 2)}\n`);
NODE

PLUGIN_URL="$(node -e 'process.stdout.write(require("node:url").pathToFileURL(process.argv[1]).href)' "$CANDIDATE/dist/index.js")"
if [[ "$PROVIDER_MODE" == unreachable ]]; then
  BASE_URL=http://127.0.0.1:9/v1
else
  BASE_URL="http://$PROVIDER_ALIAS:8787/v1"
fi
cat >"$PROJECT/.opencode.json" <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "plugin": ["$PLUGIN_URL"],
  "model": "openai/harness",
  "small_model": "openai/harness",
  "agent": {"title": {"disable": true}},
  "provider": {
    "openai": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {"apiKey":"harness-key","baseURL":"$BASE_URL","timeout":3000,"headerTimeout":3000,"chunkTimeout":3000},
      "models": {"harness":{"name":"Harness Fake OpenAI","limit":{"context":32768,"output":1024},"reasoning":false,"tool_call":false,"modalities":{"input":["text"],"output":["text"]}}}
    }
  }
}
JSON
cp "$PROJECT/.opencode.json" "$EVIDENCE/config.json"

run_command() {
  local name="$1"
  local command_name="$2"
  shift 2
  local stdout="$EVIDENCE/$name.stdout"
  local stderr="$EVIDENCE/$name.stderr"
  local code=0
  (cd "$PROJECT" && timeout --kill-after=2s "${HARNESS_TIMEOUT}s" "$BIN" run --format json --command "$command_name" "$@") >"$stdout" 2>"$stderr" || code=$?
  printf '%s\n' "$code" >"$EVIDENCE/$name.exit-code"
  if [[ "$code" == 124 || "$code" == 137 ]]; then
    command_timeout_seen=1
  fi
  return 0
}

capture_count() { find "$CAPTURES" -maxdepth 1 -type f -name 'capture-*.json' | wc -l | tr -d ' '; }
latest_capture() { find "$CAPTURES" -maxdepth 1 -type f -name 'capture-*.json' -print | sort | tail -n 1; }
user_messages() {
  local file="$1"
  node - "$file" <<'NODE'
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const text = (body.messages ?? []).filter((message) => message.role === "user").map((message) => typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map((part) => part.text ?? "").join("\n") : String(message.content)).join("\n");
process.stdout.write(text);
NODE
}

assert_default_capture() {
  local before="$1"
  local after="$2"
  local expected=$((before + 1))
  [[ "$after" -eq "$expected" ]] || runtime_fail "REQUEST_COUNT_MISMATCH" "positive expected exactly one additional provider request, before=$before after=$after"
  local capture
  capture="$(latest_capture)"
  [[ -n "$capture" && -f "$capture" ]] || runtime_fail "UNEXPECTED_CAPTURE" "positive provider capture is absent"
  local message
  message="$(user_messages "$capture")"
  [[ "$message" == *TEST_SENTINEL* ]] || runtime_fail "UNEXPECTED_CAPTURE" "positive sentinel is absent from the captured user message"
  [[ "$message" != *'\$ARGUMENTS'* ]] || runtime_fail "UNEXPECTED_CAPTURE" 'positive literal $ARGUMENTS was not expanded'
  local expected_template
  expected_template="$(<"$EVIDENCE/candidate-template.txt")"
  expected_template="${expected_template//\$ARGUMENTS/TEST_SENTINEL}"
  [[ "$message" == *"$expected_template"* ]] || runtime_fail "UNEXPECTED_CAPTURE" "positive expanded default template is absent from the captured user message"
}

assert_override_capture() {
  local before="$1"
  local after="$2"
  local expected=$((before + 1))
  [[ "$after" -eq "$expected" ]] || runtime_fail "REQUEST_COUNT_MISMATCH" "override expected exactly one additional provider request, before=$before after=$after"
  local capture
  capture="$(latest_capture)"
  [[ -n "$capture" && -f "$capture" ]] || runtime_fail "UNEXPECTED_CAPTURE" "override provider capture is absent"
  local message
  message="$(user_messages "$capture")"
  [[ "$message" == *OVERRIDE_SENTINEL* ]] || runtime_fail "UNEXPECTED_CAPTURE" "override sentinel is absent from the captured user message"
  if [[ -s "$EVIDENCE/candidate-template.txt" ]]; then
    local expected_template
    expected_template="$(<"$EVIDENCE/candidate-template.txt")"
    expected_template="${expected_template//\$ARGUMENTS/TEST_SENTINEL}"
    [[ "$message" != *"$expected_template"* ]] || runtime_fail "UNEXPECTED_CAPTURE" "default template unexpectedly appeared in override capture"
  fi
}

command_timeout_seen=0
run_command positive agy TEST_SENTINEL
positive_code="$(<"$EVIDENCE/positive.exit-code")"
positive_before=0
positive_after="$(capture_count)"
printf '{"scenario":"positive","exitCode":%s,"requestsBefore":%s,"requestsAfter":%s}\n' "$positive_code" "$positive_before" "$positive_after" >"$EVIDENCE/positive-result.json"
if [[ "$SCENARIO" == positive || "$SCENARIO" == all ]]; then
  if [[ "$PROVIDER_MODE" == timeout ]]; then runtime_fail "PROVIDER_RESPONSE_TIMEOUT" "provider accepted the request but did not return a response before the command timeout"; fi
  if [[ "$PROVIDER_MODE" == unreachable ]]; then runtime_fail "UNREACHABLE_PROVIDER" "configured provider endpoint was unreachable"; fi
  if [[ "$command_timeout_seen" == 1 ]]; then runtime_fail "COMMAND_TIMEOUT" "positive OpenCode command exceeded the harness timeout"; fi
  assert_default_capture "$positive_before" "$positive_after"
  [[ "$positive_code" == 0 ]] || runtime_fail "COMMAND_FAILURE" "positive command exited with code $positive_code"
fi

if [[ "$SCENARIO" == missing || "$SCENARIO" == all ]]; then
  missing_before="$(capture_count)"
  run_command missing missing-command MISSING_SENTINEL
  missing_code="$(<"$EVIDENCE/missing.exit-code")"
  missing_after="$(capture_count)"
  printf '{"scenario":"missing","exitCode":%s,"requestsBefore":%s,"requestsAfter":%s}\n' "$missing_code" "$missing_before" "$missing_after" >"$EVIDENCE/missing-result.json"
  [[ "$missing_after" == "$missing_before" ]] || runtime_fail "REQUEST_COUNT_MISMATCH" "missing command produced an unexpected provider request, before=$missing_before after=$missing_after"
fi

if [[ "$SCENARIO" == override || "$SCENARIO" == all ]]; then
  cat >"$PROJECT/.opencode.json" <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "plugin": ["$PLUGIN_URL"],
  "model": "openai/harness",
  "small_model": "openai/harness",
  "agent": {"title": {"disable": true}},
  "command": {"agy": {"description":"Harness override","template":"OVERRIDE_SENTINEL \$ARGUMENTS"}},
  "provider": {"openai":{"npm":"@ai-sdk/openai-compatible","options":{"apiKey":"harness-key","baseURL":"$BASE_URL","timeout":3000,"headerTimeout":3000,"chunkTimeout":3000},"models":{"harness":{"name":"Harness Fake OpenAI","limit":{"context":32768,"output":1024},"reasoning":false,"tool_call":false,"modalities":{"input":["text"],"output":["text"]}}}}}
}
JSON
  cp "$PROJECT/.opencode.json" "$EVIDENCE/override-config.json"
  override_before="$(capture_count)"
  run_command override agy TEST_SENTINEL
  override_code="$(<"$EVIDENCE/override.exit-code")"
  override_after="$(capture_count)"
  printf '{"scenario":"override","exitCode":%s,"requestsBefore":%s,"requestsAfter":%s}\n' "$override_code" "$override_before" "$override_after" >"$EVIDENCE/override-result.json"
  if [[ "$PROVIDER_MODE" == timeout ]]; then runtime_fail "PROVIDER_RESPONSE_TIMEOUT" "provider accepted the override request but did not return a response before the command timeout"; fi
  if [[ "$PROVIDER_MODE" == unreachable ]]; then runtime_fail "UNREACHABLE_PROVIDER" "configured provider endpoint was unreachable for the override command"; fi
  if [[ "$command_timeout_seen" == 1 ]]; then runtime_fail "COMMAND_TIMEOUT" "override OpenCode command exceeded the harness timeout"; fi
  assert_override_capture "$override_before" "$override_after"
  [[ "$override_code" == 0 ]] || runtime_fail "COMMAND_FAILURE" "override command exited with code $override_code"
fi

if [[ "$PROVIDER_MODE" == unexpected ]]; then
  [[ -e "$CAPTURES/unexpected-capture.json" ]] || runtime_fail "UNEXPECTED_CAPTURE" "unexpected-capture.json was not produced by the unexpected provider control"
  runtime_fail "UNEXPECTED_CAPTURE" "unexpected provider capture was observed"
fi
if [[ "$PROVIDER_MODE" == extra ]]; then
  runtime_fail "REQUEST_COUNT_MISMATCH" "provider extra-capture control produced more requests than the exact-one-request contract"
fi

printf '%s\n' "runtime proof passed" >"$EVIDENCE/runtime-results.json"
RUNTIME
chmod 700 "$stage_dir/runtime.sh"

if [[ "$provider_mode" == readiness-timeout ]]; then
  printf '%s\n' '{"mode":"readiness-timeout","started":false,"diagnostic":"provider readiness timeout"}' >"$run_dir/provider-readiness.json"
  failure_code="PROVIDER_READINESS_TIMEOUT"
  failure_reason="fake provider readiness timed out before runtime launch"
  actual_status=1
  actual_outcome="fail"
  observed_failure_code="$failure_code"
  observed_failure_reason="$failure_reason"
  printf '%s\n' "$failure_reason" >&2
  exit 1
fi

if ! podman network create --label "$LABEL_KEY=$run_id" "$network_name" >"$run_dir/network-create.stdout" 2>"$run_dir/network-create.stderr"; then
  failure_code="PODMAN_NETWORK_CREATE_FAILURE"
  failure_reason="run-labeled Podman network creation failed"
  printf '%s\n' "$failure_reason" >&2
  exit 1
fi
network_created=1
podman network inspect "$network_name" >"$run_dir/podman-network-inspect.json"

if [[ "$provider_mode" != unreachable ]]; then
  if ! podman run --detach --name "$fake_name" --label "$LABEL_KEY=$run_id" --network "$network_name" --network-alias "$provider_alias" --volume "$stage_dir:/input:rw" --env CAPTURE_DIR=/input/captures --env PROVIDER_MODE="$provider_mode" --env PROVIDER_PORT=8787 "$IMAGE" node /input/fake-provider.mjs >"$run_dir/fake-create.stdout" 2>"$run_dir/fake-create.stderr"; then
    failure_code="PROVIDER_START_FAILURE"
    failure_reason="fake provider container failed to start"
    printf '%s\n' "$failure_reason" >&2
    exit 1
  fi
  fake_created=1
  podman inspect "$fake_name" >"$run_dir/podman-fake-inspect.json"
  deadline=$((SECONDS + timeout_seconds))
  while [[ ! -f "$capture_dir/ready" && "$SECONDS" -lt "$deadline" ]]; do sleep 1; done
  if [[ ! -f "$capture_dir/ready" ]]; then
    failure_code="PROVIDER_READINESS_TIMEOUT"
    failure_reason="fake provider did not become ready before timeout"
    actual_status=1
    actual_outcome="fail"
    observed_failure_code="$failure_code"
    observed_failure_reason="$failure_reason"
    printf '%s\n' "$failure_reason" >&2
    exit 1
  fi
else
  printf '%s\n' '{"mode":"unreachable","started":false,"diagnostic":"provider endpoint uses container loopback"}' >"$run_dir/podman-fake-inspect.json"
fi

runtime_code=0
if ! podman run --name "$runtime_name" --label "$LABEL_KEY=$run_id" --network "$network_name" --volume "$stage_dir:/input:rw" --env HOME=/runtime/home --env XDG_CONFIG_HOME=/runtime/config --env XDG_CACHE_HOME=/runtime/cache --env PATH=/runtime/project/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin --env PWD=/runtime/project --env OPENCODE_CONFIG=/runtime/project/.opencode.json --env OPENCODE_DISABLE_AUTOUPDATE=1 --env OPENCODE_DISABLE_DEFAULT_PLUGINS=1 --env NPM_CONFIG_AUDIT=false --env NPM_CONFIG_FUND=false --env NPM_CONFIG_UPDATE_NOTIFIER=false --env NPM_CONFIG_CACHE=/runtime/cache/npm --env OPENCODE_VERSION="$version" --env CANDIDATE_VERSION="$candidate_version" --env CANDIDATE_SHA256="$tarball_sha256" --env PROVIDER_MODE="$provider_mode" --env SCENARIO="$scenario" --env HARNESS_TIMEOUT="$timeout_seconds" --env PODMAN_ARCH="$container_arch" --env PROVIDER_ALIAS="$provider_alias" "$IMAGE" bash /input/runtime.sh >"$run_dir/runtime-launch.stdout" 2>"$run_dir/runtime-launch.stderr"; then
  runtime_code=$?
fi
runtime_created=1
printf '%s\n' "$runtime_code" >"$run_dir/runtime-container-exit-code"
mkdir -p "$run_dir/provider-captures"
cp -R "$stage_dir/captures/." "$run_dir/provider-captures/" 2>/dev/null || true
cp -R "$stage_dir/evidence/." "$run_dir/" 2>/dev/null || true
podman inspect "$runtime_name" >"$run_dir/podman-runtime-inspect.json" 2>"$run_dir/podman-runtime-inspect.stderr" || true
podman inspect "$runtime_name" | jq '{name:.[0].Name,mounts:.[0].Mounts,environment:.[0].Config.Env,image:.[0].ImageName,architecture:.[0].Architecture,labels:.[0].Config.Labels}' >"$run_dir/mount-audit.json" 2>"$run_dir/mount-audit.stderr" || true
if [[ "$fake_created" == 1 ]]; then podman logs "$fake_name" >"$run_dir/fake-server.log" 2>&1 || true; fi

if [[ -s "$run_dir/runtime-identity.json" ]]; then
  identity_complete="$(jq -r 'if (.identityChecks | all(. == true)) and .opencodeInstalledPackage.version != null and .platformPackage.name != null then true else false end' "$run_dir/runtime-identity.json" 2>/dev/null || echo false)"
  [[ "$identity_complete" != "true" ]] && identity_complete=false
  candidate_package_path="$(jq -r '.opencodeInstalledPackage.path // ""' "$run_dir/runtime-identity.json" 2>/dev/null || true)"
fi


if [[ -s "$run_dir/failure.json" ]]; then
  failure_code="$(jq -r '.code' "$run_dir/failure.json")"
  failure_reason="$(jq -r '.message' "$run_dir/failure.json")"
  actual_status="$runtime_code"
  actual_outcome="fail"
elif [[ "$runtime_code" == 0 ]]; then
  actual_status=0
  actual_outcome="pass"
  failure_code=""
  failure_reason=""
else
  actual_status="$runtime_code"
  actual_outcome="fail"
  failure_code="RUNTIME_PROOF_FAILURE"
  failure_reason="runtime proof failed with exit code $runtime_code; raw runtime stderr is in runtime-launch.stderr"
fi
observed_failure_code="$failure_code"
observed_failure_reason="$failure_reason"
if [[ "$actual_outcome" == "$expected_outcome" ]]; then
  harness_exit_code=0
  exit 0
fi
harness_exit_code=1
failure_code="EXPECTED_OUTCOME_MISMATCH"
failure_reason="expected outcome mismatch: expected $expected_outcome, observed $actual_outcome; observed failure is ${observed_failure_code:-none}: ${observed_failure_reason:-none}"
printf '%s\n' "$failure_reason" >&2
exit 1
