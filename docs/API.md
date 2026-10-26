# API reference

Everything lives under `/api` and speaks JSON. Amounts are whole cents in USD.

You sign in with register or login, which sets a JWT in an `httpOnly` cookie. Every endpoint needs that cookie except health, auth and the public pool endpoints.

Errors look like this (`details` is only there sometimes):

```json
{ "error": { "code": "version_conflict", "message": "Human-readable message", "details": {} } }
```

Edits use optimistic locking. Line-item edits and approvals send `expectedRevision`, and copying a version or running the agent sends `expectedLatestVersion`. If the value is stale you get a `409`, so two tabs, or the agent and a manual edit, can't overwrite each other.

## Health

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | Returns `200`, or `503` if MongoDB is not connected. |

## Auth

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| POST | `/auth/register` | `{ email, password, displayName }` | Creates an account and signs in. Rate limited. |
| POST | `/auth/login` | `{ email, password }` | Signs in. Rate limited. |
| POST | `/auth/logout` | | Clears the session cookie. |
| GET | `/auth/me` | | Returns the current user. |

## Products (Channel3)

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| POST | `/products/search` | `{ query, limit?, minPriceCents?, maxPriceCents? }` | Searches the live catalogue. Results are cached per user for 15 minutes, and searches are capped per user per day. |

## Requests

| Method | Path | Body or query | Description |
| --- | --- | --- | --- |
| POST | `/requests` | `{ prompt, budgetCents? }` | Creates a draft request. |
| GET | `/requests` | | Lists your requests. |
| GET | `/requests/:id` | | Returns a request with its latest version. |
| DELETE | `/requests/:id` | | Deletes a draft or approved request with its versions. Paid requests can't be deleted. |
| POST | `/requests/:id/unapprove` | | Returns an approved request to draft (any member, before anyone has paid). |

## Group Nod

A request with only its owner is a solo request and behaves as before. The owner can invite others by link; every member can see and edit the sheet and run the agent.

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| POST | `/requests/:id/invite` | | Owner only. Creates or rotates the invite token and returns `{ inviteToken }`. |
| DELETE | `/requests/:id/invite` | | Owner only. Revokes the invite link. |
| GET | `/requests/invites/:token` | | Previews an invite: `{ invite: { requestId, prompt, ownerName, memberCount, status, alreadyMember } }`. |
| POST | `/requests/invites/:token/join` | | Joins the group (draft requests only, at most 10 people). Clears existing nods. |
| DELETE | `/requests/:id/members/:userId` | | The owner removes a member, or a member removes themselves. Draft only. |
| DELETE | `/requests/:id/versions/:n/nod` | | Takes back your own nod. |
| PUT | `/requests/:id/shares` | `{ shares: [{ userId, amountCents }] }` | Owner only, once approved. Sets custom shares: one per person, summing to the approved total. |
| POST | `/requests/:id/cancel-payment` | | Owner only. Refunds captured shares, cancels open orders and reopens the draft. A failed refund returns `refund_failed` and changes nothing else; retry. |

`GET /requests/:id` also returns `members` (`userId`, `displayName`, `role`, `nodded`, `shareCents`) and, for the owner, `inviteToken`. A version has `nods`, the user ids that have nodded on its current revision.

`POST /requests/:id/versions/:n/approve` records your nod. The response has `finalized: false` until every member has nodded on the same revision; then the request becomes `approved` and shares are set to an equal split (leftover cents go to the first members). Any edit or new version clears all nods.

## Community pool

An approved **solo** request can be opened as a public, all-or-nothing pool. The goal is the approved version's total. While a pool is open, the request can't be unapproved, deleted or checked out normally.

