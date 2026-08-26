# Multi-User Execution Routing

## Goal

Allow several approved Discord users in one guild to use the shared Shuvmaki
bot while each user's sessions execute on that user's own Kimaki instance and
exe VM. The user who starts a Discord thread becomes its **execution owner**;
all later turns in that thread continue on the same worker unless ownership is
explicitly transferred.

Provider credentials, OpenCode authentication, project files, session history,
and caches must remain on the execution owner's worker. The shared gateway must
route Discord events without receiving or redistributing provider tokens.

## Current Behavior

- `gateway-proxy/src/server.rs::forward_shard` filters client events by guild,
  not by Discord user or thread. Two gateway clients authorized for the same
  guild therefore receive the same message and interaction events.
- `gateway-proxy/src/dispatch.rs` already buffers selected events per
  disconnected client and wakes a client through its `reachable_url`.
- `db/schema.prisma::gateway_clients` already records a client, authorized
  guilds, an internal Better Auth `user_id`, and an optional `reachable_url`.
- `website/src/gateway-client-kv.ts::upsertGatewayClientAndRefreshKv`
  associates onboarding rows with Better Auth users. The onboarding status
  response in
  `website/src/server.tsx` can already recover the linked Discord account ID.
- `cli/src/discord-bot.ts` creates a public thread from the starter message.
  Discord uses the starter message ID as the resulting thread ID, which gives
  the gateway a deterministic route key before the worker creates the thread.
- `cli/src/schema.ts::thread_sessions` stores the local Discord thread to
  OpenCode session binding. It should remain local to the selected worker.
- `KIMAKI_INTERNET_REACHABLE_URL` and `cli/src/hrana-server.ts` currently expose
  only authenticated wake and Hrana endpoints. There is no remote execution
  protocol to extend or replace.
- Offline event buffers are already bounded **per client** only
  (`gateway-proxy/src/state.rs::push_offline_event_for_client` drops the oldest
  event past `OFFLINE_EVENT_BUFFER_LIMIT`). Per-route bounding does not exist
  yet and is new work.
- A parallel standalone onboarding server already exists at
  `deploy/shuvmaki-gateway/onboarding/server.js`. Its
  `ensureGatewayClientsTable()` creates/upserts a raw `discord_user_id TEXT`
  column on `gateway_clients`, and
  `deploy/shuvmaki-gateway/init-gateway-clients.sql` declares the same column.
  The column is **not** present in `db/schema.prisma` or
  `website/src/gateway-client-kv.ts`. The production database may therefore
  already contain this column outside Prisma management.

The missing invariant is: **one routable Discord event must have one selected
Kimaki client within a guild**.

## Decisions

### Use `gateway-proxy` as the single router

Extend the existing proxy rather than adding a second central job broker. Each
user continues running an ordinary Kimaki gateway client on their exe VM. The
proxy selects which authenticated client receives a user or thread event.

Rationale:

- Reuses gateway authentication, guild scoping, reconnects, offline buffers,
  and `reachable_url` wake behavior.
- Keeps the CLI event-driven and aligned with Discord.js instead of inventing a
  parallel RPC representation for every Discord event.
- Keeps provider credentials and OpenCode state on the worker.
- Avoids multiple clients racing to create the same Discord thread.

### Treat `client_id` as the worker identity

One Discord user may eventually register several workers. Add an explicit
per-guild default-worker mapping instead of assuming there is only one client
row or selecting the newest row implicitly.

### Pin in memory, persist on THREAD_CREATE

