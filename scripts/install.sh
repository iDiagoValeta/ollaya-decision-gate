#!/usr/bin/env bash
# install.sh — one-command installer for ollaya-decision-gate.
# Usage: ./scripts/install.sh [--global|--project] [--log-file PATH] [--key-env]
set -euo pipefail

SCOPE="--project"
LOG_FILE=""
PRINT_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --global) SCOPE="--global"; shift ;;
    --project) SCOPE="--project"; shift ;;
    --log-file) LOG_FILE="$2"; shift 2 ;;
    --print-paths) PRINT_ONLY=1; shift ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$ROOT/plugin/ollaya-decision-gate"
DEFAULT_LOG="$ROOT/decisions-plugin.jsonl"
LOG_FILE="${LOG_FILE:-$DEFAULT_LOG}"

if [ "$PRINT_ONLY" = 1 ]; then
  echo "plugin=$PLUGIN_DIR"
  echo "log=$LOG_FILE"
  echo "scope=$SCOPE"
  exit 0
fi

echo "==> python deps"
python3 -m pip install -e "$ROOT" 2>&1 | tail -1

if command -v npm >/dev/null 2>&1; then
  echo "==> node deps"
  npm --prefix "$ROOT/plugin" install --no-audit --no-fund 2>&1 | tail -1
else
  echo "WARN: npm not found, skipping node install" >&2
fi

if [ "$SCOPE" = "--global" ]; then
  CONFIG="$HOME/.config/opencode/opencode.json"
else
  CONFIG="$PWD/opencode.jsonc"
fi

python3 - "$CONFIG" "$PLUGIN_DIR" "$LOG_FILE" <<'EOF'
import json, os, sys
config_path, plugin_pkg, log_file = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(config_path) as f:
        cfg = json.load(f)
except FileNotFoundError:
    cfg = {}
except json.JSONDecodeError as e:
    # .jsonc invites comments/trailing commas; this installer only speaks
    # strict JSON: any existing comment in the file crashes here with a
    # raw traceback, and set -e then aborts the whole script, including
    # the pip/npm installs already done above it.
    print(f"ERROR: {config_path} is not valid JSON ({e}). If it has comments "
          "or trailing commas, this installer can't merge into it "
          "automatically — add this to its \"plugins\" array by hand:\n"
          f'  {{"package": {json.dumps(plugin_pkg)}, '
          f'"options": {{"logFile": {json.dumps(log_file)}}}}}',
          file=sys.stderr)
    sys.exit(1)
plugins = cfg.get("plugins", [])
plugins = [p for p in plugins if not (
    (isinstance(p, dict) and "ollaya-decision-gate" in str(p.get("package", ""))) or
    (isinstance(p, str) and "ollaya-decision-gate" in p))]
plugins.append({"package": plugin_pkg, "options": {"logFile": log_file}})
cfg["plugins"] = plugins
if "permission" not in cfg:
    cfg["permission"] = "ask"
elif cfg["permission"] != "ask":
    print(f"WARN: permission is {cfg['permission']!r}, not left alone — "
          "the gate needs \"permission\": \"ask\" to receive permission.asked "
          "events at all; set it yourself if you want the gate to do anything.",
          file=sys.stderr)
config_dir = os.path.dirname(config_path)
if config_dir:
    os.makedirs(config_dir, exist_ok=True)
with open(config_path, "w") as f:
    json.dump(cfg, f, indent=2)
print(f"wrote {config_path}")
EOF

echo "==> verify"
TYPESAFE_API_KEY="${TYPESAFE_API_KEY:-}" OLLAYA_GATE_LOG="$LOG_FILE" \
  python3 -m ollaya_gate.doctor || echo "WARN: doctor found issues (see above)" >&2
echo "Done. Log: $LOG_FILE"
