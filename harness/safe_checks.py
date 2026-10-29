#!/usr/bin/env python3
"""Credential-free ordinary checks in fresh private user/config/data roots."""
import json, os, pathlib, subprocess, sys, tempfile
ROOT = pathlib.Path(__file__).resolve().parents[1]
PROFILE = json.loads((ROOT / "harness/checks.json").read_text())
if len(sys.argv) != 2 or sys.argv[1] not in ("static", "unit"):
    raise SystemExit("usage: safe_checks.py static|unit")
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
    commands = PROFILE["static"] if sys.argv[1] == "static" else [PROFILE["unit"] + ["--reporter=json", "--outputFile=" + str(p/"tests.json")]]
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
        count = int(report.get("numPassedTests", 0)); failed = int(report.get("numFailedTests", 0))
        skipped = int(report.get("numPendingTests", 0)) + int(report.get("numTodoTests", 0))
        if count < 1 or failed or not report.get("success"):
            raise SystemExit("test report did not prove nonempty passing suite")
        print(f"UNIT_EXECUTED {count}; SKIPPED {skipped} (skips are not verified coverage)")