For a top-level `MESSAGE_CREATE` by a linked user, resolve the starter's
default worker from the in-memory routing snapshot — a pure lookup, no DB
write — and forward the event only to that client. Record the decision in a
bounded in-memory **pending map** keyed by message ID (~5 minute TTL, capped
size). No route row is written yet: most guild messages are ordinary chat
that never becomes a thread, and the gateway cannot know which channels are
kimaki project channels (that mapping lives in each worker's local SQLite).

Because a public thread created from a message adopts the starter message ID,
a later `THREAD_CREATE` whose `d.id` matches a pending entry confirms a
session actually started. Only then does an off-loop writer persist the
`gateway_thread_routes` row (`INSERT ... ON CONFLICT (guild_id, thread_id)
DO NOTHING`, then read the winning row back — a different owner is a
`gateway_route_conflict`) and apply it to the local routing snapshot
**synchronously**. The writer must not wait for its own LISTEN/NOTIFY
roundtrip, or a fast follow-up message in the new thread races the snapshot.

This keeps the shard event loop (`dispatch.rs::events()`, one task per shard)
free of DB roundtrips, adds zero first-message latency, and writes no rows
for messages that never become threads. Pending entries that expire without a
`THREAD_CREATE` simply vanish.

Single-client forwarding mechanism: extend `dispatch.rs::BroadcastMessage`
(currently `(payload, sequence, guild_id)`) with a route decision —
`Broadcast | Target(client_id) | Drop` — computed before `broadcast_tx.send`.
`server.rs::forward_shard` filters on the decision in addition to the
existing guild check; per-client sequence rewriting is unchanged.

Classification inputs (author ID, channel ID, bot-author detection) must come
from a real JSON parse of the payload for classification-relevant event
types, not from the substring scanner in `deserializer.rs` — message content
can contain `"id":`. Reuse or hoist the existing twilight `parse` (which
currently runs after broadcast) for these events.

If the database is unreachable when persisting a confirmed route, the
in-memory route stays active and the writer retries with backoff, recording
`route_insert_failed`. A proxy restart before persistence loses the route and
the thread fails closed until re-seeded (see Rollout). Never broadcast on
failure.

### Fail closed

- Unlinked or unapproved users do not consume a worker and receive no model
  execution.
- A missing, disabled, or ambiguous worker mapping must not fall back to
  another user's worker.
- A missing thread route must not be broadcast to every client.
- A disconnected selected worker may be buffered and woken, but the event must
  remain targeted to that worker.
- Thread ownership is immutable by default. Transfer requires an explicit,
  audited action.

### Separate execution ownership from participation

The execution owner determines the worker, credentials, project files, and
quota charged. Other approved Discord users may talk in the thread, but their
messages continue to route to the thread owner's worker according to that
owner's grant policy.

## Scope

### MVP

- Link a Discord identity to one or more gateway clients.
- Select one default worker per Discord user and guild.
- Route top-level user messages and interactions to that user's worker.
- Persist thread-to-worker ownership when the thread is confirmed
  (`THREAD_CREATE` or authenticated REST thread creation).
- Route all relevant events inside an owned thread to the pinned worker.
- Preserve routes across gateway restarts.
- Target offline buffering and wake requests to the selected worker only.
- Provide worker status and a way to choose the default worker.
- Silently ignore every user the gateway cannot route: unlinked, unauthorized,
  and linked users whose worker is offline or disabled. Drops are observable
  only through `gateway_route_dropped` metrics. A user-facing "your worker is
  offline/unlinked" status response is Follow-up work — the gateway never
  originates Discord REST messages today, and giving it that capability is
  out of MVP scope.

### Follow-up

- An explicit "your worker is offline/unlinked" status response for linked
  users (requires the proxy or another always-on component to originate
  Discord REST messages).
- Disabling or removing a worker from user-facing commands (the `enabled`
  kill switch stays admin/DB-side in the MVP).
- Owner-managed grants such as `/gang allow @user` and `/gang revoke @user`.
- Per-grantee quotas and channel-sponsored execution.
- Explicit thread ownership transfer.
- A worker-management web page and optional exe identity verification.
- Capacity-aware pools owned by one account.
- Auditing and usage reporting by execution owner and grantee.

### Out of Scope

- Passing ChatGPT, xAI, or other provider credentials through the website or
  gateway.
- Sharing local OpenCode databases or project files between workers.
- Cross-user response or prompt caching in the MVP.
- Automatically routing to any available worker when the selected worker is
  unavailable.
- Making the gateway a general remote shell or model proxy.
- Changing the existing Discord guild REST authorization boundary until the
  ownership checks described below can be proven.

## Proposed Data Model

Modify `db/schema.prisma` and regenerate clients with `cd db && pnpm gen`.
Production application remains a human-run `cd db && pnpm push:prod` step.

### Canonical onboarding writer (prerequisite)

Two surfaces currently write `gateway_clients`: the website OAuth flow
(`website/src/gateway-client-kv.ts`) and the standalone deploy server
(`deploy/shuvmaki-gateway/onboarding/server.js`, which already writes a raw
`discord_user_id` column). Before any schema change:

1. Run `cd db && pnpm pull:prod` and diff the pulled schema against
   `schema.prisma` to learn whether production already has
   `gateway_clients.discord_user_id` from the deploy path.
2. Declare the **website** the canonical onboarding writer. Either retire the
   standalone deploy onboarding server or change it to delegate to / mirror
   exactly the Prisma-managed column set; it must never own columns that
   `schema.prisma` lacks, because a later `pnpm push:prod` would drop them.
3. Update `deploy/shuvmaki-gateway/init-gateway-clients.sql` so its documented
   SELECT matches reality.

### `gateway_clients` additions

- `discord_user_id String?`: denormalized stable Discord account ID. The
  website derives it from the Better Auth account during onboarding. This
  avoids coupling Rust routing SQL to Better Auth's internal account schema.
  This column may already exist in production from the standalone deploy
  onboarding server — reconcile per the canonical-writer prerequisite above
  before adding it to `schema.prisma`.
- `enabled Boolean @default(true)`: administrative kill switch.
  `enabled=false` blocks authentication entirely — the client cannot connect,
  not merely receive new routes. Like `secret` and `reachable_url`, it is
  normalized per client across guild rows by the sibling-row `updateMany` in
  `upsertGatewayClientAndRefreshKv` (`website/src/gateway-client-kv.ts`).
- `last_seen_at DateTime?`: optional persisted health signal. Live connection
  state remains authoritative while the proxy is running.
- Optional user-facing `worker_label String?` for commands and management UI.

Do not overload `user_id`: it is the Better Auth `User.id`, not the Discord
snowflake required for event routing.

### Proposed `gateway_user_defaults`

| Field | Meaning |
|---|---|
| `guild_id` | Discord guild scope |
| `discord_user_id` | User who starts sessions |
| `client_id` | Selected worker |
| `created_at`, `updated_at` | Audit timestamps |

Primary key: `(guild_id, discord_user_id)`. The selected client must have a
matching enabled `gateway_clients` row for the guild.

Both new tables are **Discord-scoped only**. `gateway_clients.guild_id`
doubles as a Slack team ID for `platform='slack'` rows; the routing tables'
bare snowflake keys would be ambiguous if the Slack bridge ever shared them.
If cross-platform routing is ever needed, add an explicit `platform` column
then — do not infer scope from ID shape.

### Proposed `gateway_thread_routes`

| Field | Meaning |
|---|---|
| `guild_id` | Discord guild scope |
| `thread_id` | Discord thread ID; initially the starter message ID |
| `client_id` | Pinned worker |
| `execution_owner_discord_user_id` | Identity charged for execution |
| `starter_message_id` | Correlation and audit value |
| `created_at`, `updated_at` | Audit timestamps |
| `revoked_at` | Optional closed/revoked route marker |

Primary key: `(guild_id, thread_id)`. Route creation must be idempotent and
must not silently overwrite a different owner: after
`ON CONFLICT ... DO NOTHING`, read the winning row back and treat a different
owner as a `gateway_route_conflict`, never as success.

### Proposed `gateway_worker_grants` (follow-up)

Store owner, grantee, guild, worker, optional quota, expiry, and revocation.
Keep grant authorization separate from route assignment so existing threads
remain attributable after a grant changes.

## Event Routing Rules

Implement pure event classification and route-resolution functions before
wiring them into `gateway-proxy/src/dispatch.rs` and
`gateway-proxy/src/server.rs`.

### Thread vs top-level classification

A `MESSAGE_CREATE` payload carries `channel_id` but not the channel's kind, so
the proxy cannot tell a thread message from a channel message by payload shape
alone. Classification is deterministic from the routing state instead:

- Any event whose **route key** matches a `thread_id` in the loaded
  `gateway_thread_routes` snapshot (or the pending map) is a **thread event**
  (route rule 1).
- Otherwise it is a **top-level candidate** for starter pinning (route rule 2).

The route key is per event type — `THREAD_*` payloads have no `channel_id`:

| Event types | Route key field |
|---|---|
| `MESSAGE_CREATE/UPDATE/DELETE`, `INTERACTION_CREATE`, reaction and typing events | `d.channel_id` |
| `THREAD_CREATE/UPDATE/DELETE` | `d.id` (the thread itself; `d.parent_id` is the parent channel) |
- The proxy's twilight guild cache (`shard_state.guilds`, updated in
  `dispatch.rs`) may be used as a cross-check for thread channel kinds
  (11/12), but never as the primary signal — routes are the source of truth.

