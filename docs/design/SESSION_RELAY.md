---
owner: @Oliver-Rui
status: proposed
---

# Session relay: messages between sessions

Status: proposed. Nothing in this document is shipped unless §10 says so. It lives under `docs/design/` so the product-doc retrieval corpus (`docs/*.md`) cannot present it to a model as a feature.

## 1. Purpose

Studio already moves a question between contexts in two places: `/side` asks a one-shot question of an ephemeral side conversation, and `/subagents/{ref}/steer` nudges a running sub-agent. Neither is a *message*: nothing is addressed, nothing is kept, and nothing comes back.

Session relay is the missing primitive. One session sends another session a text message; the kernel delivers it as a turn in the receiving session; the answer comes back to the sender, synchronously (bounded) or asynchronously (event). The point is a working session consulting another working session — "ask the session that already debugged this build" — without the user copying text between panes.

| ID | Principle |
| --- | --- |
| P1 | The kernel owns the relay. No shell, renderer or pane keeps a second copy of relay state. |
| P2 | One transport. Relay runs as HTTP + SSE routes on the existing mux, behind the existing loopback gate. No Electron IPC variant of the agent API is built for it. |
| P3 | A relay message carries text only. It carries no credential, no permission grant, no approval and no tool result. |
| P4 | The receiver executes in its own permission context. A message never widens what a session may do. |
| P5 | Every relay message is a fact the kernel records. Delivery and reply are replayable events, not notifications a client may have missed. |
| P6 | A session cannot message itself, and a forwarded chain stops at five hops. |
| P7 | Every synchronous wait is bounded (120 s) and then converts to asynchronous. No request waits on another session forever. |
| P8 | The kernel attaches the provenance prefix, never the sender. A receiver always learns the message crossed a session boundary. |

## 2. What exists today

| Primitive | Shape | Kept? | Replies? |
| --- | --- | --- | --- |
| `POST /side`, `POST /side/{id}/ask`, `DELETE /side/{id}` | ephemeral side conversation held by this runtime | no — "gone with it; nothing about it is written anywhere" | yes, one JSON answer, request-scoped |
| `POST /subagents/{ref}/steer` | nudge a running sub-agent | run record only | no |
| `POST /sessions/viewed` | the kernel already owns "unread" as a fact per session | yes | n/a |
| `GET /events`, `GET /events/replay` | typed event stream with replay | yes | n/a |

Relay is not a replacement for any of these. It differs from `/side` in exactly three ways: the peer is a durable session rather than a runtime-held scratch conversation, the exchange is recorded, and the answer returns to the *sender* rather than to whoever asked.

## 3. Shape

```
sender pane                 kernel                       receiver pane
    |  POST /relay/send      |                                |
    |  {to, body, mode}----->| validate (P6, P7)              |
    |                        | record message (durable)       |
    |                        | inject user turn w/ prefix --->|  agent runs
    |                        |                                |  turn completes
    |  mode=sync: hold the   |<-------- reply = turn output --|
    |  request (<=120 s)     | event relay.replied on /events |
    |  mode=async: ack now   |                                |
    |<---- 200 / event ------|                                |
```

- **Synchronous** mirrors `askSide`: `POST /relay/send` holds until the receiver's turn completes, with the same `Accept: text/event-stream` opt-in for request-scoped progress, and the same 120 s ceiling. On expiry the kernel converts to asynchronous and the answer still arrives, matched by message id.
- **Asynchronous** returns `{id, state}` immediately; the answer arrives later as a typed event on the existing stream.
- **The reply is the receiver's next completed turn.** No new reply verb is needed for the desktop client: the kernel marks the message answered when the injected turn completes, exactly as a submit already produces text events. An explicit `POST /relay/{id}/reply` is reserved for CLI clients that have no turn to give.

## 4. Routes (proposed)

Registered in `internal/frontend/serve` beside the existing feature files, following the `routes.go` pattern.

| Route | Kind | Notes |
| --- | --- | --- |
| `POST /relay/send` | canonical write | `{to, body, mode}`; refusal codes `relay.self`, `relay.unknown`, `relay.hop_limit`, `relay.too_large`, `relay.rate_limited`, `relay.busy` |
| `GET /relay/inbox` | canonical read | durable messages addressed to this session's user; paged like existing lists |
| `GET /relay/thread/{id}` | canonical read | one message with its reply, for the audit view |
| `GET /events` (existing) | replayable events | new kinds `relay.delivered`, `relay.replied`, `relay.timeout` |

