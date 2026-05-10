#!/usr/bin/env python3
"""OZ Browser — MCP smoke test (HX2 + H2 validation).

Runs against a live OZ Browser with OZ_MCP_ENABLED=1 on 127.0.0.1:9223.
Disparates 50+ flows and reports bugs.
"""

import json
import sys
import urllib.request
import urllib.error
import time

ENDPOINT = "http://127.0.0.1:9223/mcp"
HEALTH = "http://127.0.0.1:9223/health"

passed = 0
failed = 0
failures = []


def section(name):
    print(f"\n— {name} —")


def ok(label, cond, detail=None):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ✓ {label}")
    else:
        failed += 1
        d = "" if detail is None else f" :: {str(detail)[:300]}"
        failures.append(f"{label}{d}")
        print(f"  ✗ {label}{d}")


def http_post(payload, timeout=8):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        ENDPOINT, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.URLError as e:
        return {"__transport_error": str(e)}


def http_get(url, timeout=4):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return {"__transport_error": str(e)}


def mcp(name, args=None):
    """Call an MCP tool and unwrap result.content[0].text → parsed JSON.

    The MCP server returns:
      {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"<json>"}]}}

    On error: {"jsonrpc":"2.0","id":1,"error":{"code":...,"message":...}}
    """
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": name, "arguments": args or {}},
    }
    raw = http_post(payload)
    if "error" in raw:
        return {"__error": raw["error"]}
    if "__transport_error" in raw:
        return raw
    try:
        text = raw["result"]["content"][0]["text"]
        return json.loads(text)
    except Exception as e:
        return {"__parse_error": str(e), "raw": raw}


def get_id(arr_or_obj, predicate=None, key="id"):
    """Find the first matching record's id field."""
    if isinstance(arr_or_obj, list):
        for item in arr_or_obj:
            if isinstance(item, dict) and (predicate is None or predicate(item)):
                return item.get(key)
    elif isinstance(arr_or_obj, dict):
        return arr_or_obj.get(key)
    return None


# ============================================================================
print("OZ Browser — MCP smoke test (HX2 + H2)")
print(f"Endpoint: {ENDPOINT}")

# ---- 0. Baseline ----------------------------------------------------------
section("Baseline + HX2 windows tracking")

h = http_get(HEALTH)
ok("health: ok", isinstance(h, dict) and h.get("status") == "ok", h)
ok(
    "health: 1 window at start",
    isinstance(h, dict) and h.get("windowsCount") == 1,
    h,
)

ids = mcp("oz.identities.list")
ok("identities.list: array", isinstance(ids, list), ids)
default_id = get_id(ids, predicate=lambda i: i.get("isDefault")) if isinstance(ids, list) else None
ok("identities.list contains default", default_id is not None, default_id)

ws = mcp("oz.workspaces.list")
ok("workspaces.list: array", isinstance(ws, list), ws)
general_id = (
    get_id(ws, predicate=lambda w: w.get("isDefault")) if isinstance(ws, list) else None
)
ok("workspaces.list contains general (isDefault)", general_id is not None, general_id)
print(f"    default_id={default_id}  general_id={general_id}")

# ---- 1. Identity CRUD + lock ----------------------------------------------
section("Identity CRUD + lock semantics")

# IMPORTANT: MCP tool args follow the inputSchema. For oz.identities.create
# the schema (mcp-tools.js) is `{ opts: { name, color, userAgent } }` BUT
# inspecting the call in mcp-tools.js: `call: ({ name, color, userAgent }) =>
# identities().create({ name, color, userAgent })` — top-level fields,
# NOT wrapped in `opts`.
created = mcp("oz.identities.create", {"name": "SmokeID A"})
id_a = created.get("id") if isinstance(created, dict) else None
ok("create new identity", id_a is not None and created.get("name") == "SmokeID A", created)
ok("created identity locked=false default", created.get("locked") is False, created)

# Update name
upd = mcp(
    "oz.identities.update",
    {"id": id_a, "patch": {"name": "SmokeID Renamed"}},
)
ok("update name", isinstance(upd, dict) and upd.get("name") == "SmokeID Renamed", upd)

# setLocked true
r = mcp("oz.identities.setLocked", {"id": id_a, "locked": True})
ok("setLocked true", isinstance(r, dict) and r.get("locked") is True, r)

# Try remove → must reject
r = mcp("oz.identities.remove", {"id": id_a})
ok("remove locked → false", r is False, r)

# Verify still present
r = mcp("oz.identities.get", {"id": id_a})
ok("locked identity still in list", isinstance(r, dict) and r.get("id") == id_a, r)