This works because public threads created via `message.startThread()` adopt
the starter message ID as their channel ID, which is exactly what gets pinned.

### Route precedence

1. If the event belongs to a routed thread, send it only to the pinned client.
2. If it is a top-level user action, resolve the invoking Discord user to their
   default worker for that guild.
3. If the invoking user has an explicit grant and no personal worker, apply the
   grant selection rule once grants are implemented.
4. Send guild/cache lifecycle events needed by Discord.js to every client
   authorized for that guild.
5. Drop unrouteable execution events instead of broadcasting them.

### Events requiring ownership routing

At minimum classify and cover:

- `MESSAGE_CREATE`, `MESSAGE_UPDATE`, and `MESSAGE_DELETE`
- `THREAD_CREATE`, `THREAD_UPDATE`, and `THREAD_DELETE`
- `INTERACTION_CREATE`
- reaction events used by Kimaki controls
- typing and voice events only if current CLI behavior consumes them

For `INTERACTION_CREATE`, a thread-scoped command routes to the thread owner;
a top-level command routes to the invoking user's worker. This prevents a
collaborator's `/queue`, `/model`, or button interaction inside an existing
thread from accidentally running on the collaborator's personal worker.

### Events that remain guild-wide

READY/GUILD_CREATE synthesis and role/channel/member cache updates may still
need fanout so every worker has valid Discord.js cache state. Enumerate this
allowlist explicitly; do not infer that every unknown event is safe to fan out.

