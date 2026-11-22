# Shift Brief (working name)

Every bus and tram driver starts their shift with what is different today on their own route, and
control can see who has read each warning.

## Where things are

- `prototype/`: the first local prototype. Plain Node, no dependencies. It reads Bordeaux Métropole's
  live open data (diversions, roadworks permits, passenger messages, routes; no key needed). Driver
  duties and read receipts are simulated, because rosters are not public.
- `app/`: the Forge app, a Jira global page with Custom UI. It is deployed to the development
  environment and installed on the demo site https://one-atlas-zzyo.atlassian.net (expires
  2027-02-19).

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

## The Forge app

`app/` is a Jira global page (Custom UI). The page in `app/static/brief` does the work in the
browser: it fetches today's diversions, roadworks permits and passenger messages from Bordeaux open
data, matches them to routes from a bundled network snapshot (`src/network.json`), and shows the
driver brief and the control room. The backend (`app/src/index.js`) only stores who read what, per
day, in Forge storage.

```bash
cd app
npm install && npm --prefix static/brief install
npm run deploy      # builds the page and deploys to the development environment
npm run snapshot    # refreshes the network snapshot when routes or stops change
```

After a change to permissions in `manifest.yml`, run
`forge install --upgrade --demo-site --product jira --environment development`.

Notes:
- Forge needs Node 24.22.2 or newer (pinned in `.node-version`).
- Deploys skip `forge lint` (`--no-verify`) because the linter currently hangs on this project.
- Opened outside Jira (for example `python3 -m http.server -d app/static/brief/build`), the page
  keeps reads in memory so it can be tried without Forge.