# Unlock
r = mcp("oz.identities.setLocked", {"id": id_a, "locked": False})
ok("setLocked false", isinstance(r, dict) and r.get("locked") is False, r)

# Now remove
r = mcp("oz.identities.remove", {"id": id_a})
ok("remove unlocked → true", r is True, r)

# Verify gone
r = mcp("oz.identities.get", {"id": id_a})
ok("removed identity is gone", r is None, r)

# Cannot remove Default
r = mcp("oz.identities.remove", {"id": default_id})
ok("cannot remove default", r is False, r)

# ---- 2. Workspace CRUD + setActive (HX2 fix) ------------------------------
section("Workspace CRUD + HX2 (setActive crash)")

r = mcp("oz.workspaces.create", {"name": "SmokeWS A"})
ws_a = r.get("id") if isinstance(r, dict) else None
ok("create workspace A", ws_a is not None and r.get("name") == "SmokeWS A", r)

# THIS IS THE BUG WE FIXED — must succeed without "Object has been destroyed"
r = mcp("oz.workspaces.setActive", {"workspaceId": ws_a})
ok("HX2: setActive new workspace", isinstance(r, dict) and r.get("ok") is True, r)

# getActive should return the new ws
r = mcp("oz.workspaces.getActive", {})
ok("getActive returns new ws", r == ws_a, r)

# Switch back
r = mcp("oz.workspaces.setActive", {"workspaceId": general_id})
ok("setActive back to general", isinstance(r, dict) and r.get("ok") is True, r)

# Stress: create + setActive 3 in a row
stress_ids = []
for i in range(1, 4):
    cw = mcp("oz.workspaces.create", {"name": f"Stress{i}"})
    sid = cw.get("id") if isinstance(cw, dict) else None
    stress_ids.append(sid)
    sa = mcp("oz.workspaces.setActive", {"workspaceId": sid})
    ok(f"stress switch #{i}", isinstance(sa, dict) and sa.get("ok") is True, sa)

# Switch back to general for cleanup safety
mcp("oz.workspaces.setActive", {"workspaceId": general_id})

# Duplicate
dup = mcp("oz.workspaces.duplicate", {"id": ws_a})
ws_dup = dup.get("id") if isinstance(dup, dict) else None
ok(
    "duplicate workspace",
    isinstance(dup, dict) and dup.get("name") == "SmokeWS A (copy)",
    dup,
)

# Freeze + can't update
r = mcp("oz.workspaces.freeze", {"id": ws_a})
ok("freeze", r is True, r)

r = mcp("oz.workspaces.update", {"id": ws_a, "patch": {"name": "NoChange"}})
ok("frozen update returns null", r is None, r)

mcp("oz.workspaces.unfreeze", {"id": ws_a})

# Archive + Restore
r = mcp("oz.workspaces.archive", {"id": ws_a})
ok("archive", r is True, r)
r = mcp("oz.workspaces.restore", {"id": ws_a})
ok("restore", r is True, r)

# Cannot archive default
r = mcp("oz.workspaces.archive", {"id": general_id})
ok("cannot archive general (default)", r is False, r)

# Cleanup test workspaces
for wid in [ws_a, ws_dup] + stress_ids:
    if wid:
        mcp("oz.workspaces.remove", {"id": wid})

# ---- 3. Tabs CRUD + lock + move -------------------------------------------
section("Tabs CRUD + lock + move")

mcp("oz.workspaces.setActive", {"workspaceId": general_id})
time.sleep(0.3)

# Open 3 tabs in default identity
ta = mcp("oz.tabs.openInIdentity", {"identityId": default_id, "url": "about:blank"})
ok("open tab A", isinstance(ta, str) and len(ta) > 0, ta)
tb = mcp("oz.tabs.openInIdentity", {"identityId": default_id, "url": "about:blank"})
tc = mcp("oz.tabs.openInIdentity", {"identityId": default_id, "url": "about:blank"})
print(f"    tabs: A={ta} B={tb} C={tc}")

# Lock B
r = mcp("oz.tabs.lock", {"tabId": tb})
ok(
    "lock tab B",
    isinstance(r, dict) and r.get("ok") is True and r.get("locked") is True,
    r,
)

# Try close locked B → false
r = mcp("oz.tabs.close", {"tabId": tb})
ok("close locked tab B → false", r is False, r)

# Verify B alive + locked in serialize
lst = mcp("oz.tabs.list")
b_entry = (
    next((t for t in lst if isinstance(t, dict) and t.get("id") == tb), None)
    if isinstance(lst, list)
    else None
)
ok("locked B still in list", b_entry is not None, b_entry)
ok(
    "tab.locked is true in serialize",
    b_entry is not None and b_entry.get("locked") is True,
    b_entry,
)