### Bot-authored messages

Bot messages inside a routed thread follow the thread route. Top-level
bot-authored starter or marker messages must not be routed by bot author ID.
`kimaki send` is an MVP-critical flow (it powers the release-notification
pipeline), and its correlation is simpler than marker parsing: per
`cli/src/discord-bot.ts` (the `start` marker comment), the sending CLI posts
the marker message and then **creates the thread itself** through the gateway
REST proxy (`POST /channels/{channel_id}/messages/{message_id}/threads`).
That call is client-authenticated, so the REST proxy resolves `client_id`
directly at thread creation and seeds the identical
`(guild_id, thread_id → client_id)` route row the normal `THREAD_CREATE`
confirmation would have created. No response annotation or marker-content
correlation is needed. The marker `MESSAGE_CREATE` itself (authored by the
shared bot user) is never a starter candidate; bot-authored top-level
messages resolve only through pending or persisted routes. Unattributable
tokenized webhook sends drop with reason code `route_insert_failed` rather
than broadcast.

## Linking and Worker Selection

### Initial flow using existing onboarding

1. A user starts Kimaki on their exe VM with gateway mode and an internet
   reachable URL.
2. Existing Discord OAuth onboarding identifies the Discord account and guild.
3. `website/src/gateway-client-kv.ts::upsertGatewayClientAndRefreshKv` stores the
   denormalized Discord user ID with the gateway client.
4. If this is the user's first enabled worker in the guild, create their
   `gateway_user_defaults` row automatically.
5. Additional workers require an explicit default selection instead of silently
   replacing the current worker.

### Worker management

Keep the MVP surface minimal — three commands or equivalent interactions:

- listing the current user's workers and connection status;
- selecting the default worker for the current guild;
- showing which worker owns the current thread.

Disabling or removing a worker from Discord is Follow-up; the `enabled` kill
switch is admin/DB-side in the MVP.

Proposed command names must be checked against the current command registry and
Discord's 100-character component `custom_id` limit during implementation.
Store only short IDs in component IDs.

### Login with exe

The repository does not currently contain a verified exe OAuth or identity API.
Before adding it, confirm an officially supported mechanism that proves exe
account or VM ownership without exposing session cookies. If supported, add it
as defense in depth on the worker-management page. If not, use a one-time claim
code generated by the worker and bound to the already authenticated Discord
user. Do not block the routing MVP on an undocumented external contract.

## Authorization and Security Invariants

- The gateway stores gateway client credentials, never provider credentials.
- Every route lookup includes `guild_id`; Discord snowflakes alone do not grant
  cross-guild access.
