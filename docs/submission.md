# Codegeist 2026 submission

- **Category:** Apps for Specialized Industries.
- **Bonus tracks:** Best Agents (Rovo agent and actions), Best app with Atlassian MCP (`rovo:mcp`).
- **Rules:** video under 5 minutes, public on YouTube; install link from "Start sharing your app"; setup
  steps for judges; deadline 22 Dec 2026, 12:00 PT.

## Devpost text

**Tagline:** Every roadworks site on a bus route, checked against the published detour, and every fix planned
in Jira.

**Inspiration.** In Bordeaux, the city publishes roadworks permits and the bus network publishes its detours,
in two separate feeds. Nobody checks one against the other. On the day we froze for the demo, 61 roadworks
sat on bus routes, and only 12 had a detour published. On 3 of them the detour ends before the works do:
Detour Check flags those as problems. 57 more need a closer look, starting with works in the roadway with no
detour that day.
At 177 Cours de la Marne, the detours for five bus lines end by 27 November, a week before the works do.

**What it does.**
- Detour Check reads the city's open data, live or as a frozen demo day.
- It matches each roadworks site to the bus routes it blocks, and checks the published detours. Does one go
  round the works? Both ways? For the whole time?
- Each problem becomes a change request: a Change in a Jira Service Management space, with:
  - the change fields filled in;
  - four teams that sign off;
  - an hourly check that comments when what is published stops matching the plan;
  - a status that JQL and queues can search;
  - a workflow validator, added by one-click setup, that holds the change back until it is ready. It
    decides from the app's own storage and the published data, and says no when it can't be sure;
  - a written reason and a second person whenever someone lowers a plan's impact.
- The Detour Check Rovo agent writes the impact assessment and a bilingual passenger notice. The same actions
  are served over MCP.

**How we built it.**
- Forge, Node 24, with Custom UI on a Jira global page and an issue panel.
- A Rovo agent with five actions, also served through `rovo:mcp`.
- A scheduled trigger, a queue consumer that builds live data in the background, and an issue-deleted
  trigger.
- An indexed issue property (`jira:entityProperty`) and a function-based workflow validator.
- The matching runs on the city's own geometry: permit outlines against route shapes within 15 m, and detour
  end stops on either side of the works.

**Challenges.**
- Live data takes longer to build than the 25 seconds a page call is allowed, so it is built in the
  background and stored in pieces. The page always opens at once on the last copy it saw.
- Making the check impossible to pass by editing the plan: any change to what is checked clears the
  sign-offs and is written on the work item. Only people who can edit the work item can change the plan,
  and a team can't sign off while a check its own work answers to fails. The gate ignores the work item's
  own fields.
- Keeping sign-offs from overwriting each other: each team's sign-off is stored on its own, tied to the
  version of the plan it approved.

**What's next.**
- A second city, through adapters for GTFS, GTFS-Realtime Service Alerts, WZDx and DATEX II.
- Sign-offs as JSM approvals.
- A Marketplace listing.

## Video script (about 3 min 30)

| Time | Screen | Voice |
|---|---|---|
| 0:00 | A street with a barrier, then the app's tour, step 1 | "Bordeaux has 61 roadworks on bus routes today. The bus network has published a detour for 12 of them." |
| 0:20 | Tour, steps 2 and 3 | "When the detour is missing, or ends too early, buses get stuck and riders wait at stops nobody serves. Detour Check finds 3 problems and 57 roadworks to check in the city's open data." |
| 0:40 | Desk, Problems, 177 Cours de la Marne; map, line 9, detour start and end | "Here: the works run until 4 December, but the detours for its five lines end by 27 November. Seven days with no detour." |
| 1:10 | Click Yes; the change request opens in JSM with its fields | "One click opens a change request in Jira Service Management, with the dates, risk, impact and implementation plan already filled in." |
| 1:35 | Rovo: "Handle the roadworks at 177 Cours de la Marne"; the notice is recorded on the work item | "Rovo writes the impact assessment and the passenger notice in French and English, and records them on the change." |
| 2:10 | Sign-offs, Operations held back; the work item's panel; try "Standard change", blocked by the validator with its reason | "The teams sign off, but Operations can't until the detour covers the whole works, and Jira will not let the change go live." |
| 2:40 | JQL `detourCheck = failing` in a queue | "Every plan's status is searchable, so it fits the queues and dashboards teams already use." |
| 2:55 | An MCP client calling list-disruptions | "The same actions are open to any agent over MCP, with every limit enforced in code." |
| 3:10 | README "Beyond Bordeaux" table | "Bordeaux is the first city. Any city with a roadworks feed, a GTFS network and published alerts can run it." |
| 3:25 | Desk | "Detour Check." |

