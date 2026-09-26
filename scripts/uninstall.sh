#!/usr/bin/env bash
# uninstall.sh: remove ollaya-decision-gate without hand-editing JSON.
# Usage: ./scripts/uninstall.sh [--global|--project|--all] [--purge-logs] [--pip]
set -euo pipefail
SCOPE="--project"
PURGE_LOGS=0
PIP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --global) SCOPE="--global"; shift ;;
    --project) SCOPE="--project"; shift ;;
    --all) SCOPE="--all"; shift ;;
    --purge-logs) PURGE_LOGS=1; shift ;;
    --pip) PIP=1; shift ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done
targets=()
[ "$SCOPE" = "--global" ] || [ "$SCOPE" = "--all" ] && targets+=("$HOME/.config/opencode/opencode.json")
[ "$SCOPE" = "--project" ] || [ "$SCOPE" = "--all" ] && targets+=("$PWD/opencode.jsonc")
for cfg in "${targets[@]}"; do
  [ -f "$cfg" ] || { echo "skip (missing): $cfg"; continue; }
  cp "$cfg" "$cfg.bak"
  python3 - "$cfg" <<'EOF'
import json, sys
p = sys.argv[1]
with open(p) as f:
    try:
        cfg = json.load(f)
    except json.JSONDecodeError as e:
        # .jsonc invites comments/trailing commas; this uninstaller only
        # speaks strict JSON. The backup at p + ".bak" above is untouched
        # and safe: nothing has been written back yet.
        print(f"ERROR: {p} is not valid JSON ({e}). If it has comments or "
              "trailing commas, this uninstaller can't edit it "
              "automatically: remove the ollaya-decision-gate entry from "
              f"its \"plugins\" array by hand ({p}.bak is an untouched "
              "backup, safe to delete once you're done).",
              file=sys.stderr)
        sys.exit(1)
before = len(cfg.get("plugins", []))
cfg["plugins"] = [x for x in cfg.get("plugins", [])
                  if "ollaya-decision-gate" not in json.dumps(x)]
print(f"{p}: removed {before - len(cfg['plugins'])} plugin entries (backup {p}.bak)")
with open(p, "w") as f:
    json.dump(cfg, f, indent=2)
EOF
done
if [ "$PURGE_LOGS" = 1 ]; then
  rm -f "${OLLAYA_GATE_LOG:-decisions-plugin.jsonl}" decisions-plugin.jsonl decisions.jsonl
  echo "logs purged"
else
  echo "logs kept (use --purge-logs to delete)"
fi
if [ "$PIP" = 1 ]; then
  python3 -m pip uninstall -y ollaya-decision-gate || true
fi
echo Done.
