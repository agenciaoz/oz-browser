#!/usr/bin/env bash
# OZ Browser — MCP smoke test (HX2 + H2 validation).
#
# Cómo correr:
#   bash scripts/smoke-test-mcp.sh
#
# Requiere: OZ Browser corriendo con OZ_MCP_ENABLED=1.
# Asume MCP server en 127.0.0.1:9223.

set -uo pipefail

ENDPOINT="http://127.0.0.1:9223/mcp"
PASS=0
FAIL=0
FAILURES=()

# Call an MCP tool. Args: tool_name [json_args]. Echoes the JSON result.
mcp() {
  local name="$1"
  local args="${2:-{\}}"
  curl -s -m 6 -X POST "$ENDPOINT" \
    -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"${name}\",\"arguments\":${args}}}"
}

# Extract `result.content[0].text` (which is JSON-stringified) → re-parse.
unwrap() {
  python3 -c "import sys, json
try:
  r = json.load(sys.stdin)
  if 'error' in r:
    print(json.dumps({'__error': r['error']}))
  else:
    txt = r['result']['content'][0]['text']
    print(txt)
except Exception as e:
  print(json.dumps({'__error': {'message': str(e), 'parse_failed': True}}))
"
}

assert() {
  local label="$1"
  local cond="$2"  # python expression; receives `r` (parsed JSON)
  local body="$3"
  local check
  check=$(python3 -c "
import sys, json
try:
  r = json.loads('''${body//\'/\\\'}''')
except Exception:
  r = None
print('PASS' if (${cond}) else 'FAIL')
" 2>&1)
  if [[ "$check" == "PASS" ]]; then
    PASS=$((PASS+1))
    printf '  ✓ %s\n' "$label"
  else
    FAIL=$((FAIL+1))
    FAILURES+=("$label :: ${body:0:200}")
    printf '  ✗ %s :: %s\n' "$label" "${body:0:200}"
  fi
}

section() { printf '\n— %s —\n' "$1"; }

# Helpers
get_field() {
  python3 -c "
import sys, json
r = json.loads('''$1''')
keys = '$2'.split('.')
for k in keys:
  if isinstance(r, list):
    r = r[int(k)]
  elif isinstance(r, dict):
    r = r.get(k)
print(r if r is not None else '')
"
}

echo "OZ Browser — MCP smoke test (HX2 + H2)"
echo "Endpoint: $ENDPOINT"

# ============================================================================
# 0. Health + baseline
# ============================================================================
section 'Baseline + HX2 windows tracking'

WIN_LIST=$(curl -s -m 3 http://127.0.0.1:9223/health)
assert 'health: ok' "r and r.get('status') == 'ok'" "$WIN_LIST"
assert 'health: 1 window at start' "r and r.get('windowsCount') == 1" "$WIN_LIST"

IDS=$(mcp oz.identities.list | unwrap)
assert 'identities.list: array' "isinstance(r, list)" "$IDS"
DEFAULT_ID=$(get_field "$IDS" "0.id")
echo "    default identity id: $DEFAULT_ID"

WS=$(mcp oz.workspaces.list | unwrap)
assert 'workspaces.list: array' "isinstance(r, list)" "$WS"
GENERAL_ID=$(get_field "$WS" "0.id")
echo "    general workspace id: $GENERAL_ID"
echo "    initial workspaces count: $(echo "$WS" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')"

# ============================================================================
# 1. Identity — full CRUD + lock semantics
# ============================================================================
section 'Identity CRUD + lock'

IDA=$(mcp oz.identities.create '{"opts":{"name":"SmokeID A"}}' | unwrap)
ID_A=$(get_field "$IDA" "id")
assert 'create new identity' "r and r.get('name') == 'SmokeID A'" "$IDA"
echo "    ID_A=$ID_A"

R=$(mcp oz.identities.update "{\"id\":\"$ID_A\",\"patch\":{\"name\":\"SmokeID Renamed\"}}" | unwrap)
assert 'update name' "r and r.get('name') == 'SmokeID Renamed'" "$R"

R=$(mcp oz.identities.setLocked "{\"id\":\"$ID_A\",\"locked\":true}" | unwrap)
assert 'setLocked true' "r and r.get('locked') == True" "$R"

R=$(mcp oz.identities.remove "{\"id\":\"$ID_A\"}" | unwrap)
assert 'remove locked → false' "r == False" "$R"

R=$(mcp oz.identities.setLocked "{\"id\":\"$ID_A\",\"locked\":false}" | unwrap)
assert 'setLocked false' "r and r.get('locked') == False" "$R"

R=$(mcp oz.identities.remove "{\"id\":\"$ID_A\"}" | unwrap)
assert 'remove unlocked → true' "r == True" "$R"

R=$(mcp oz.identities.get "{\"id\":\"$ID_A\"}" | unwrap)
assert 'removed identity is gone' "r is None" "$R"

# Default protection
R=$(mcp oz.identities.remove "{\"id\":\"$DEFAULT_ID\"}" | unwrap)
assert 'cannot remove default identity' "r == False" "$R"

# ============================================================================
# 2. Workspace — CRUD + setActive (the HX2 bug surface)
# ============================================================================
section 'Workspace CRUD + HX2 (setActive crash)'

# Create workspace + setActive — this is the crash path we just fixed.
R=$(mcp oz.workspaces.create '{"opts":{"name":"SmokeWS A"}}' | unwrap)
WS_A=$(get_field "$R" "id")
assert 'create workspace A' "r and r.get('name') == 'SmokeWS A'" "$R"

R=$(mcp oz.workspaces.setActive "{\"workspaceId\":\"$WS_A\"}" | unwrap)
assert 'setActive new workspace (HX2 fix)' "r and r.get('ok') == True" "$R"

R=$(mcp oz.workspaces.getActive '{}' | unwrap)
assert 'getActive returns new ws' "r == '$WS_A'" "\"$R\""

# Switch back
R=$(mcp oz.workspaces.setActive "{\"workspaceId\":\"$GENERAL_ID\"}" | unwrap)
assert 'setActive back to general' "r and r.get('ok') == True" "$R"

# Create + setActive 3 in a row (stress test the switch path)
for i in 1 2 3; do
  R=$(mcp oz.workspaces.create "{\"opts\":{\"name\":\"Stress$i\"}}" | unwrap)
  WSID=$(get_field "$R" "id")
  R2=$(mcp oz.workspaces.setActive "{\"workspaceId\":\"$WSID\"}" | unwrap)
  assert "stress switch #$i" "r and r.get('ok') == True" "$R2"
done

# Switch back to general for cleanup
mcp oz.workspaces.setActive "{\"workspaceId\":\"$GENERAL_ID\"}" > /dev/null

# Duplicate
R=$(mcp oz.workspaces.duplicate "{\"id\":\"$WS_A\"}" | unwrap)
WS_DUP=$(get_field "$R" "id")
assert 'duplicate workspace' "r and r.get('name') == 'SmokeWS A (copy)'" "$R"

# Freeze + can't update name when frozen
R=$(mcp oz.workspaces.freeze "{\"id\":\"$WS_A\"}" | unwrap)
assert 'freeze' "r == True" "$R"

R=$(mcp oz.workspaces.update "{\"id\":\"$WS_A\",\"patch\":{\"name\":\"NoChange\"}}" | unwrap)
assert 'frozen update returns null' "r is None" "$R"

R=$(mcp oz.workspaces.unfreeze "{\"id\":\"$WS_A\"}" | unwrap)
assert 'unfreeze' "r == True" "$R"

# Archive + Restore
R=$(mcp oz.workspaces.archive "{\"id\":\"$WS_A\"}" | unwrap)
assert 'archive' "r == True" "$R"
R=$(mcp oz.workspaces.restore "{\"id\":\"$WS_A\"}" | unwrap)
assert 'restore' "r == True" "$R"

# Cannot archive Default (general)
R=$(mcp oz.workspaces.archive "{\"id\":\"$GENERAL_ID\"}" | unwrap)
assert 'cannot archive general (default)' "r == False" "$R"

# Remove our test workspaces
mcp oz.workspaces.remove "{\"id\":\"$WS_A\"}" > /dev/null
mcp oz.workspaces.remove "{\"id\":\"$WS_DUP\"}" > /dev/null

# ============================================================================
# 3. Tabs — open + lock + close + move
# ============================================================================
section 'Tabs CRUD + lock + move'

# Make sure we're in general first
mcp oz.workspaces.setActive "{\"workspaceId\":\"$GENERAL_ID\"}" > /dev/null
sleep 0.3

# Open 3 tabs
TA=$(mcp oz.tabs.openInIdentity "{\"identityId\":\"$DEFAULT_ID\",\"url\":\"about:blank\"}" | unwrap)
assert 'open tab A' "isinstance(r, str) and len(r) > 0" "\"$TA\""
TB=$(mcp oz.tabs.openInIdentity "{\"identityId\":\"$DEFAULT_ID\",\"url\":\"about:blank\"}" | unwrap)
TC=$(mcp oz.tabs.openInIdentity "{\"identityId\":\"$DEFAULT_ID\",\"url\":\"about:blank\"}" | unwrap)
echo "    tabs: A=$TA B=$TB C=$TC"

# Lock B
R=$(mcp oz.tabs.lock "{\"tabId\":\"$TB\"}" | unwrap)
assert 'lock tab B' "r and r.get('ok') == True and r.get('locked') == True" "$R"

# Try to close locked B → expect false (tab-handlers.close returns boolean)
R=$(mcp oz.tabs.close "{\"tabId\":\"$TB\"}" | unwrap)
assert 'close locked tab → false' "r == False" "$R"

# Verify B still alive
R=$(mcp oz.tabs.list '{}' | unwrap)
assert 'locked B still in list' "any(t['id'] == '$TB' for t in r if isinstance(t, dict))" "$R"
assert 'tab.locked is true in serialize' "any(t.get('locked') == True for t in r if isinstance(t, dict) and t.get('id') == '$TB')" "$R"

# Unlock + close
R=$(mcp oz.tabs.unlock "{\"tabId\":\"$TB\"}" | unwrap)
assert 'unlock B' "r and r.get('ok') == True and r.get('locked') == False" "$R"
R=$(mcp oz.tabs.close "{\"tabId\":\"$TB\"}" | unwrap)
assert 'close unlocked B → true' "r == True" "$R"

# Pin A, lock C, then closeOthers from a brand-new tab → A pinned + C locked must survive
TD=$(mcp oz.tabs.openInIdentity "{\"identityId\":\"$DEFAULT_ID\",\"url\":\"about:blank\"}" | unwrap)
mcp oz.tabs.pin "{\"tabId\":\"$TA\"}" > /dev/null
mcp oz.tabs.lock "{\"tabId\":\"$TC\"}" > /dev/null
R=$(mcp oz.tabs.closeOthers "{\"tabId\":\"$TD\"}" | unwrap)
assert 'closeOthers ok' "r and r.get('ok') == True" "$R"
assert 'closeOthers skippedLocked >= 1' "r and r.get('skippedLocked', 0) >= 1" "$R"

LIST=$(mcp oz.tabs.list '{}' | unwrap)
assert 'after closeOthers: A pinned survived' "any(t['id'] == '$TA' for t in r if isinstance(t, dict))" "$LIST"
assert 'after closeOthers: C locked survived' "any(t['id'] == '$TC' for t in r if isinstance(t, dict))" "$LIST"

# moveToWorkspace with locked tab → must reject
WS_X=$(mcp oz.workspaces.create '{"opts":{"name":"MoveDest"}}' | unwrap)
WS_X_ID=$(get_field "$WS_X" "id")
R=$(mcp oz.tabs.moveToWorkspace "{\"tabId\":\"$TC\",\"targetWorkspaceId\":\"$WS_X_ID\"}" | unwrap)
assert 'moveToWorkspace locked → reject tab-locked' "r and r.get('ok') == False and r.get('reason') == 'tab-locked'" "$R"

# Unlock C and try again
mcp oz.tabs.unlock "{\"tabId\":\"$TC\"}" > /dev/null
R=$(mcp oz.tabs.moveToWorkspace "{\"tabId\":\"$TC\",\"targetWorkspaceId\":\"$WS_X_ID\"}" | unwrap)
assert 'moveToWorkspace unlocked → ok' "r and r.get('ok') == True" "$R"

# moveToNewWindow — opens window 2. After the move, browser.windows should be 2.
TE=$(mcp oz.tabs.openInIdentity "{\"identityId\":\"$DEFAULT_ID\",\"url\":\"about:blank\"}" | unwrap)
R=$(mcp oz.tabs.moveToNewWindow "{\"tabId\":\"$TE\"}" | unwrap)
assert 'moveToNewWindow ok' "r and r.get('ok') == True" "$R"

H=$(curl -s -m 3 http://127.0.0.1:9223/health)
assert 'health: 2 windows after moveToNewWindow' "r and r.get('windowsCount') == 2" "$H"

# Cleanup
mcp oz.workspaces.remove "{\"id\":\"$WS_X_ID\"}" > /dev/null

# ============================================================================
# 4. HX2 regression — close window, verify cleanup happens
# ============================================================================
section 'HX2 — window close splices from browser.windows'

# We have 2 windows from the moveToNewWindow above. Let's switch to general
# in window 1, then we cannot directly close the OTHER window via MCP (no
# tool for that). Instead, count windows + verify operations on the focused
# window still work (the bug was zombie windows lingered and crashed).
H1=$(curl -s -m 3 http://127.0.0.1:9223/health)
W_BEFORE=$(get_field "$H1" "windowsCount")
echo "    windows before: $W_BEFORE"

# setActive cycle should still work after the multi-window state.
mcp oz.workspaces.setActive "{\"workspaceId\":\"$GENERAL_ID\"}" > /dev/null
R=$(mcp oz.workspaces.getActive '{}' | unwrap)
assert 'getActive after multi-window setup still works' "r == '$GENERAL_ID'" "\"$R\""

# Bookmark a tab — basic smoke
R=$(mcp oz.tabs.list '{}' | unwrap)
FIRST_TAB_ID=$(get_field "$R" "0.id")
if [[ -n "$FIRST_TAB_ID" ]]; then
  R=$(mcp oz.bookmarks.add "{\"identityId\":\"$DEFAULT_ID\",\"url\":\"https://example.com\",\"title\":\"Smoke\"}" | unwrap)
  assert 'bookmarks.add' "r and (r.get('id') or r.get('deduped'))" "$R"
  BM_ID=$(get_field "$R" "id")
  if [[ -n "$BM_ID" ]]; then
    R=$(mcp oz.bookmarks.remove "{\"id\":\"$BM_ID\"}" | unwrap)
    assert 'bookmarks.remove' "r == True" "$R"
  fi
fi

# ============================================================================
# Done
# ============================================================================
printf '\n=== %d passed · %d failed ===\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo
  echo 'Failures:'
  for f in "${FAILURES[@]}"; do
    printf '  - %s\n' "$f"
  done
fi
exit $FAIL
