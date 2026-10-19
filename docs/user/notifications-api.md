# External notifications API

Outside services can put notification cards into T3 Code: a held Slack message waiting for
approval, a failed job, anything a person should see. Every connected client shows the open cards
live. A card can carry up to four buttons; clicking one sends a signed request back to the service,
which decides what happens. Dismissing a card or the service resolving it closes it for every
client at once.

## Where you see them

Open cards appear under the bell in the chat header (also on the empty "no active thread" page). The
bell is hidden while nothing is open; Settings -> Features -> Notifications keeps it always shown or
always hidden on this device. A new card also raises a toast, and an OS notification when the tab is
in the background and browser notifications are already allowed in Settings -> Notifications.
Dismissing a card clears it in every browser, and each button sends your answer back to the service.

This page is the contract for services that push notifications and for the receivers that handle
button clicks.

## How services connect

Run one hub in front of T3 Code rather than giving every service its own credential. On this
deployment the hub is **Alfred**: sources (pps, Slack holds, schedulers) report to Alfred, Alfred
forwards the notifications T3 Code should show, and T3 Code sends button clicks back to Alfred's
callback route. The hub holds the only `notifications:write` token and is the only allowed callback
origin, so adding a source never changes the T3 Code server.

```text
source ──► Alfred (hub) ──PUT /api/notifications/...──► T3 Code ──► every client
                ▲                                          │
                └──── signed POST <callbackUrl> ◄──────────┘   (button click)
```

A new source should go through the hub. If it truly cannot, it mints its own token (below), and if
it has buttons, its callback origin must be added to `T3_NOTIFICATION_CALLBACK_ORIGINS` and it must
share the callback secret.

## Server setup

Set these in the environment of the process that runs the T3 Code server (for a systemd unit, an
`Environment=` or `EnvironmentFile=` line), then restart the server. They are read at startup.

| Variable                           | Meaning                                                                                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `T3_NOTIFICATION_CALLBACK_SECRET`  | HMAC key for button callbacks. The receiver needs the same value. Unset: cards with buttons are still accepted, but clicking a button fails with a clear error. |
| `T3_NOTIFICATION_CALLBACK_ORIGINS` | Comma-separated allowed callback origins, e.g. `http://127.0.0.1:8791`. Empty: any card with buttons is rejected with 400.                                      |

Cards without buttons need neither variable.

## Get a token

Pushing needs a bearer token with the `notifications:write` permission. Browser and pairing
sessions never get it. Mint one on the server host (add `--base-dir` if your server uses one):

```bash
t3 auth session issue --scope notifications:write \
  --label alfred --subject alfred --ttl 365d --token-only
```

`--scope` replaces the default permission set, so the token can push notifications and nothing
else. List or revoke it with `t3 auth session list` and `t3 auth session revoke`.

## Push a notification

`PUT /api/notifications/:source/:sourceId` creates the card or updates it while it is open. The id
is `${source}:${sourceId}`, so pushing the same pair again is safe.

```bash
curl -sS -X PUT "http://127.0.0.1:3773/api/notifications/pps/hold-42" \
  -H "Authorization: Bearer $T3_NOTIFICATIONS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "approval",
    "title": "Slack message held: Dana in #general",
    "body": "Can someone approve the deploy?",
    "bodyTrust": "external",
    "url": "https://example.slack.com/archives/C1/p1",
    "actions": [
      { "id": "approve", "label": "Approve", "style": "primary" },
      { "id": "disapprove", "label": "Disapprove", "style": "danger" }
    ],
    "callbackUrl": "http://127.0.0.1:8791/v1/t3/notifications/action",
    "expiresAt": "2026-10-20T12:00:00Z"
  }'
# {"id":"pps:hold-42","state":"open"}
```

| Field         | Rules                                                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `source`      | Path segment, `[A-Za-z0-9._-]`, 1–32 characters.                                                                                        |
| `sourceId`    | Path segment, `[A-Za-z0-9._-]`, 1–64 characters.                                                                                        |
| `kind`        | String, up to 32 characters. A free label such as `approval`.                                                                           |
| `title`       | String, 1–200 characters.                                                                                                               |
| `body`        | String, up to 2000 characters. Truncate before sending.                                                                                 |
| `bodyTrust`   | `trusted` (written by the service) or `external` (relays third-party text, such as a held message).                                     |
| `url`         | Optional `http(s)` link, up to 2000 characters. Shown as "More info".                                                                   |
| `actions`     | Optional, up to 4. `id` matches `[a-z0-9_-]{1,32}` and is unique; `label` 1–40 characters; `style` is `primary`, `danger` or `default`. |
| `callbackUrl` | Required when `actions` is non-empty; its origin must be allowed. Ignored without actions. Never sent to clients.                       |
| `expiresAt`   | Optional ISO-8601 timestamp. Past it, the card closes as `expired`.                                                                     |