- The selected client must currently be authorized for the route's guild.
- Route creation is transactional with conflict detection.
- Disabled clients cannot receive new routes.
- Revoking a worker prevents new work immediately and defines an explicit
  policy for existing routes: pause by default, never reassign automatically.
- Logs and metrics may include client IDs, guild IDs, thread IDs, and reason
  codes, but not prompts, provider tokens, gateway secrets, or Discord OAuth
  credentials.
- Existing fail-closed REST rules in `gateway-proxy/src/rest_proxy.rs` remain in
  force.
- Before multi-user release, add thread ownership checks to client-authenticated
  REST operations that target thread channel IDs. Allow a worker to create a
  thread in an authorized top-level guild channel, but deny mutation of a
  thread pinned to another worker.
- Unscoped bot-token routes remain forbidden. Tokenized interaction/webhook
  routes remain the only unauthenticated exceptions.
- Cross-user caches are disabled. Any future cache key must include execution
  owner, provider account, model, project, and authorization scope.

## Implementation Milestones

### 1. Encode the routing model in Postgres

Modify:

- `db/schema.prisma`
- `website/src/gateway-client-kv.ts`
- onboarding-status response handling in `website/src/server.tsx` only where
  needed to return stable worker metadata

Before touching `schema.prisma`, run `cd db && pnpm pull:prod` and diff the
result against `schema.prisma` to detect pre-existing
`gateway_clients.discord_user_id` from the standalone deploy onboarding
server, and resolve the canonical-onboarding-writer prerequisite above.

The website KV cache mirrors gateway client rows for auth acceleration, so
adding columns means updating `GatewayClientCacheRecord`, its
`isGatewayClientCacheRecord` validator, the upsert parameters in
`upsertGatewayClientAndRefreshKv`, and bumping the KV key prefix from
`gateway-client:v1:` to `v2:` so stale cached shapes cannot survive deploy.

The website package has **no test runner today** (no `test` script, no vitest
config, no test files). Standing up vitest in `website/` is an explicit
sub-task of this milestone, not an assumed capability.

Add focused DB and website tests for:

- Discord ID denormalization during onboarding;
- first-worker default creation;
- multiple-worker onboarding not replacing an explicit default;
- disabled and cross-guild workers being rejected;
- idempotent thread route creation and ownership conflicts.

The rollout backfill query (also the audit artifact for step 2 of Rollout):

The better-auth tables map only their table names to lowercase
(`@@map("account")`); the columns stay camelCase (`"userId"`, `"providerId"`,
`"accountId"`) and must be quoted. `DISTINCT ON` with explicit ordering picks
the newest client row deterministically when a user has several workers:

```sql
INSERT INTO gateway_user_defaults (guild_id, discord_user_id, client_id, created_at, updated_at)
SELECT DISTINCT ON (gc.guild_id, a."accountId")
  gc.guild_id, a."accountId", gc.client_id, NOW(), NOW()
FROM gateway_clients gc
JOIN "user" u ON u.id = gc.user_id
JOIN "account" a ON a."userId" = u.id AND a."providerId" = 'discord'
WHERE gc.enabled = true
ORDER BY gc.guild_id, a."accountId",
  gc.updated_at DESC NULLS LAST, gc.created_at DESC
ON CONFLICT (guild_id, discord_user_id) DO NOTHING;
```

Done when the database can answer, atomically: “which enabled client owns this
user's new work in this guild?” and “which client owns this thread?”

### 2. Load routing state into the gateway

Modify:

- `gateway-proxy/src/db_config.rs`
- `gateway-proxy/src/state.rs`
- add a focused routing module such as proposed
  `gateway-proxy/src/routing.rs`

Keep routing snapshots atomically swappable like the existing client map.
Concretely, this milestone must cover every place the current schema is
hardwired:

- the existing NOTIFY function/trigger pair is `gateway_clients`-specific
  (`CREATE_NOTIFY_FUNCTION_SQL` / `CREATE_NOTIFY_TRIGGER_SQL` in
  `db_config.rs`); `gateway_user_defaults` and `gateway_thread_routes` need
  their own triggers or channels;
- `SELECT_CLIENTS_SQL` / `SELECT_CLIENTS_BY_IDS_SQL` select four columns and
  must learn `enabled` and `discord_user_id`;
