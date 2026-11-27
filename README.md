# claude-mod-session

A [Claude Code](https://claude.com/claude-code) mod for people who run many long-lived sessions side by side. Each session gets a **name**, a **role** (a role card) and a **group** (its terminal window), and sessions can write to each other by name.

The interface text is in French.

## What it does

- `/moi` shows this session's name, role and group, and lets you change them.
- `/sessions` lists every session of the machine, open or closed: filter, jump to its tab, or reopen it.
- `/role <name>` gives the session a role card and renames the session to it. `/role` alone opens a picker. A name with no card offers to write the card with the session, from the folder's `_MODELE.md` template.
- `/group <name>` names the terminal window; every session in it joins the group. `/group open <name>` reopens the closed members of a group, `/group close` closes its tabs (refused while a member is working, unless `--force`), `/group -` leaves the group.
- A tool for the model, `ecrire`, sends a message to another session by name or role, even a closed one: the message waits in its mailbox and is read as a turn when the session is open and free. It can also reopen the session.
- The status line shows the role and the group. A session with no role gets a reminder above the prompt. A warning shows when two live sessions hold the same role.

## Role cards

A role card is a short Markdown file that tells a session who it is, what it owns and what it leaves to others. Cards live in `.claude/roles/<role>.md`, looked up from the session's directory upwards (the nearest folder wins). Files starting with `_` are not roles. See [`examples/.claude/roles/`](examples/.claude/roles/).

The card is sent to the model as an instruction file: present at start, on `--resume` and after `/compact`. Edit it on disk and the new version reaches the session within a few seconds, at its next turn. The role is bound to the session id, not to its name; a fork inherits its parent's role and group.

## Terminal

Windows, tabs and focus go through an adapter in [`terminals/`](terminals/). The one shipped is for [kitty](https://sw.kovidgoyal.net/kitty/), which needs remote control enabled (`allow_remote_control`, `listen_on`). `SESSION_TERMINAL` selects another adapter.

## State

Everything is kept under `~/.local/state/claude-pool/`: one entry per session, one per window, and the mailboxes.

## Install

```
claude plugin install session --marketplace AlexisLaporte/claude-mod-session
```

Or from a clone: `claude --plugin-dir /path/to/claude-mod-session`, or set `CLAUDE_CODE_PLUGIN_DIRS` to that path.

## License

MIT.