| Method | Path | Auth | Body | Description |
| --- | --- | --- | --- | --- |
| POST | `/requests/:id/pool` | owner | `{ story?, organizer?, deadline? }` | Opens a pool and returns it, with the public `token` and an AI-written `pitch` (`pitchByAi: false` when the fallback was used). `deadline` is an ISO date between 1 hour and 90 days away. |
| POST | `/requests/:id/pool/cancel` | owner | | Cancels the pool, refunds every captured contribution through PayPal and returns the request to draft. |
| GET | `/requests/:id/pool/contributions` | owner | | Lists the latest pool's contributions (up to 200), with their status. |
| GET | `/pools/:token` | public | | The public view: the pool (with `goalCents`, `raisedCents`, `remainingCents` and `contributorCount`), the approved items and supporters. Never includes payer details. |
| POST | `/pools/:token/contribute` | public | `{ amountCents, name?, anonymous?, message? }` | Creates a PayPal order for a pledge and returns its `approveUrl`. The amount must be at least $1 (or what's left, if less) and at most the remaining amount. |
| POST | `/pools/:token/contributions/:orderId/capture` | public | | Captures the pledge after PayPal approval and verifies the amount. When the goal is reached the pool becomes `funded` and the request `paid`. Safe to retry. |

`GET /requests/:id` returns `pool` (the latest pool, or `null`), and `GET /requests` returns `poolStatus` for requests with an active pool. The public write endpoints are limited to 30 calls per 15 minutes per IP. A server sweeper expires overdue pools every minute and refunds them in the same way as cancel.

Pool errors:

| Code | Status | Meaning |
| --- | --- | --- |
| `pool_open` | 409 | The action is blocked while a pool is open. |
| `pool_exists` | 409 | The request already has an active pool. |
| `pool_full` | 409 | Pledges already cover the goal. |
| `pool_closed` | 409 | The pool is no longer accepting contributions; an uncaptured pledge is cancelled. |
| `invalid_amount` | 400 | The pledge is out of range; `details` has `minCents` and `maxCents`. |
| `refund_failed` | 502 | A refund failed. The pool stays open; retry the cancel. |

## Versions

| Method | Path | Body or query | Description |
| --- | --- | --- | --- |
| GET | `/requests/:id/versions` | | Lists versions, oldest first. |
| GET | `/requests/:id/versions/:n` | | Returns one version with its items and total. |
| POST | `/requests/:id/versions` | `{ items: [{ channel3ProductId, quantity, rationale? }], basedOnVersion?, summary?, instruction? }` | Creates a version from explicit items. Prices are resolved on the server. |
| POST | `/requests/:id/versions/:n/copy` | `{ summary?, expectedLatestVersion }` | Copies version *n* forward as the newest version. |
| GET | `/requests/:id/versions/:n/diff?against=m` | | Shows added, removed and changed lines, and the total delta, between versions *n* and *m*. |
| POST | `/requests/:id/versions/:n/approve` | `{ expectedRevision }` | Approves exactly this revision of version *n*. |

### Line items (latest draft version only)

| Method | Path | Body or query | Description |
| --- | --- | --- | --- |
| POST | `/requests/:id/versions/:n/items` | `{ channel3ProductId, quantity, rationale?, expectedRevision }` | Adds a product. Its price and stock are looked up from Channel3. |
| PATCH | `/requests/:id/versions/:n/items/:itemId` | `{ quantity, expectedRevision }` | Changes a quantity. |
| DELETE | `/requests/:id/versions/:n/items/:itemId?expectedRevision=r` | | Removes a line. |

## AI agent

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| POST | `/requests/:id/generate` | `{ instruction?, expectedLatestVersion }` | Runs the plan → search → select agent and saves the result as a new version. |

Notes on `/generate`:

- `instruction` is required when the request already has a version, for example `"cut 20%"`.
- The response is `{ version, diff, agent: { model, searches, unmet } }`.
- `unmet` lists any needs the agent could not fill.
- Returns `503` if Gemini isn't configured, and `429` when the user's daily limit is reached.

## Payments (PayPal Orders v2)

| Method | Path | Description |
| --- | --- | --- |
| POST | `/requests/:id/checkout` | Creates a PayPal order for your share of the approved version (the full total for solo requests), or reuses the pending one. Returns the payment, including `approveUrl`, the PayPal page the buyer must be redirected to. |
| POST | `/payments/:orderId/capture` | Captures the order after the buyer approves it, checks that the captured amount equals your share (the full total for solo requests), and marks the request **paid** once every share is captured. Safe to retry. |
| GET | `/requests/:id/payments` | Lists payment attempts for a request. |

A payment record has the fields `paypalOrderId`, `paypalCaptureId`, `amountCents`, `status`, `payer` and `capturedAt`. `status` is one of `created`, `capturing`, `completed`, `pending`, `failed`, `cancelled` or `refunded`.

Common payment errors:

| Code | Status | Meaning |
| --- | --- | --- |
| `not_approved` | 409 | Approve a version before checking out. |
| `approval_invalid` / `approval_changed` | 409 | The approved sheet or approval changed. Approve again and check out again. |
| `order_not_approved` | 409 | The buyer hasn't approved the order on PayPal yet. The response includes `approveUrl`. |
| `payment_declined` | 402 | PayPal declined the payment method. Send the buyer back to `approveUrl`. |
| `already_paid` | 409 | The request has already been paid. |
| `payments_not_configured` | 503 | PayPal credentials are missing on the server. |
