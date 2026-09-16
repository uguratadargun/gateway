# 0011. Three auth surfaces, three rules

Status: accepted
Date: 2026-09-16
Run: 28ad71e (the admin session) / edd57d9 (the client API's own rule)

## Context

gate serves three different kinds of caller over one server. A person drives the dashboard from a browser. Any Anthropic-compatible tool points at the gateway and sends model requests. The `gate` CLI on a developer's machine calls the client API to fetch its team's definitions and report what a run did. These have nothing in common: one has a browser and a person behind it, one is a local tool on the same machine, one is a program reached across the network holding a key that names somebody.

One rule covering all three would have to be the weakest of the three, and each of the three has a different thing to lose.

## Decision

Each surface has its own rule, and they do not overlap. The admin surface — the dashboard and the `/api/*` management routes — requires an admin session, an HMAC-signed HttpOnly cookie, and refuses to serve at all when no admin secret is configured. The gateway takes an issued key with the `gateway` scope, or the `GATE_API_KEY` environment variable, and runs open when neither is configured. The client API takes the same keys and is never open.

## Rationale

The admin cookie cannot guard the other two, because there is no browser on the other end of either. A CLI and an SDK client have no cookie jar and no login redirect to follow; requiring one would mean inventing a second, weaker path around it, which is the thing to avoid.

The gateway may run keyless because a loopback-only install has nothing to protect from itself. gate binds to localhost by default, and the gateway's worst case there is a program on the same machine using the model access the person already has. Demanding a key for a single-user install on loopback buys nothing and is the friction that makes people disable auth entirely.

The client API is never open, and the asymmetry is deliberate: it is the surface people reach across the network, and an unauthenticated caller there would be handed every workflow and agent a team has written. `GATE_API_KEY` still works for the single-person install that has issued no keys, so the easy case stays easy without opening the definitions to anyone who can reach the port.

The admin surface refuses rather than degrades. With no admin secret set, it answers 503 and says why, instead of serving the dashboard unauthenticated. An unconfigured admin surface that quietly works is one that goes to production unnoticed; one that refuses is fixed in the first minute.

A key is an identity, not a password. It names a person and a team and carries scopes, so a revoked key or a disabled person's key stops resolving at once, and the gateway checks for the `gateway` scope rather than treating any valid key as admission to everything.

## Alternatives

One rule for everything, with the admin cookie in front of all three. The gateway and the client API would need a non-browser path anyway, so this is the same three rules with one of them hidden.

Require a key on the gateway always. It protects a loopback install from itself, and the cost is every single-user setup starting with a configuration step whose only effect is friction. The people who need it — anyone binding to a LAN — issue keys.

Open the client API when no keys are issued, symmetrically with the gateway. It would hand a team's whole set of definitions to any caller that can reach the port, and the definitions are the thing the network case exists to protect.

Roles and permissions on the admin surface. There is one administrator: the person who runs the gate. A role system would be machinery guarding a boundary that has one person on the near side of it.

Serve the admin surface unauthenticated when no secret is configured, as a convenience. The failure is silent and the blast radius is every connected account.

## How it works

`src/middleware.ts` matches every request. Paths under `/api/gateway/` and `/api/v1/` pass through to their own auth; the login page and the admin login route pass through; everything else needs a valid session cookie verified against the admin secret, and gets a 401 for an API path or a redirect to the login page otherwise. With no admin secret configured, everything that reaches the admin branch is refused 503.

`gatePrincipal` resolves a gateway request: when any key is active it must be a valid key carrying the `gateway` scope, otherwise `GATE_API_KEY` must match if it is set, otherwise the caller is nobody in particular and answers as the default team. The client API resolves the same keys through the tenancy layer and rejects an unauthenticated caller outright.

Every client API response carries the server's version and the oldest client it will serve, so a CLI learns it is behind from any call rather than from the one that finally breaks.

## Consequences

The three rules have to be reasoned about separately, and a new route belongs to exactly one of them. A management route added under `/api/v1/` would be reachable with a team key rather than an admin session, which is a real mistake available to make.

Binding gate to a LAN without issuing keys leaves the gateway open to that network. The default is loopback, and the open case is documented rather than prevented.

Anything that gives the gateway or the client API a browser-shaped login, or gives the admin surface a key-shaped one, crosses these boundaries and needs its own record.

## Touches

- `src/middleware.ts`
- `src/lib/admin-auth.ts`
- `src/lib/gate-auth.ts`
- `src/lib/tenancy.ts`
- auth
- gateway

## Supersedes

none
