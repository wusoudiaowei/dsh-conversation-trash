# dsh-conversation-trash

[![test](https://github.com/wusoudiaowei/dsh-conversation-trash/actions/workflows/test.yml/badge.svg)](https://github.com/wusoudiaowei/dsh-conversation-trash/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A recycle bin for DeepSeek Harness conversations.** Delete a conversation from the
sidebar, undo for 8 seconds, restore it or purge it later.

DeepSeek Harness ships **archive** but no **delete**: its persistence layer exposes no
deletion primitive and the Workspace registry keeps every session log on purpose.
This plugin implements delete as a composition of supported operations — it never
patches the host binary and never touches the log format.

## Features

- **Move to trash** from the session row's `…` menu (danger-styled, below *Archive*)
- **Undo for 8 seconds** — a toast with an undo action, not a silent, irreversible delete
- **Subagent cascade** — subagent sessions owned by the deleted session go with it
- **Forks survive** — a fork is an independent conversation and is left alone
- **Running work is stopped first** through the host's own archive path
- **Recycle-bin panel** from a sidebar-footer button with a count badge: restore an
  entry, delete one forever, or empty the bin
- **Restore or purge** later; the trash lives at `~/.dsh/session-trash/`

## Install

```sh
dsh plugin --profile desktop add github:wusoudiaowei/dsh-conversation-trash
```

Or copy this folder to `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-conversation-trash`
and add it to the profile's `dsh.profile.bundles`, then restart DSH.
`install.ps1` does both steps on Windows and is idempotent.

## Usage

1. Hover a conversation row in the sidebar and open the `…` menu
2. Choose **删除对话 / Delete conversation**
3. The dialog previews the title and how many subagent sessions go with it
4. Confirm — the row leaves the list and a toast offers **Undo** for 8 seconds

## How it works

| Step | What happens |
|---|---|
| 1 | `workspaceRegistry.archiveSession(id, { stopActivity: true })` — stops running work and hides the row |
| 2 | the session directory moves from `~/.dsh/sessions/<workspace>/<session-id>/` to `~/.dsh/session-trash/<session-id>/` |
| 3 | an entry is written to `~/.dsh/session-trash/index.json` (atomic temp-file + rename) |

Restore moves the directory back and unarchives the session. Purge deletes it for good.

Two Windows-specific details: the log file is often still open when the move runs, so
the move retries with backoff and a failed attempt is recorded as `moved: false` and
finished by a startup sweep; and the session id already carries its `session-` prefix,
so the host normalizes ids at the boundary instead of re-deriving them.

## HTTP surface

Loopback-only, same-origin, `application/json` POSTs:

| Method | Path | Purpose |
|---|---|---|
| GET | `/dsh-conversation-trash/list` | trash entries and total size |
| POST | `/dsh-conversation-trash/preview` | `{sessionId}` → title, subagent ids |
| POST | `/dsh-conversation-trash/delete` | `{sessionId, displayTitle}` |
| POST | `/dsh-conversation-trash/restore` | `{sessionId}` |
| POST | `/dsh-conversation-trash/purge` | `{sessionId}` |
| POST | `/dsh-conversation-trash/purge-all` | `{}` |

## Tests

```sh
node test/smoke.mjs        # delete → list → restore → purge against a throwaway HOME
node test/client-shape.mjs # the browser bundle registers the right slots
node test/dry-run.mjs      # read-only pass over the real ~/.dsh (skips cleanly if none)
```

CI runs the first two on Windows.

## Known limits

- A deleted conversation still appears under *All conversations (show archived)* until
  the next restart — it is archived and its log is already moved.
- Deleting the conversation you are currently viewing does not navigate away.
- Purging has no settings UI yet; use the HTTP route.
- Relies on host internals (slot names, `archiveSession`, the log directory layout).
  A future DSH release may break it; failures are visible, never destructive.
- If upstream ever ships a real `session/delete`, this plugin should be retired.

## Design notes

[`docs/design.md`](docs/design.md) walks through the constraints, the rejected
alternatives, and the four bugs that shaped the implementation.

## License

MIT

---

## 中文摘要

对话回收站：侧栏 `…` 菜单把会话移入回收站，8 秒内可撤销，之后可恢复或彻底删除；
子代理会话随父会话一起删，分叉保留。详见 [`使用说明.md`](使用说明.md)。