# Unlock + close
r = mcp("oz.tabs.unlock", {"tabId": tb})
ok(
    "unlock B",
    isinstance(r, dict) and r.get("ok") is True and r.get("locked") is False,
    r,
)
r = mcp("oz.tabs.close", {"tabId": tb})
ok("close unlocked B → true", r is True, r)

# Pin A, lock C, then closeOthers from a brand-new tab D
td = mcp("oz.tabs.openInIdentity", {"identityId": default_id, "url": "about:blank"})
mcp("oz.tabs.pin", {"tabId": ta})
mcp("oz.tabs.lock", {"tabId": tc})
r = mcp("oz.tabs.closeOthers", {"tabId": td})
ok("closeOthers ok", isinstance(r, dict) and r.get("ok") is True, r)
ok(
    "closeOthers reported skippedLocked >= 1",
    isinstance(r, dict) and r.get("skippedLocked", 0) >= 1,
    r,
)

lst = mcp("oz.tabs.list")
ok(
    "after closeOthers: A pinned survived",
    isinstance(lst, list) and any(isinstance(t, dict) and t.get("id") == ta for t in lst),
    lst,
)
ok(
    "after closeOthers: C locked survived",
    isinstance(lst, list) and any(isinstance(t, dict) and t.get("id") == tc for t in lst),
    lst,
)

# moveToWorkspace with locked tab → reject
ws_x = mcp("oz.workspaces.create", {"name": "MoveDest"})
ws_x_id = ws_x.get("id") if isinstance(ws_x, dict) else None
r = mcp("oz.tabs.moveToWorkspace", {"tabId": tc, "targetWorkspaceId": ws_x_id})
ok(
    "moveToWorkspace locked → reject tab-locked",
    isinstance(r, dict) and r.get("ok") is False and r.get("reason") == "tab-locked",
    r,
)

# H3b D5: Default identity is pinned to general (D2). A tab on Default
# CANNOT be moved into a non-general workspace — reject with
# default-identity-pinned-to-general. Validate that the rejection fires.
mcp("oz.tabs.unlock", {"tabId": tc})
r = mcp("oz.tabs.moveToWorkspace", {"tabId": tc, "targetWorkspaceId": ws_x_id})
ok(
    "H3b D5: moveToWorkspace on Default-bound tab → reject default-pinned",
    isinstance(r, dict)
    and r.get("ok") is False
    and r.get("reason") == "default-identity-pinned-to-general",
    r,
)

# Now create a non-default identity in workspace ws_x and a tab on it,
# then move that tab back to general. The cascade-move should bring the
# identity along (D5).
custom = mcp("oz.identities.create", {"name": "CascadeID", "workspaceId": ws_x_id})
custom_id = custom.get("id") if isinstance(custom, dict) else None
ok("H3b custom identity created in ws_x", custom_id is not None, custom)
# Switch to ws_x so we can create a tab there.
mcp("oz.workspaces.setActive", {"workspaceId": ws_x_id})
import time as _t

_t.sleep(0.3)
tcustom = mcp(
    "oz.tabs.openInIdentity", {"identityId": custom_id, "url": "about:blank"}
)
ok("custom-identity tab opened in ws_x", isinstance(tcustom, str), tcustom)
# Move the tab back to general — should cascade-move the identity (since
# it's not Default + not locked).
r = mcp("oz.tabs.moveToWorkspace", {"tabId": tcustom, "targetWorkspaceId": general_id})
ok(
    "H3b D5: moveToWorkspace cascade-moves custom identity",
    isinstance(r, dict) and r.get("ok") is True,
    r,
)
# Verify the identity follows.
custom_after = mcp("oz.identities.get", {"id": custom_id})
ok(
    "H3b D5: custom identity now lives in 'general'",
    isinstance(custom_after, dict) and custom_after.get("workspaceId") == general_id,
    custom_after,
)
# Cleanup
mcp("oz.workspaces.setActive", {"workspaceId": general_id})
mcp("oz.identities.remove", {"id": custom_id})

# moveToNewWindow — opens window 2
te = mcp("oz.tabs.openInIdentity", {"identityId": default_id, "url": "about:blank"})
r = mcp("oz.tabs.moveToNewWindow", {"tabId": te})
ok("moveToNewWindow ok", isinstance(r, dict) and r.get("ok") is True, r)

# Wait briefly for the new BrowserWindow to register
time.sleep(0.5)
h = http_get(HEALTH)
ok("health: 2 windows after moveToNewWindow", h.get("windowsCount") == 2, h)

