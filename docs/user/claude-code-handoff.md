# Claude Code CLI handoff

Work on one Claude conversation from both T3 Code and the Claude Code CLI, for example the
terminal in IntelliJ or VS Code. Both sides continue the same Claude session, so each sees
everything the other did. Switching takes a few seconds.

The CLI has to run on the machine that runs T3 Code. Both sides read the conversation from that
machine's `~/.claude/projects` folder.

## From T3 Code to the terminal

1. Wait for the thread's current turn to finish.
2. Right-click the thread in the sidebar, or open the thread menu in the header, and choose
   **Claude Code → Continue in terminal**. **Continue in Claude Code (terminal)** in the command
   palette does the same.
3. Choose **Copy command**, then run it in a terminal:

   ```sh
   cd /path/to/project && claude --resume <session id>
   ```

T3 Code stops its own Claude process for the thread, so the process can't keep running on an old
copy of the conversation. If cache keep-alive was on for the thread, it is turned off so T3 Code
stops writing to the session while you work in the terminal. Turn it back on from the composer
whenever you like.

For a Claude instance that keeps its data somewhere other than `~/.claude`, the command sets
`CLAUDE_CONFIG_DIR` for you.

## From the terminal back to T3 Code

New turns from the terminal show up in the thread, after the turns that came before them. When you
send the next message in T3 Code, Claude has the whole conversation, terminal turns included.

T3 Code picks them up in any of these ways:

- **A Claude Code hook (recommended).** Each terminal turn appears in T3 Code a moment after
  Claude answers. Add this to `~/.claude/settings.json`, or to one project's
  `.claude/settings.json`:

  ```json
  {
    "hooks": {
      "Stop": [{ "hooks": [{ "type": "command", "command": "t3 import hook", "async": true }] }]
    }
  }
  ```

  If `t3` is not on your `PATH`, use the full path to the `t3` command or `npx t3 import hook`. Add
  `--base-dir <dir>` when your server does not use the default T3 home. The hook ignores Claude
  processes that T3 Code itself runs. It never fails the CLI, even when T3 Code is not running.

- **Sync terminal turns.** Before you continue in T3 Code, choose **Claude Code → Sync terminal
  turns** from the thread menu, or **Sync turns from Claude Code** from the command palette. Use it
  without the hook, and after `claude -p`, which exits before an async hook can finish.

- **`t3 import sync`.** Scans every transcript, imports new CLI sessions as threads, and adds new
  terminal turns to threads T3 Code has already continued. Schedule it if you want new CLI
  sessions to appear on their own.

Sync before you send the next message in T3 Code. A turn that T3 Code has not picked up is missing
from the thread, and from Claude's memory in T3 Code, until you sync.

## A conversation that started in the terminal

Import it once with `t3 import claude <session id or .jsonl path>`, or let the hook import it at the
end of its first turn. The thread resumes the same session, so you can keep switching both ways.

## One side at a time

Both sides write to the same transcript. Don't send messages from T3 Code and the terminal at the
same time, or the conversation splits into two branches. Finish in one place before you continue in
the other.