Optional fields may be omitted or `null`. The whole body may be at most 16 KiB.

## Resolve a notification

When the matter is settled elsewhere, close the card for everyone:

```bash
curl -sS -X POST "http://127.0.0.1:3773/api/notifications/pps/hold-42/resolve" \
  -H "Authorization: Bearer $T3_NOTIFICATIONS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "resolution": "approve", "resolvedBy": "alfred" }'
# {"id":"pps:hold-42","state":"resolved"}
```

`resolution` is `external` or the id of the action that was taken. `resolvedBy` is an optional
label up to 32 characters. Resolving is idempotent: an already resolved card answers 200 and keeps
its first resolution. An unknown id answers 404.

## Responses and errors

Success is `200` with `{ "id", "state" }`. Errors carry `{ "error": "<message>" }`:

| Status | When                                                                                                |
| ------ | --------------------------------------------------------------------------------------------------- |
| 400    | Invalid JSON or field, bad path segment, duplicate action ids, missing or disallowed `callbackUrl`. |
| 401    | Missing or invalid token.                                                                           |
| 403    | The token lacks `notifications:write`.                                                              |
| 404    | Resolving an id that does not exist (or was pruned).                                                |
| 413    | Body larger than 16 KiB.                                                                            |

## Notification states

A card is `open` until it is resolved, and resolved is final:

- **Pushing a resolved id does not reopen it.** The PUT answers `state: "resolved"`. To show the
  matter again, use a new `sourceId`.
- **Resolution** is the action id, `dismissed` (a person closed it in T3 Code; the service is not
  told), `expired`, or `external` (the service resolved it, or answered a click with
  `already_resolved`).
- **Expiry** is enforced by the server within about 30 seconds of `expiresAt`.
- Resolved cards are kept for 7 days, then deleted. After that a PUT with the same id creates a new
  card.

## Text and trust

Everything is plain text. T3 Code stores strings as sent and never renders HTML or Markdown from
them. Mark text you did not write as `"bodyTrust": "external"` so clients can label it; a held
message from a stranger is external even when your service forwards it.

## Button callbacks

When someone clicks a button, the server sends this request and waits up to 5 seconds. There are
no retries, and a second click on the same card is refused while the first is in flight.

```http
POST <callbackUrl>
Content-Type: application/json
X-T3-Signature: t=1792411200,v1=5f0c…(64 hex chars)

{"notificationId":"pps:hold-42","source":"pps","sourceId":"hold-42","actionId":"approve","actedAt":"2026-10-19T12:00:00.000Z"}
```

`v1` is the lowercase hex HMAC-SHA256 of `"<t>.<raw body>"` keyed with
`T3_NOTIFICATION_CALLBACK_SECRET`; `t` is Unix seconds. How T3 Code reads the answer:

| Answer                                                     | Result                                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| Any 2xx                                                    | Resolved with the clicked action.                                      |
| 404 or 409 with JSON body `{"status": "already_resolved"}` | Resolved as `external`.                                                |
| Anything else, redirects, a timeout, or a network error    | Stays open; the person sees "Could not deliver '<label>' — try again". |

The receiver must:

- verify the signature over the exact raw body bytes, in constant time, before parsing it;
- reject a request whose `t` is more than 300 seconds from its own clock;
- be idempotent on `(notificationId, actionId)`: a repeated click answers 2xx again.

Node:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyT3Signature(header, rawBody, secret, nowSeconds = Date.now() / 1000) {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (Math.abs(nowSeconds - timestamp) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
  return timingSafeEqual(Buffer.from(match[2], "hex"), expected);
}
```

Python:

```python
import hashlib, hmac, re, time

def verify_t3_signature(header: str | None, raw_body: bytes, secret: str) -> bool:
    match = re.fullmatch(r"t=(\d+),v1=([0-9a-f]{64})", header or "")
    if not match:
        return False
    timestamp = int(match.group(1))
    if abs(time.time() - timestamp) > 300:
        return False
    expected = hmac.new(secret.encode(), f"{timestamp}.".encode() + raw_body, hashlib.sha256)
    return hmac.compare_digest(expected.hexdigest(), match.group(2))
```

## Known limitation: two-factor authentication

Once two-factor authentication is enrolled on the server, every HTTP request must carry a verified
second factor. A `notifications:write` token issued from the CLI has none, so its requests are
rejected with 401 until two-factor is disabled. Service tokens are not yet exempt.