The contacts list is **not** a new route: addressable sessions are `GET /sessions`, already a projection. Unread state reuses the fact the kernel already owns (`POST /sessions/viewed` clears it); relay delivery marks the receiver unread through that same fact, never a second copy.

Refusal detail passes `secrets.RedactCredentials`, as `sideReason` does.

## 5. State taxonomy

Per `docs/STUDIO_SHELL_BOUNDARIES.md` §6, deciding which kind a thing is comes before deciding its API:

| Kind | Relay thing | Carried by |
| --- | --- | --- |
| Durable intent | the message record: id, from, to, body, hop, state, timestamps | canonical read/write (`/relay/inbox`, `/relay/thread/{id}`); the kernel is the only writer |
| Projection | contacts (`GET /sessions`), unread counts | pull |
| State whose loss changes execution | a message sent and not yet answered | replayable event on `/events`; a pane that was closed recovers it on replay, a synchronous sender is converted by P7 |

## 6. Security boundary

- **Inside the existing gate.** Relay routes sit on the same mux as everything else, so the loopback boundary (per-launch credential, exact Host, exact Origin on writes) applies without new code. The user's `[serve]` authentication does not participate, exactly as for every other route.
- **Text only, bounded.** Body cap 32 KiB and a per-session rate limit; a receiver is never handed a tool result, a file, a screenshot or a credential by virtue of receiving a message.
- **No authority through a message.** A relay message cannot approve, cancel or decide anything. Approvals remain the kernel's, per session, unchanged by who sent what.
- **Provenance is kernel-attached.** Delivery injects the turn prefixed `【会话对话|来自会话「<title>」】` and the reply is prefixed `【会话对话|会话「<title>」的回信】`, so the receiving model always knows the text crossed a boundary and must answer self-contained — it cannot see the sender's context.
- **Hop counting.** `hop` starts at 1 and increments at each forward; a message that would exceed 5 is refused with `relay.hop_limit`.

## 7. Studio surface

`desktop/frontend-next` renders it; it invents no state of its own.

- **Contacts** are the existing session rows. Sending is a row action and a composer picker — no new sidebar section; the sidebar's vertical space is the scarce resource and the session list is its main content.
- **Waiting** reuses the `.pip` pattern already documented in `src/styles/LAYOUT.md` for a request sent and not yet answered, with the 120 s ceiling visible.
- **Received** messages render as their own message kind carrying the kernel-attached prefix, and mark the session unread through the existing row-end unread fact.
- **Replied** messages arrive on the existing event stream; no polling.

## 8. Out of scope for v1

- **Agent-initiated relay.** Only a user sends. An agent deciding on its own to message another session widens the blast radius of every prompt-injection surface and is deferred until P3/P4 have running code behind them.
- **Cross-kernel relay.** Two kernels on two machines have no shared identity today; the remote UI shares routes, not sessions.
- **External agents.** The CLI (`cmd/reasonix`) as a contact is a natural second step once the desktop path exists.

## 9. Open questions

1. Should the reply be the receiver's *next completed turn* (recommended, no new verb) or an explicit `POST /relay/{id}/reply` even on desktop?
2. Does a relay message appear in the receiver's transcript as a user turn (recommended, it *is* one) or as a system-role annotation?
3. Is the contacts surface a row action only, or does a session gain an addressable name beyond its title?

## 10. Stages

| Stage | Content | Acceptance |
| --- | --- | --- |
| M1 | kernel: routes §4, validation §6, persistence §5, events | two real sessions exchange a message; `/relay/inbox` and replay recover it; `relay.self`, `relay.hop_limit`, 120 s conversion each have a failing-first test |
| M2 | desktop surface §7 | send from a row, receive in a pane, unread fact shared with the existing dot, no second copy of state anywhere |
| M3 | hardening | permission-context test proving a message widens nothing; rate limit and size cap enforced; audit view reads a full thread |
| M4 | evaluate §8 items | only after M1–M3 have run in production-shaped use |

Nothing in this document is a commitment; it is the shape a review can argue with.
