# REST API reference

Base path: `/api`. All request and response bodies are JSON.

**Authentication:** a session JWT in an `httpOnly` cookie, set by register or login. Every endpoint except health and auth requires it.

**Money:** amounts are integer **cents** in USD.

**Errors** use this shape:

```json
{ "error": { "code": "version_conflict", "message": "Human-readable message", "details": {} } }
```

The `details` field is optional.

**Concurrency:** edits are optimistic.

- Line-item edits and approval send `expectedRevision`. Copy and AI generation send `expectedLatestVersion`.
- A stale value returns `409`, so two tabs or the AI and a manual edit can't overwrite each other.

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
| POST | `/requests/:id/unapprove` | | Returns an approved request to draft. |

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
| POST | `/requests/:id/checkout` | Creates a PayPal order for the approved version, or reuses the pending one. Returns the payment, including `approveUrl`, the PayPal page the buyer must be redirected to. |
| POST | `/payments/:orderId/capture` | Captures the order after the buyer approves it, checks that the captured amount equals the approved total, then marks the request **paid**. Safe to retry. |
| GET | `/requests/:id/payments` | Lists payment attempts for a request. |

A payment record has the fields `paypalOrderId`, `paypalCaptureId`, `amountCents`, `status`, `payer` and `capturedAt`. `status` is one of `created`, `capturing`, `completed`, `pending`, `failed` or `cancelled`.

Common payment errors:

| Code | Status | Meaning |
| --- | --- | --- |
| `not_approved` | 409 | Approve a version before checking out. |
| `approval_invalid` / `approval_changed` | 409 | The approved sheet or approval changed. Approve again and check out again. |
| `order_not_approved` | 409 | The buyer hasn't approved the order on PayPal yet. The response includes `approveUrl`. |
| `payment_declined` | 402 | PayPal declined the payment method. Send the buyer back to `approveUrl`. |
| `already_paid` | 409 | The request has already been paid. |
| `payments_not_configured` | 503 | PayPal credentials are missing on the server. |
