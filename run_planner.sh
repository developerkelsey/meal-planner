#!/bin/bash
# Weekly Meal Planner Runner
#
# To schedule: run `crontab -e` and add this line:
# 0 7 * * 1 /home/user/meal-planner/run_planner.sh >> /home/user/meal-planner/logs/planner.log 2>&1
#
# That runs every Monday at 7am.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

mkdir -p logs

# If running inside Claude Code and no API key is set, use the session token
if [ -z "$ANTHROPIC_API_KEY" ] && [ -f "$CLAUDE_SESSION_INGRESS_TOKEN_FILE" ]; then
  export ANTHROPIC_AUTH_TOKEN="$(cat "$CLAUDE_SESSION_INGRESS_TOKEN_FILE")"
fi

echo "=== Meal Planner Run: $(date) ==="
python3 meal_planner.py
echo ""
