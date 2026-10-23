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
`REMOTE_GATEWAY_TOKEN` Worker secret. A self-hosted gateway also sets
`ACCOUNT_CALLBACK_TOKEN`: the account service presents that one when it asks
about or revokes a device, while `REMOTE_GATEWAY_TOKEN` is what the gateway
presents to the account service, so neither secret can be used as the other.

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

## Running your own gateway

You can run the relay yourself and keep the account service ours. Only the
devices you bind to your gateway use it; everyone else, and your other devices,
stay on the hosted one. Message bodies are end-to-end encrypted either way, so
your gateway sees no more than ours does.

1. **Register it.** While signed in, `POST https://id.reasonix.io/me/gateways`
   with `{"label": "home", "origin": "https://relay.example.com"}`. The origin
   must be a public `https` address (no IP address, `localhost`, private name,
   path or credentials). The reply carries the gateway `id`, a `token` and a
   `callbackSecret`; **both secrets are shown once** and only the token's hash is
   kept. You can register 3 gateways; registering the same origin again after
   removing it issues new secrets. `GET /me/gateways` lists them and
   `DELETE /me/gateways/:id` removes one and revokes the devices bound to it.
2. **Deploy this Worker** under your own Cloudflare account with your route in
   `wrangler.toml`. Keep `ACCOUNT_ORIGIN = "https://id.reasonix.io"`, set
   `ALLOWED_ORIGINS` to the web page origins that will connect to you, and keep
   the Durable Object and migration blocks. The `ATTACHMENTS` R2 binding is
   required by the code but attachments are not available on a self-hosted
   gateway (the account service refuses them), so an empty bucket is enough.
3. **Set the two secrets:** `REMOTE_GATEWAY_TOKEN` = the `token` (what your
   gateway presents to the account service, which accepts it only for your
   devices) and `ACCOUNT_CALLBACK_TOKEN` = the `callbackSecret` (what the
   account service presents to your gateway when it asks whether a device is
   online or revokes one). They are different on purpose.
4. **Point the desktop at it:** `REASONIX_REMOTE_URL=wss://relay.example.com`
   and `REASONIX_REMOTE_GATEWAY_ID=<id>`, then restart Studio so the computer
   registers again at your gateway. A relay address must be `wss://` (or
   `ws://` to this machine only).
5. **The phone** needs nothing: the connection grant names your relay and the
   page connects there.

What stays with us: sign-in, device registration, connection grants and
revocation decisions. If your gateway is unreachable the account service cannot
close its live connections at once; the gateway's own 15-minute re-check closes
them.

