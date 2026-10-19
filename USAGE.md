# Instructions · dsh-conversation-trash

Adds a **Delete conversation** action to the DSH sidebar: soft delete into a
recycle bin, undoable for 8 seconds, subagent sessions deleted with their
parent, forks left alone.

## Install (already done in this environment)

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Copies the package to `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-conversation-trash`
and appends one loader row to the profile's `cordis.patch.yml` (backed up first).
Fully quit DSH and start it again.

Uninstall:

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

## Use

1. Hover a conversation row → `…` → **删除对话** (red, below 归档会话)
2. The dialog previews the title, how many subagent sessions go with it, and
   that running work is stopped first
3. **移入回收站** → the row leaves the list, a toast offers **撤销** for 8s

## What it does on the host

1. `archiveSession(id, { stopActivity: true })` — stops running work and hides
   the row from the default view
2. Moves `~/.dsh/sessions/<workspace>/session-<id>/` to
   `~/.dsh/session-trash/<id>/`
3. Records the move in `~/.dsh/session-trash/index.json`

Restore moves the directory back and unarchives the session.

## HTTP surface

Loopback-only, same-origin, `application/json` POSTs:

| Method | Path | Purpose |
|---|---|---|
| GET | `/dsh-conversation-trash/list` | trash entries + total size |
| POST | `/dsh-conversation-trash/preview` | `{sessionId}` → title, subagent ids |
| POST | `/dsh-conversation-trash/delete` | `{sessionId, displayTitle}` |
| POST | `/dsh-conversation-trash/restore` | `{sessionId}` |
| POST | `/dsh-conversation-trash/purge` | `{sessionId}` |
| POST | `/dsh-conversation-trash/purge-all` | `{}` |

Example:

```powershell
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:<port>/dsh-conversation-trash/purge" `
  -ContentType "application/json" -Body '{"sessionId":"<id>"}'
```

## Verification

```powershell
$node = "C:\Users\Lenovo\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node test/smoke.mjs        # delete → list → restore → purge against a temp HOME
& $node test/client-shape.mjs # bundle registration and both slot registrations
& $node test/dry-run.mjs      # read-only pass over the real ~/.dsh
```

## Known limits

- Right after a delete the session still shows under **全部对话（显示已归档）**
  until the next restart (it is archived and its log is already moved).
- Cascade relies on `parentSession` in session summaries.
- Deleting the session you are currently viewing does not navigate away.
- Purging has no settings UI yet; use the HTTP route.
- This rides a community extension point. If upstream ships `session/delete`,
  retire this plugin.
