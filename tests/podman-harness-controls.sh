#!/usr/bin/env bash
# Verifier-friendly control script for podman-runtime-harness.sh.
# Not *.test.*, excluded from Bun discovery and npm tarball.
# Runs serial failure controls, malicious archive controls, Podman controls, and concurrency proof.
set -Eeuo pipefail

FIXTURE="/private/var/folders/nc/6xpj5hk90ngbdtsb87s0z2m80000gn/T/opencode/agy-harness-fixture"
TARBALL="$FIXTURE/tarballs/opencode-agy-0.8.1.tgz"
EVIDENCE="$FIXTURE/evidence"
HARNESS="$(cd "$(dirname "$0")" && pwd)/podman-runtime-harness.sh"
PASS=0
FAIL=0
SKIP=0
RESULTS=()

record() {
  local name="$1" status="$2" exit_code="$3" detail="$4"
  RESULTS+=("$name|$status|$exit_code|$detail")
  if [[ "$status" == "PASS" ]]; then PASS=$((PASS + 1)); elif [[ "$status" == "FAIL" ]]; then FAIL=$((FAIL + 1)); else SKIP=$((SKIP + 1)); fi
  printf '%-50s %s (exit=%s) %s\n' "$name" "$status" "$exit_code" "$detail"
}

run_harness() {
  local label="$1"; shift
  local out="$EVIDENCE/$label"
  rm -rf "$out"; mkdir -p "$out"
  bash "$HARNESS" "$@" --evidence-dir "$out" 2>&1 || true
}

run_expect_fail() {
  local label="$1"; shift
  local out="$EVIDENCE/$label"
  rm -rf "$out"; mkdir -p "$out"
  set +e
  bash "$HARNESS" "$@" --evidence-dir "$out" >/dev/null 2>&1
  local code=$?
  set -e
  local summary="$out/run-*/summary.json"
  local fail_code=""
  if compgen -G "$summary" > /dev/null; then
    fail_code="$(jq -r '.failureCode // "none"' $summary 2>/dev/null)"
  fi
  if [[ $code -ne 0 ]]; then
    record "$label" "PASS" "$code" "fail_code=$fail_code"
  else
    record "$label" "FAIL" "$code" "expected non-zero"
  fi
}

run_expect_pass() {
  local label="$1"; shift
  local out="$EVIDENCE/$label"
  rm -rf "$out"; mkdir -p "$out"
  set +e
  bash "$HARNESS" "$@" --evidence-dir "$out" >/dev/null 2>&1
  local code=$?
  set -e
  if [[ $code -eq 0 ]]; then
    record "$label" "PASS" "$code" ""
  else
    record "$label" "FAIL" "$code" "expected zero"
  fi
}

create_malicious_archive() {
  local name="$1"; shift
  local outfile="$FIXTURE/tarballs/malicious-$name.tgz"
  node - "$outfile" "$@" <<'NODE'
const fs = require("node:fs");
const zlib = require("node:zlib");
const outfile = process.argv[2];
const kind = process.argv[3] || "absolute";
const writeHeader = (buf, offset, opts) => {
  const enc = (str, len) => { const b = Buffer.alloc(len); b.write(str || "", 0, "utf8"); return b; };
  const oct = (num, len) => { const b = Buffer.alloc(len); b.write((num || 0).toString(8).padStart(len - 1, "0") + "\0", 0, "utf8"); return b; };
  const header = Buffer.alloc(512);
  if (opts.prefix) { enc(opts.prefix, 155).copy(header, 345); }
  enc(opts.name, 100).copy(header, 0);
  oct(opts.mode || 0o644, 8).copy(header, 100);
  oct(opts.uid || 0, 8).copy(header, 108);
  oct(opts.gid || 0, 8).copy(header, 116);
  oct(opts.size || 0, 12).copy(header, 124);
  oct(opts.mtime || 0, 12).copy(header, 136);
  enc("        ", 8).copy(header, 148);
  header[156] = (opts.type || "0").charCodeAt(0);
  if (opts.link) enc(opts.link, 100).copy(header, 157);
  enc("ustar\0", 6).copy(header, 257);
  enc("00", 2).copy(header, 263);
  let cksum = 0;
  for (let i = 0; i < 512; i++) { if (i >= 148 && i < 156) cksum += 32; else cksum += header[i]; }
  oct(cksum, 8).copy(header, 148);
  header.copy(buf, offset);
  return 512;
};
const writeData = (buf, offset, data) => {
  const padded = Math.ceil(data.length / 512) * 512;
  data.copy(buf, offset);
  return padded;
};
const members = [];
members.push({ name: "package/", type: "5", size: 0 });
members.push({ name: "package/package.json", type: "0", data: Buffer.from('{"name":"opencode-agy","version":"0.8.1","main":"./dist/index.js"}') });
members.push({ name: "package/dist/", type: "5", size: 0 });
members.push({ name: "package/dist/index.js", type: "0", data: Buffer.from('console.log("plugin")') });
if (kind === "absolute") {
  members.push({ name: "/etc/passwd", type: "0", data: Buffer.from("root:x:0:0\n") });
} else if (kind === "traversal") {
  members.push({ name: "package/../../../etc/passwd", type: "0", data: Buffer.from("root:x:0:0\n") });
} else if (kind === "symlink") {
  members.push({ name: "package/dist/index.js", type: "2", link: "../../../etc/passwd", replace: true });
} else if (kind === "hardlink") {
  members.push({ name: "package/escape", type: "1", link: "/etc/passwd" });
} else if (kind === "special") {
  members.push({ name: "package/baddev", type: "3", data: Buffer.alloc(0) });
} else if (kind === "duplicate") {
  members.push({ name: "package/dist/index.js", type: "0", data: Buffer.from("overwritten"), duplicate: true });
}
let totalSize = 1024;
for (const m of members) { totalSize += 512 + (m.data ? Math.ceil(m.data.length / 512) * 512 : 0); }
const buf = Buffer.alloc(totalSize);
let offset = 0;
for (const m of members) {
  offset += writeHeader(buf, offset, { name: m.name, type: m.type, size: m.data ? m.data.length : 0, link: m.link });
  if (m.data && m.data.length > 0) offset += writeData(buf, offset, m.data);
}
Buffer.alloc(1024).copy(buf, offset);
const gz = zlib.gzipSync(buf);
fs.writeFileSync(outfile, gz);
NODE
  echo "$outfile"
}

