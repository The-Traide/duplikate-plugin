# Duplikate for Claude Code

[Duplikate](https://duplikate.io) keeps your engram: the rules, decisions, preferences, playbooks and voice you have kept from your own record. This plugin connects Claude Code to it, in two parts.

- **The tools**, from Duplikate's MCP server at `https://duplikate.io/mcp`:
  - `consult` asks your engram what you would decide, before Claude Code acts for you;
  - `correct` tells it you decided otherwise, which becomes a node you review;
  - `record_outcome` says what happened;
  - `propose` puts a message up for your approval instead of sending it.
- **The gate**, a hook that runs before Claude Code opens a pull request, sends mail or posts a message. It asks Duplikate whether Claude Code consulted your engram for that kind of action in the last ten minutes:
  - no consult: the action is refused, and Claude Code is told to consult first;
  - your engram would hold, it has no precedent, or this is a blind check (one consult in five): you are asked;
  - the connection is paused, or today's limit is reached: you are asked;
  - your engram would go ahead, or go ahead with a change: your own permission settings decide, and Claude Code sees the ruling.

  The gate never approves an action on its own: it only narrows what your settings already allow. Afterwards, a second hook tells Duplikate the action was done, so the record shows how often your engram agreed with you.

## Install

1. `/plugin marketplace add The-Traide/duplikate-plugin`
2. `/plugin install duplikate@duplikate-plugin`
3. Run `/mcp`, choose the duplikate server, and sign in. Duplikate asks you to approve the connection.
4. On Duplikate's Connections screen, choose the actions the connection's gate checks, and create a hook key.
5. `/plugin configure duplikate@duplikate-plugin`, and paste the key as the Hook key. It is kept in your system's secure storage, not in a settings file.

Until the key is set, the gate blocks every action it checks. An action the connection's gate does not check passes untouched.

## What the gate sends, and when it blocks

The hook sends Duplikate the kind of action and the hook key, and nothing else: never the command, the pull request, the mail or the message. The key travels in a request header, and never on a command line.

It blocks when it cannot get an answer: Duplikate unreachable, an error, no answer within ten seconds, a missing or revoked key, or an answer that is not a decision. It needs Claude Code 2.1.295 or later, `curl`, and a POSIX shell (macOS, Linux, or Windows with Git Bash).

What Duplikate keeps of each call, and for how long, is in its [Privacy policy](https://duplikate.io/legal/privacy).

## What is gated

| Action | Gated when Claude Code runs |
|---|---|
| Opening a pull request | `gh pr create` or `gh pr new` in Bash; an MCP tool named `create_pull_request`, from any server |
| Sending mail | A Gmail MCP server's `send_message`, `reply` or `forward` |
| Posting a message | A Slack MCP server's `slack_send_message` or `slack_schedule_message` |

Nothing else is gated. A mail or chat tool under any other name, another way of opening a pull request (such as `gh api`), `git push` and `gt submit` all pass untouched. The tests in `tests/` hold this list.

## Tests

`node --test tests/` runs them, with no dependencies. They check the manifests, the list above against real and lookalike tool names, every hook against one template, and each hook against a local server answering a decision, an error, plain text, nothing in time, or no connection at all.
