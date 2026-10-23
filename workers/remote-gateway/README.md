# reasonix-remote-gateway

Low-bandwidth, message-only remote access gateway for Reasonix Studio. It
authenticates registered devices and one-time controller grants through the
account service, then joins both WebSockets in a per-device Durable Object.

The gateway treats message bodies as opaque end-to-end encrypted payloads. It
does not persist messages, proxy files, or carry desktop video. Idle sockets use
the Durable Objects Hibernation API.

## WebSocket endpoints

- `GET /v1/devices/:deviceId/connect` with `Authorization: Bearer <deviceCredential>`
- `GET /v1/sessions/connect` with `Authorization: Bearer <oneTimeGrant>`

The account service can also batch-check live device sockets through
`POST /v1/devices/status`, and close revoked ones through
`POST /v1/devices/revoke`. These internal endpoints require the shared gateway
secret; browser clients never receive it. Registered devices are not treated as
online merely because they connected in the past.

Browser controllers use the requested subprotocols `reasonix.remote.v1` and
`reasonix.auth.<oneTimeGrant>` because the WebSocket browser API cannot set an
Authorization header. The gateway selects only `reasonix.remote.v1`; the ticket
is consumed before the request enters the device session and is never echoed.

Text messages are limited to 64 KiB and each device accepts at most four
controller connections. Each controller receives a private connection ID;
device replies must target that ID, so responses are never broadcast to other
controllers. The account service and this Worker share the
`REMOTE_GATEWAY_TOKEN` Worker secret.

## Admission and leases

A credential is checked once, at the WebSocket upgrade. Controller grants are
one-time and expire 60 seconds after the account service issues them; a device
credential lasts until the device is revoked. An open connection is never cut
because the credential that admitted it has aged.

After admission each connection holds a lease:

| | Controller | Device |
|---|---|---|
| Idle limit, sliding on the connection's own frames | 30 minutes | 30 minutes |
| Also counts as activity | — | `{"type":"heartbeat"}`, answered by the runtime without waking the object |
| Hard limit | the signing-in account session reaches 24 hours old | none |
| Re-checked against the account service | every 15 minutes | every 15 minutes |

The account service refuses to issue a grant from a session older than 24 hours,
or from a device-flow (`cli`) session, whose age says nothing about when a
password was last entered (`remote_reauth_required`). The hard limit therefore
cannot be reset by reconnecting; only a fresh password sign-in resets it. A grant
that does not carry `reauthAt` is refused.

The idle limit reclaims connections whose page is closed or frozen; an open
Web Studio page polls every few seconds, so it is not a measure of whether a
person is present. A full room (four controllers) closes its quietest controller
if that one has been silent for a minute, and refuses the new one otherwise.

When the re-check cannot reach the account service the connections stay open,
but only until an hour passes without a successful check; then every
connection closes with 4408 and has to be admitted again. Admission time is
taken before the account service is asked, and the room remembers device and
session revocations, so an admission already in flight when a revocation lands
is refused. Removing a device, changing or resetting the
password and deleting the account push `POST /v1/devices/revoke` so live
connections close at once; signing out pushes the same call with the session,
which closes only that session's controllers. The five-minute re-check bounds
the delay when a push is lost.

Each close carries a code the client acts on without reading the reason text:

| Code | Meaning | Client action |
|---|---|---|
| 4408 | idle limit reached | reconnect silently with a fresh grant |
| 4401 | the account session must sign in again (age limit or signed out) | ask the user to sign in |
| 4403 | the device or the account's access was revoked | stop; do not retry |
| 4004 | the desktop disconnected this controller | stop; do not retry |
| 4001 | a newer device connection replaced this one | device only |

A device connection is greeted with `relay_hello`, which lists the controllers
still attached, so a reconnecting desktop keeps their encrypted sessions, and
names the heartbeat frame. Controllers stay attached while their device
reconnects.

## Deployment

Production deployment runs from the existing `deploy-accounts-worker.yml`
workflow on the `platform` branch. The workflow applies the account database
migrations, deploys the account service, then this gateway, so their shared
authentication contract and secret cannot be released in the wrong order.
The gateway refuses grants without `reauthAt`, so it must never be deployed
ahead of an account service that sends it.

Encrypted attachments use the private `reasonix-remote-attachments` R2 bucket.
Objects are always served as `application/octet-stream` with content sniffing
disabled. The bucket has a one-day lifecycle rule; authorization expires after
15 minutes even when physical deletion has not run yet.