## Before recording

- Install link (production): https://developer.atlassian.com/console/install/6da71f64-f985-4d80-8158-d64afc976b81?signature=AYABeMCGCBiFzjxWWGXtiqhuYUIAAAADAAdhd3Mta21zAEthcm46YXdzOmttczp1cy13ZXN0LTI6NzA5NTg3ODM1MjQzOmtleS83MDVlZDY3MC1mNTdjLTQxYjUtOWY5Yi1lM2YyZGNjMTQ2ZTcAuAECAQB4CxqLTo9l4lqXuFjNim1xJM%2Bp%2F3TVP9xHS2BrU5DRRucBMs%2FmJg9pfZw98u3kp7xZ5QAAAH4wfAYJKoZIhvcNAQcGoG8wbQIBADBoBgkqhkiG9w0BBwEwHgYJYIZIAWUDBAEuMBEEDMxc5gCAdOpU3SDIZgIBEIA7LA0f%2B94G8pW8S9Sooj7uIYfyLXclQUPmhK%2FKn40%2BhkY5OvYZpMuuF%2BjJnwEo%2FghgL9u4kKtp9TcP3OYAB2F3cy1rbXMAS2Fybjphd3M6a21zOmV1LXdlc3QtMTo3MDk1ODc4MzUyNDM6a2V5LzQ2MzBjZTZiLTAwYzMtNGRlMi04NzdiLTYyN2UyMDYwZTVjYwC4AQICAHi9bVMAkme4qVQX1fQHo6ePw3H40A7cGfz7yrmSfBWMXgGrPyTlrvjzFE6X6n8%2Bfsl9AAAAfjB8BgkqhkiG9w0BBwagbzBtAgEAMGgGCSqGSIb3DQEHATAeBglghkgBZQMEAS4wEQQMVmEqdaEApjXTAV5wAgEQgDtiGYuCi9yTGBxFbefsVIIDA38Zq0L%2FymvJHX7AABC5mV%2FBQho0dqNmlswRrkOgS1Dziaxz4zQuWlc5mwAHYXdzLWttcwBLYXJuOmF3czprbXM6dXMtZWFzdC0xOjcwOTU4NzgzNTI0MzprZXkvNmMxMjBiYTAtNGNkNS00OTg1LWI4MmUtNDBhMDQ5NTJjYzU3ALgBAgIAeDYASx0XCjkny4iLV6vz%2BKtEGSGT6kdt0QRpkn6D%2FlVEAefpL%2BI0Qd50HLwseLW5x8kAAAB%2BMHwGCSqGSIb3DQEHBqBvMG0CAQAwaAYJKoZIhvcNAQcBMB4GCWCGSAFlAwQBLjARBAyl%2F1tY4MGfrdphe70CARCAO9coID7hjMW7VeXiEbasbF1PSQHhMUvOAfvNsYuEQfzAptaFR3NrDi%2BUX6LvlLxdKuq7zKZ1RSZLjBhyAgAAAAAMAAAQAAAAAAAAAAAAAAAAAO%2BdhOrJye9tPiIbdGAsnCX%2F%2F%2F%2F%2FAAAAAQAAAAAAAAAAAAAAAQAAADLTxW7hY9X6UWIV1hGncVWVN8ntJYMtGw%2BFWpdBvL4EtxhKwSjI%2BYgaseFGyJnG4eaA18%2BTSY8biToIJoclv6OMXXI%3D&product=jira
- Test the install link on a clean site.
- Record on a clean site, so 177 Cours de la Marne is still a Problem with no change request.
- Click **Set up** on the clean site: it creates Roadworks Changes and adds the go-live check.
- Check `detourCheck = failing` in JQL after the first plans are re-marked.
- Run Rovo's record-assessment and the MCP endpoint once on the site.
