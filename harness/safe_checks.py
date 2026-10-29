#!/usr/bin/env python3
"""Credential-free ordinary checks in fresh private user/config/data roots."""
import json, os, pathlib, platform, subprocess, sys, tempfile
ROOT = pathlib.Path(__file__).resolve().parents[1]
PROFILE = json.loads((ROOT / "harness/checks.json").read_text())
if len(sys.argv) != 2 or sys.argv[1] not in ("static", "unit", "unit-linux", "unit-macos", "unit-performance"):
    raise SystemExit("usage: safe_checks.py static|unit|unit-linux|unit-macos|unit-performance")
mode = sys.argv[1]
macos_contract = "tests/daemon/macos-adapters.test.ts"
performance_contract = "tests/retrieval/memory-retriever-dedupe-bench.test.ts"
partitions = {
    "unit-linux": ["--exclude=" + macos_contract, "--exclude=" + performance_contract],
    "unit-macos": [macos_contract],
    "unit-performance": [performance_contract],
}
if mode in partitions:
    expected_platform = "Darwin" if mode == "unit-macos" else "Linux"
    if platform.system() != expected_platform or not all((ROOT / name).is_file() for name in (macos_contract, performance_contract)):
        raise SystemExit("CI partition requires its declared OS and both required contract files")
if (ROOT / ".env").exists():
    raise SystemExit("refusing checkout with .env; use a clean isolated worktree")
with tempfile.TemporaryDirectory(prefix="factory-checks-", dir="/tmp") as folder:
    p = pathlib.Path(folder)
    for name in ("home", "config", "data", "cache", "tmp"): (p/name).mkdir()
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(p/"home"),
           "XDG_CONFIG_HOME": str(p/"config"), "XDG_DATA_HOME": str(p/"data"),
           "XDG_CACHE_HOME": str(p/"cache"), "TMPDIR": str(p/"tmp"), "CI": "1",
           "LANG": "en_US.UTF-8", "NO_COLOR": "1", "NODE_ENV": "test",
           "VOICEDOCS_PROVIDER": "mock", "VOICEDOCS_TRANSCRIBER": "mock",
           "VOICEDOCS_DATA_DIR": str(p/"data"/"voicedocs"), "VOICEDOCS_NO_SEED": "1"}
    # Use Vitest's actual discovery, including its configuration, to prove that
    # moving the benchmark to a separate runner never drops or duplicates a file.
    expected_files = None
    if mode in partitions:
        def discover(filters):
            discovery = p/"discovery.json"
            discovery.unlink(missing_ok=True)
            subprocess.run(["node", str(ROOT/"node_modules/vitest/vitest.mjs"), "list", *filters, "--filesOnly", "--json=" + str(discovery)],
                                    cwd=ROOT, env=env, capture_output=True, text=True, timeout=60, check=True)
            rows = json.loads(discovery.read_text())
            files = {str(pathlib.Path(row["file"]).resolve()) for row in rows}
            if not files or len(files) != len(rows) or any(not pathlib.Path(name).is_relative_to(ROOT) for name in files):
                raise SystemExit("invalid Vitest file discovery")
            return files
        all_files = discover([])
        selected = {name: discover(filters) for name, filters in partitions.items()}
        union = set().union(*selected.values())
        if union != all_files or sum(map(len, selected.values())) != len(union):
            raise SystemExit("CI partitions must be disjoint and cover the complete Vitest include set")
        expected_files = selected[mode]
        print("CI_PARTITION_FILES " + json.dumps({name: len(files) for name, files in selected.items()}), flush=True)
    if mode == "unit-performance":
        # Machine facts and every benchmark sample remain visible in CI. No retries
        # or clock/threshold overrides; a slow isolated runner still fails the gate.
        subprocess.run(["node", "-e", 'const os=require("node:os"); console.log(JSON.stringify({platform:process.platform,arch:process.arch,node:process.version,cpus:os.cpus().length,cpuModel:os.cpus()[0]?.model,totalMemory:os.totalmem(),release:os.release()}))'],
                       cwd=ROOT, env=env, check=True, timeout=15)
    reporters = (["--reporter=default"] if mode == "unit-performance" else []) + ["--reporter=json", "--outputFile=" + str(p/"tests.json")]
    commands = PROFILE["static"] if mode == "static" else [PROFILE["unit"] + partitions.get(mode, []) + reporters]
    for command in commands:
        result = subprocess.run(command, cwd=ROOT, env=env, timeout=900)
        if result.returncode:
            report_path = p/"tests.json"
            if report_path.exists():
                report = json.loads(report_path.read_text())
                print(json.dumps({key: report.get(key) for key in ("numPassedTests", "numFailedTests", "numPendingTests", "success")}))
                for suite in report.get("testResults", []):
                    if suite.get("status") == "failed":
                        print(suite.get("name"), suite.get("message", ""))
                        for test in suite.get("assertionResults", []):
                            if test.get("status") == "failed": print(test.get("fullName"), test.get("failureMessages"))
            raise SystemExit(result.returncode)
    if sys.argv[1] == "static":
        for artifact in PROFILE.get("artifacts", []):
            if not (ROOT/artifact).is_file() or (ROOT/artifact).stat().st_size == 0:
                raise SystemExit("missing build artifact: " + artifact)
    else:
        report = json.loads((p/"tests.json").read_text())
        if expected_files is not None:
            reported_files = {str(pathlib.Path(suite["name"]).resolve()) for suite in report.get("testResults", [])}
            if reported_files != expected_files:
                raise SystemExit("test report did not execute the complete selected partition")
        count = int(report.get("numPassedTests", 0)); failed = int(report.get("numFailedTests", 0))
        skipped = int(report.get("numPendingTests", 0)) + int(report.get("numTodoTests", 0))
        if count < 1 or failed or not report.get("success"):
            raise SystemExit("test report did not prove nonempty passing suite")
        print(f"UNIT_EXECUTED {count}; SKIPPED {skipped} (skips are not verified coverage)")