- the standalone deploy onboarding writer
  (`deploy/shuvmaki-gateway/onboarding/server.js`) upserts `gateway_clients`
  directly and must be reconciled so it cannot null-out or omit the new
  columns (see the canonical-writer prerequisite).

Preserve stale-database fail-closed behavior.

Done when route/default changes reach the proxy without restart and stale DB
state cannot authorize new routing decisions.

### 3. Route top-level starters to exactly one worker

Modify:

- `gateway-proxy/src/dispatch.rs`
- `gateway-proxy/src/server.rs`
- event deserialization helpers under `gateway-proxy/src/`

Add pure tests with realistic Discord payloads. On a top-level message from a
linked user, classification and default-worker resolution run in the shard
event loop as pure in-memory lookups; the event forwards only to the selected
client via the `RouteDecision` carried on the broadcast message, and the
pending map records the decision (see Pin in memory, persist on
THREAD_CREATE). On `THREAD_CREATE` confirmation, the off-loop writer persists
the route and updates the snapshot synchronously. Ensure a concurrent
duplicate decision cannot assign a second client and that an unroutable
starter drops rather than broadcasts.

Done when two connected clients in one guild receive exactly one starter
dispatch between them and exactly one Discord thread is created.

### 4. Route thread events and interactions

Route messages, edits, deletes, interactions, reactions, and lifecycle events
by thread ownership. Preserve guild-wide cache events through an explicit
allowlist.

Add restart tests proving persisted routes survive proxy and worker reconnects.
Add collaborator tests proving another user's message or command inside an
owned thread still executes on the thread owner's worker.

Done when an owned thread never jumps workers because of the author of a later
message.

### 5. Target offline buffering and wake

Modify the buffering decision in `gateway-proxy/src/dispatch.rs` so only the
selected client receives an offline event and wake request. Buffers are
already bounded per client (`OFFLINE_EVENT_BUFFER_LIMIT`); add the new
per-route bound and preserve event order, and define expiration behavior.

Done when an offline owner receives replay after reconnect while unrelated
workers receive neither buffered events nor wake requests.

### 6. Harden REST ownership

Modify `gateway-proxy/src/rest_proxy.rs` only after checking Discord's official
OpenAPI schema for every affected route. Resolve channel IDs that represent
threads against `gateway_thread_routes` and deny cross-worker mutations.

Add tests for sending, editing, deleting, adding thread members, and thread
metadata changes. Continue failing closed when scope cannot be proven.

Done when a compromised worker credential cannot write to a thread owned by a
different client.

### 7. Expose worker status and selection

Add CLI/Discord command handlers under `cli/src/commands/` using the existing
command registration pattern. Resolve project and worktree paths through
`resolveWorkingDirectory` where applicable. Add website APIs only when a web
management surface is needed; keep per-request Prisma and Better Auth instances
per `website/AGENTS.md`.

Done when users can identify their selected worker, change it deliberately,
and diagnose offline/disabled state without database access.

### 8. Add owner grants (`/gang`) after the MVP is stable

Add grant storage, revocation, expiry, quotas, and audit records. Default to
private workers. A user with a personal worker should keep using it unless they
explicitly select a sponsored worker. Never infer sponsorship from guild role
membership alone.

Before shipping sponsored use, document that provider subscription terms may
restrict use by other people even when technical isolation is correct.

## Testing Strategy

### Gateway unit and integration tests

From `gateway-proxy/`:

```bash
cargo test
```

Cover route classification, author/default lookup, thread precedence,
conflicting inserts, stale DB behavior, reconnect replay, and REST ownership.

### Multi-client Discord E2E

Extend `cli/src/gateway-proxy.e2e.test.ts` or add a focused multi-client file
using `discord-digital-twin/src`. Keep the test under approximately ten seconds
or split scenarios across files.

Required scenarios:

1. Users A and B have separate workers in one guild and one shared project
   channel.
2. A starts a session; only worker A creates and handles the thread.
3. B starts another session; only worker B handles it.
4. B speaks or invokes a command in A's thread; worker A handles it.
5. An unlinked user is silently ignored and creates no thread.
6. A disconnects; only A's event buffers and wakes A's reachable URL.
7. Gateway restart preserves both thread routes.
8. A worker credential cannot mutate the other worker's thread through REST.
9. `kimaki send` posts a starter marker; the resulting session runs on the
   sending client's worker, and the created thread routes to it.

