# Shift Brief (working name)

Every bus and tram driver starts their shift with what is different today on their own route, and
control can see who has read each warning.

## Where things are

- `prototype/`: the first local prototype. Plain Node, no dependencies. It reads Bordeaux Métropole's
  live open data (diversions, roadworks permits, passenger messages, routes; no key needed). Driver
  duties and read receipts are simulated, because rosters are not public.
- The Forge app (Jira) will live in `app/` once the Atlassian account is logged in.

## Run the prototype

```bash
cd prototype && PORT=4310 node server.mjs
```

Then open http://localhost:4310.

## Forge setup

1. Create an Atlassian API token at https://id.atlassian.com/manage-profile/security/api-tokens.
2. `forge login` with your Atlassian email and that token.
3. `forge site provision` creates a free 90-day development site with Jira, Confluence, Jira Service
   Management, Rovo and sample data.
4. `forge create` in `app/`, then `forge deploy` and `forge install --demo-site`.

The Forge documentation server for coding agents is configured in `.mcp.json`.