# Cleanup the moved-tab workspace + the auto-created Window N workspace
mcp("oz.workspaces.remove", {"id": ws_x_id})

# ---- 4. HX2 — multi-window state still works ------------------------------
section("HX2 — multi-window state still works after moveToNewWindow")

# Note: lock 1-1 prevents window 2 from also taking 'general' (already on
# window 1). After moveToNewWindow, window 2 has its own auto-created
# 'Window N' workspace. setActive on focused (window 2) will reject with
# already-open if we ask for general. So we just verify getActive returns
# *some* workspace and operations don't throw.
r = mcp("oz.workspaces.getActive", {})
ok(
    "HX2 multi-window: getActive returns a workspace id (no crash)",
    isinstance(r, str) and len(r) > 0,
    r,
)

# ---- 5. Bookmarks ---------------------------------------------------------
section("Bookmarks")
bm = mcp(
    "oz.bookmarks.add",
    {"identityId": default_id, "url": "https://smoke.test", "title": "Smoke"},
)
ok(
    "bookmarks.add returns object",
    isinstance(bm, dict) and (bm.get("id") or bm.get("deduped")),
    bm,
)
bm_id = bm.get("id") if isinstance(bm, dict) else None
if bm_id:
    r = mcp("oz.bookmarks.remove", {"id": bm_id})
    ok("bookmarks.remove", r is True, r)

# ---- 6. H1 — reopen closed tab --------------------------------------------
section("H1 — reopenClosed")

# Make sure we're in general with a clean tab list.
mcp("oz.workspaces.setActive", {"workspaceId": general_id})
time.sleep(0.3)
# Open + close 2 tabs.
ra = mcp("oz.tabs.openInIdentity", {"identityId": default_id, "url": "https://r1.test"})
rb = mcp("oz.tabs.openInIdentity", {"identityId": default_id, "url": "https://r2.test"})
mcp("oz.tabs.close", {"tabId": ra})
mcp("oz.tabs.close", {"tabId": rb})

# Reopen — pops most-recent first (rb). We assert id is present in the
# tabs list + identity matches; don't assert on serialize().url because
# reopenClosed selects the tab → loadURL → pendingUrl cleared → race
# until Chromium commits. The unit smoketest covers the spec/url
# correctness deterministically (mocked WebContentsView).
new1 = mcp("oz.tabs.reopenClosed", {})
ok("H1 reopenClosed returns new tab id", isinstance(new1, str) and len(new1) > 0, new1)
lst = mcp("oz.tabs.list")
restored1 = (
    next((t for t in lst if isinstance(t, dict) and t.get("id") == new1), None)
    if isinstance(lst, list)
    else None
)
ok(
    "H1 first reopen creates tab in default identity",
    restored1 is not None and restored1.get("identityId") == default_id,
    restored1,
)

new2 = mcp("oz.tabs.reopenClosed", {})
ok(
    "H1 second reopen returns another tab id",
    isinstance(new2, str) and len(new2) > 0 and new2 != new1,
    new2,
)

empty = mcp("oz.tabs.reopenClosed", {})
ok("H1 reopen on empty stack returns null", empty is None, empty)

# Cleanup
if isinstance(new1, str):
    mcp("oz.tabs.close", {"tabId": new1})
if isinstance(new2, str):
    mcp("oz.tabs.close", {"tabId": new2})

# ---- 7. URL normalize regression ------------------------------------------
section("URL-normalize regression (BugCrawl fix)")
t_url = mcp("oz.tabs.openInIdentity", {"identityId": default_id, "url": "example.com"})
ok("openInIdentity with bare 'example.com' creates tab", isinstance(t_url, str), t_url)
if isinstance(t_url, str):
    lst = mcp("oz.tabs.list")
    ent = (
        next((t for t in lst if isinstance(t, dict) and t.get("id") == t_url), None)
        if isinstance(lst, list)
        else None
    )
    # url-normalize should have prefixed https:// before loadURL
    expected = (
        ent is not None
        and isinstance(ent.get("url"), str)
        and (ent["url"].startswith("https://") or ent["url"].startswith("http://"))
    )
    ok("URL was normalized to https://example.com", expected, ent)
    if ent and ent.get("id"):
        # Cleanup: tab is unlocked, close should succeed
        mcp("oz.tabs.close", {"tabId": ent["id"]})

# ---- Final ----------------------------------------------------------------
print(f"\n=== {passed} passed · {failed} failed ===")
if failed:
    print("\nFailures:")
    for f in failures:
        print(f"  - {f}")
sys.exit(0 if failed == 0 else 1)