Every test that creates or modifies Discord messages must snapshot
`channel.text()` or `thread.text()` before other assertions.

### CLI validation

After each implementation change under `cli/`:

```bash
cd cli
pnpm exec tsc --noEmit
```

After important message-routing changes:

```bash
cd cli
pnpm test -u --run
```

Investigate snapshot changes rather than accepting them blindly. Existing
unrelated typecheck or environment failures must be reported separately and
must not obscure focused routing results.

### Database and website validation

```bash
cd db
pnpm gen
pnpm dev
pnpm push:dev

cd ../website
pnpm test --run
```

Use only the local Prisma Dev database during implementation. Production schema
application is a deliberate human step.

## Observability

Add reason-coded metrics without prompt content:

- `gateway_route_selected{reason=user_default|thread_owner|grant|kimaki_send}`
- `gateway_route_dropped{reason=unlinked|disabled|ambiguous|missing_thread|route_insert_failed}`
- `gateway_route_conflict`
- `gateway_target_wake`
- `gateway_target_buffer_depth`
- `gateway_cross_worker_rest_denied`

Log route decisions at debug level and conflicts/security denials at warn level.
Include guild, thread, client, and owner IDs only where operationally necessary.

## Rollout

1. Deploy schema additions with no routing behavior change.
2. Backfill `discord_user_id` from existing Better Auth account links using
   the query in Milestone 1.
3. Seed `gateway_thread_routes` for pre-existing threads: each worker reports
   its local `thread_sessions` thread IDs through a new `kimaki` subcommand
   (or a one-time script) so live threads do not fail closed at cutover.
   Without this step, every thread created before rollout goes dead the
   moment single-target routing is enabled.
4. Populate explicit defaults for a small allowlist of test users.
5. Deploy proxy routing behind a default-off feature flag for one test guild.
6. Run two-worker shadow classification that records decisions but preserves
   current behavior.
7. Enable single-target routing for the test guild.
8. Validate disconnect, wake, proxy restart, and cross-worker REST denial.
9. Expand to additional users only after route conflict and drop metrics remain
   understood.

Do not enable multiple same-guild production workers before single-target
routing is active; current guild-only fanout can create duplicate threads and
duplicate model spend.

## Rollback

- Disable the feature flag to return to one designated client per guild.
- Do not return to broadcasting execution events across same-guild clients.
- Keep route rows for audit and later recovery; stop creating new routes.
- Disable affected clients through `gateway_clients.enabled` if ownership is
  uncertain.
- Database additions are additive and can remain during rollback.
- Restore the prior gateway-proxy binary through the repository deployment
  process, not direct `fly deploy`.

When changing the `gateway-proxy` submodule, commit and push its fork branch
first, verify the remote advertises the commit, then update the parent gitlink.

## Decisions (resolved in 2026-08-26 review)

The guiding principle from review: **minimal v1 MVP — cut everything that is
not required for two users to share one guild safely.**

1. **Starter eligibility:** personal worker only for MVP. Grants and sponsors
   are Follow-up.
2. **Multiple workers:** one default per guild first; channel overrides later.
3. **Missing worker UX:** silent for everyone in the MVP, observable through
   `gateway_route_dropped` metrics. The explicit "your worker is
   offline/unlinked" status response is Follow-up (see Scope).
4. **Existing routes after revocation:** pause; require explicit transfer or
   re-enable. Never reassign automatically.
5. **Exe identity:** one-time worker claim code bound to the already
   authenticated Discord user. Do not block on an undocumented exe OAuth
   contract.
6. **Grant accounting:** deferred entirely until `/gang` work starts.

## Done When

- Two users in one Discord guild can run independent Kimaki workers without
  duplicate responses or sessions.
- A new thread is assigned exactly once to its starter's selected worker.
- Every later event in that thread stays on the pinned worker regardless of
  message author.
- Provider credentials and OpenCode state never leave the worker.
- Unlinked, disabled, missing, and ambiguous routing states fail closed.
- Offline replay and wake target only the owner worker.
- Gateway and worker restarts preserve routing.
- Cross-worker REST mutation is denied.
- Users can inspect and deliberately change their default worker.
- Focused and full validation pass, with any pre-existing failures documented.
