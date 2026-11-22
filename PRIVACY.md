# Privacy policy

Detour Check is a Jira app built on Atlassian Forge. This page says what it reads, what it keeps and where.

## What it keeps

- **Plans and sign-offs.** For each change request it opens, the app keeps the plan (impact, dates, reason
  for a lower impact) and who signed off for each team, by Atlassian account ID.
- **Settings.** The space chosen for plans.
- **Copies of public data.** Roadworks, bus lines and published detours from Bordeaux Métropole's open data.

All of it is stored in Forge storage, which Atlassian hosts. Nothing is stored anywhere else. Uninstalling the
app removes its storage.

## What it writes to Jira

Work items, fields, internal notes, watchers and a work item property, in the space an admin chooses. These
are ordinary Jira data and follow your site's own permissions and retention.

## What it reads from outside Jira

- `opendata.bordeaux-metropole.fr`: public datasets, with no information about you or your site in the request.
- `tile.openstreetmap.org`: map images, loaded by your browser.

## What it does not do

- It sends no personal data outside Atlassian.
- It has no analytics or tracking.
- It doesn't sell or share data.

## AI

The Rovo agent and the MCP tools run on Atlassian's AI features, under your Atlassian agreement. Detour Check
gives them only what its actions return.

## Contact

Questions go to [GitHub issues](https://github.com/djbrl/detour-check/issues).