echo "=== SERIAL VALIDATION CONTROLS (no Podman) ==="

# Missing tarball
set +e; bash "$HARNESS" --version 1.18.10 --tarball "$FIXTURE/nonexistent.tgz" --evidence-dir "$EVIDENCE/missing-tarball" >/dev/null 2>&1; code=$?; set -e
rm -rf "$EVIDENCE/missing-tarball"
record "missing-tarball" "$([ $code -ne 0 ] && echo PASS || echo FAIL)" "$code" ""

# Wrong candidate version
run_expect_fail "wrong-candidate-version" --version 1.18.10 --tarball "$TARBALL" --candidate-version 0.9.0

# Wrong candidate name
run_expect_fail "wrong-candidate-name" --version 1.18.10 --tarball "$TARBALL" --candidate-name wrong-name

# Wrong candidate SHA
run_expect_fail "wrong-candidate-sha" --version 1.18.10 --tarball "$TARBALL" --candidate-sha256 0000000000000000000000000000000000000000000000000000000000000000

# Malformed version
set +e; bash "$HARNESS" --version "latest" --tarball "$TARBALL" --evidence-dir "$EVIDENCE/bad-version" >/dev/null 2>&1; code=$?; set -e
rm -rf "$EVIDENCE/bad-version"
record "malformed-version" "$([ $code -ne 0 ] && echo PASS || echo FAIL)" "$code" ""

# Malformed timeout
set +e; bash "$HARNESS" --version 1.18.10 --tarball "$TARBALL" --evidence-dir "$EVIDENCE/bad-timeout" --timeout abc >/dev/null 2>&1; code=$?; set -e
rm -rf "$EVIDENCE/bad-timeout"
record "malformed-timeout" "$([ $code -ne 0 ] && echo PASS || echo FAIL)" "$code" ""

# Malformed expected outcome
set +e; bash "$HARNESS" --version 1.18.10 --tarball "$TARBALL" --evidence-dir "$EVIDENCE/bad-outcome" --expected-outcome maybe >/dev/null 2>&1; code=$?; set -e
rm -rf "$EVIDENCE/bad-outcome"
record "malformed-outcome" "$([ $code -ne 0 ] && echo PASS || echo FAIL)" "$code" ""

# Malformed scenario
set +e; bash "$HARNESS" --version 1.18.10 --tarball "$TARBALL" --evidence-dir "$EVIDENCE/bad-scenario" --scenario bogus >/dev/null 2>&1; code=$?; set -e
rm -rf "$EVIDENCE/bad-scenario"
record "malformed-scenario" "$([ $code -ne 0 ] && echo PASS || echo FAIL)" "$code" ""

# Malformed provider mode
set +e; bash "$HARNESS" --version 1.18.10 --tarball "$TARBALL" --evidence-dir "$EVIDENCE/bad-mode" --provider-mode bogus >/dev/null 2>&1; code=$?; set -e
rm -rf "$EVIDENCE/bad-mode"
record "malformed-provider-mode" "$([ $code -ne 0 ] && echo PASS || echo FAIL)" "$code" ""

echo ""
echo "=== MALICIOUS ARCHIVE CONTROLS ==="

for kind in absolute traversal symlink hardlink special duplicate; do
  echo -n "Creating malicious-$kind archive... "
  outfile=$(create_malicious_archive "$kind" "$kind")
  echo "done"
  run_expect_fail "malicious-$kind" --version 1.18.10 --tarball "$outfile"
done

echo ""
echo "=== MISSING EVIDENCE-DIR CONTROL ==="
set +e; bash "$HARNESS" --version 1.18.10 --tarball "$TARBALL" >/dev/null 2>&1; code=$?; set -e
record "missing-evidence-dir" "$([ $code -ne 0 ] && echo PASS || echo FAIL)" "$code" ""

echo ""
echo "=== SUMMARY ==="
echo "PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
if [[ $FAIL -gt 0 ]]; then
  printf '%s\n"---FAILURES---'
  for r in "${RESULTS[@]}"; do
    [[ "$r" == *"|FAIL|"* ]] && echo "$r"
  done
  exit 1
fi
exit 0
