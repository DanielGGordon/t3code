<p align="center">
  <a href="https://t3.codes">
    <img src="./assets/prod/t3-black-web-icon-192x192.png" width="80" height="80" alt="T3 Code logo" />
  </a>
</p>

<h1 align="center">T3 Code</h1>

<p align="center">The open-source control plane for coding agents.</p>

<p align="center">
  <a href="https://t3.codes/download"><strong>Download</strong></a> ·
  <a href="https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824">iOS</a> ·
  <a href="https://play.google.com/store/apps/details?id=com.t3tools.t3code">Android</a> ·
  <a href="https://app.t3.codes">Web</a> ·
  <a href="./docs/README.md">Docs</a> ·
  <a href="https://discord.gg/jn4EGJjrvv">Discord</a>
</p>

<p align="center">
  <a href="https://t3.codes">
    <img src="./.github/readme/hero.webp" width="100%" alt="T3 Code on desktop with a finished Claude thread, next to the phone app asking to approve a command from Codex" />
  </a>
</p>

> This is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) with a batch of extra features on top — selectable color themes, header usage/spend meters, cross-chat AI restart alerts, a flat "chats by activity" sidebar, per-device feature toggles, and an Android build. See [What this fork adds](#what-this-fork-adds).

T3 Code runs the coding agents on your machine and gives them one fast interface. Start a thread at your desk, then approve the next step from your phone.

It works with Claude Code, Codex, Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi, Muse Code, fx, and any [ACP](./docs/user/providers-acp.md) agent. If an agent is set up on your computer, T3 Code can control it.

## What you get

- **Your subscriptions.** T3 Code does not resell tokens. It drives the agents you are already signed in to.
- **Every agent in one place.** Change models in the middle of a thread. Let Claude hand a task to Codex.
- **Desktop, web, and phone.** One server, and every client shows the same threads. There are apps for iOS and Android.
- **Remote ready.** Run agents on any machine. Connect over your local network, Tailscale, or [T3 Connect](./docs/user/remote-access.md).
- **Git built in.** Each thread can work in its own worktree. Review the diff, then commit, push, and open a pull request with one button.
- **Fast.** Performance is a feature here. We measure it, and we treat a dropped frame as a bug.
- **Open.** MIT licensed. If you don't like something, fork it.

## Install

### Desktop app

[Download T3 Code](https://t3.codes/download) for macOS, Windows, or Linux. You can also use a package manager:

| Platform       | Command                                                              |
| -------------- | -------------------------------------------------------------------- |
| macOS          | `brew install --cask t3-code`                                        |
| Windows        | `winget install T3Tools.T3Code` or `scoop install extras/t3code`     |
| Arch Linux     | `yay -S t3code-bin`                                                  |
| Nix            | `nix profile add github:NixOS/nixpkgs/nixos-unstable#t3code`         |
| Debian, Ubuntu | `.deb` from [Releases](https://github.com/pingdotgg/t3code/releases) |

### Command line

This installs the `t3` command. Run `t3` to start the server and open the web app.

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

To try it once without an install, run `npx t3@latest`.

### Phone

Get the app from the [App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or [Google Play](https://play.google.com/store/apps/details?id=com.t3tools.t3code). Then follow [remote access](./docs/user/remote-access.md) to connect it to your computer.

### Sign in to an agent

T3 Code needs one agent that is installed and signed in. For example, install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`, or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`.

[Provider setup](./docs/user/install.md#providers) has the steps for each agent. [Install T3 Code](./docs/user/install.md) covers nightly builds, AppImage, WSL, and NixOS.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the tool that you want.

## What this fork adds

Everything below is additive on top of upstream T3 Code. Screenshots are from a live instance.

### 🎨 Selectable color themes

A **color scheme** axis that is independent of the light/dark toggle. Pick from **Solarized, Dracula, Gruvbox, Catppuccin, and Tokyo Night** — each ships a full light _and_ dark variant — or stay on Default. The scheme re-tints the whole app (sidebar, chat, header) and is applied before first paint, so there's no flash, and it syncs across browser tabs.

Set it in **Settings → General**, right below the light/dark **Theme** control:

![Theme and color scheme controls in Settings](./docs/images/appearance-settings.png)

<table>
  <tr>
    <td width="50%"><img src="./docs/images/theme-solarized-light.png" alt="Solarized Light" /><br/><sub><b>Solarized · Light</b></sub></td>
    <td width="50%"><img src="./docs/images/theme-solarized-dark.png" alt="Solarized Dark" /><br/><sub><b>Solarized · Dark</b></sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="./docs/images/theme-dracula.png" alt="Dracula" /><br/><sub><b>Dracula</b></sub></td>
    <td width="50%"><img src="./docs/images/theme-gruvbox.png" alt="Gruvbox" /><br/><sub><b>Gruvbox</b></sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="./docs/images/theme-catppuccin.png" alt="Catppuccin" /><br/><sub><b>Catppuccin</b></sub></td>
    <td width="50%"><img src="./docs/images/hero.png" alt="Tokyo Night" /><br/><sub><b>Tokyo Night</b></sub></td>
  </tr>
</table>

### 📊 Usage, spend & token meters in the header

Keep an eye on how much you're burning without leaving the chat. Small chips in the top bar always show the thread's **token usage** and your **Claude plan usage**; a bar-chart menu lets you switch on larger, color-coded readouts per device: **Context window**, **Spend estimate**, **Claude Session %**, **Claude Weekly %**, and **Codex subscription %**. Hovering a usage tile shows a countdown to when that limit window resets.

![Large color-coded usage stats in the chat header](./docs/images/usage-stats.png)

The **Codex** meter reads your Codex CLI subscription's rate-limit usage passively from local rollout files — no extra API calls — so it even reflects out-of-band `codex exec` runs. Toggle any stat from the header menu:

![Header usage stats toggle menu](./docs/images/usage-stats-menu.png)

### 🔁 Cross-chat AI restart alerts

When an agent asks you to restart the service it's working on, T3 Code surfaces it so your _other_ chats on the same project don't stomp on the restart. The requesting chat gets a banner with a **Mark resolved** action, its sidebar row shows a **Restart Requested** pill, and sibling chats get a "hold" banner. It auto-clears when you reply in the requesting chat.

![AI restart request banner and sidebar pill](./docs/images/restart-request.png)

### 🗂️ "Chats by activity" sidebar

Flip the sidebar from the grouped project tree into a single flat list of every chat, ordered by last activity, with each row tagged by its project. The choice persists per device.

![Flat chats-by-activity sidebar view](./docs/images/chats-by-activity.png)

### ⚙️ Per-device feature toggles

A **Settings → Features** page with auto/show/hide toggles for the chat header's action controls — Git actions, Open in editor, and Project scripts. "Auto" shows them on desktop and hides them on mobile-width screens. Stored per device.

![Features settings page](./docs/images/features-settings.png)

### And more

- **Resumable Claude Code conversation import** — `t3 import claude <session>` turns an existing Claude Code transcript into a resumable T3 thread, forking to a new transcript so your original session is untouched.
- **Missing-transcript diagnostics** — when a Claude thread can no longer be resumed because its `~/.claude/projects/…/<session>.jsonl` is gone (host reprovisioned, thread imported from another machine), the thread shows exactly which file is missing instead of a generic stream failure. `t3 session audit` lists every affected thread with the path to restore; `t3 session reset <threadId> --yes` is the explicit opt-in to start that thread over with a fresh Claude session.
- **Android app** — a full native Android build (Ghostty terminal, Shiki-highlighted code blocks, themed native chrome, self-signed-TLS trust, sideload APK publish script).
- **File explorer collapsed by default**, and a fix so the **left edge of message lines is selectable**.

## Documentation

- [Install and first run](./docs/user/install.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Source control](./docs/user/source-control.md)
- [Connect outside agents over MCP](./docs/user/outside-agents.md)
- [FAQ](./docs/user/faq.md)

[All docs](./docs/README.md) has the full list.

## Contributing

We have limited review capacity. Small, focused fixes are the most likely to be merged. Features need an approved discussion first.

- Read [CONTRIBUTING.md](./CONTRIBUTING.md) before you report a bug or open a pull request.
- Put feature requests in [Ideas](https://github.com/pingdotgg/t3code/discussions/categories/ideas).
- Build from source with the [development runbook](./docs/operations/development.md#first-checkout). The [architecture overview](./docs/internals/overview.md) explains how it works.
- Get help in [Discord](https://discord.gg/jn4EGJjrvv).

## License

[MIT](./LICENSE)
