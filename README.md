# Detour Check

Roadworks close streets that buses run on. A city publishes a detour for some of them, but not always for the
whole time the works run, in both directions, or at all. Then buses get stuck at the works, and riders wait at
stops no bus will reach.

Detour Check is a Jira app that finds those gaps in a city's open data. It turns each fix into a change
request that every team signs off and Rovo writes up. Jira holds the change back until what is published
matches the plan.

Built for Codegeist 2026 on Atlassian Forge. Category: Apps for Specialized Industries.

## Try it in two minutes

1. [Install Detour Check](https://developer.atlassian.com/console/install/6da71f64-f985-4d80-8158-d64afc976b81?signature=AYABeMCGCBiFzjxWWGXtiqhuYUIAAAADAAdhd3Mta21zAEthcm46YXdzOmttczp1cy13ZXN0LTI6NzA5NTg3ODM1MjQzOmtleS83MDVlZDY3MC1mNTdjLTQxYjUtOWY5Yi1lM2YyZGNjMTQ2ZTcAuAECAQB4CxqLTo9l4lqXuFjNim1xJM%2Bp%2F3TVP9xHS2BrU5DRRucBMs%2FmJg9pfZw98u3kp7xZ5QAAAH4wfAYJKoZIhvcNAQcGoG8wbQIBADBoBgkqhkiG9w0BBwEwHgYJYIZIAWUDBAEuMBEEDMxc5gCAdOpU3SDIZgIBEIA7LA0f%2B94G8pW8S9Sooj7uIYfyLXclQUPmhK%2FKn40%2BhkY5OvYZpMuuF%2BjJnwEo%2FghgL9u4kKtp9TcP3OYAB2F3cy1rbXMAS2Fybjphd3M6a21zOmV1LXdlc3QtMTo3MDk1ODc4MzUyNDM6a2V5LzQ2MzBjZTZiLTAwYzMtNGRlMi04NzdiLTYyN2UyMDYwZTVjYwC4AQICAHi9bVMAkme4qVQX1fQHo6ePw3H40A7cGfz7yrmSfBWMXgGrPyTlrvjzFE6X6n8%2Bfsl9AAAAfjB8BgkqhkiG9w0BBwagbzBtAgEAMGgGCSqGSIb3DQEHATAeBglghkgBZQMEAS4wEQQMVmEqdaEApjXTAV5wAgEQgDtiGYuCi9yTGBxFbefsVIIDA38Zq0L%2FymvJHX7AABC5mV%2FBQho0dqNmlswRrkOgS1Dziaxz4zQuWlc5mwAHYXdzLWttcwBLYXJuOmF3czprbXM6dXMtZWFzdC0xOjcwOTU4NzgzNTI0MzprZXkvNmMxMjBiYTAtNGNkNS00OTg1LWI4MmUtNDBhMDQ5NTJjYzU3ALgBAgIAeDYASx0XCjkny4iLV6vz%2BKtEGSGT6kdt0QRpkn6D%2FlVEAefpL%2BI0Qd50HLwseLW5x8kAAAB%2BMHwGCSqGSIb3DQEHBqBvMG0CAQAwaAYJKoZIhvcNAQcBMB4GCWCGSAFlAwQBLjARBAyl%2F1tY4MGfrdphe70CARCAO9coID7hjMW7VeXiEbasbF1PSQHhMUvOAfvNsYuEQfzAptaFR3NrDi%2BUX6LvlLxdKuq7zKZ1RSZLjBhyAgAAAAAMAAAQAAAAAAAAAAAAAAAAAO%2BdhOrJye9tPiIbdGAsnCX%2F%2F%2F%2F%2FAAAAAQAAAAAAAAAAAAAAAQAAADLTxW7hY9X6UWIV1hGncVWVN8ntJYMtGw%2BFWpdBvL4EtxhKwSjI%2BYgaseFGyJnG4eaA18%2BTSY8biToIJoclv6OMXXI%3D&product=jira) on a Jira site where you are an admin.
2. Open **Apps → Detour Check**. The welcome tour sets the scene in five steps.
3. Click **Set up**. Detour Check creates a Jira Service Management space, Roadworks Changes, or uses the
   space an admin picks instead (any space works), and adds its go-live check to the space's workflow.
   Nothing to configure by hand.
4. Open **177 Cours de la Marne**. The published detours for its five bus lines end by 27 November, but the
   works run until 4 December: seven days with no detour.
5. Click **Yes, road closed, buses detour** to confirm the published plan. (A site with no detour asks what
   happens to buses instead, with four answers: Road closed, buses detour; Buses skip some stops; Buses
   slowed, lane narrowed; No effect on buses.) Detour Check opens a change request in your space. Where the space
   has change management (Jira Service Management Premium or Enterprise), it is a Change with the dates, risk,
   impact and implementation plan filled in; otherwise it is a Task.
6. Sign off for Scheduling, Passenger information and Drivers. Operations can't sign off until the detour
   covers the whole works. Open the work item to see the same plan in its Detour Check panel, each sign-off
   as an internal note, and the go-live checks.
7. Ask Rovo: **Handle the roadworks at 177 Cours de la Marne**. The Detour Check agent writes the impact
   assessment and a passenger notice in French and English, and records them on the change request.

The app opens on a **demo day**: Bordeaux's feeds as they were published on 22 November 2026, frozen so that
what you see matches the video. A Jira admin can switch to live data from the ••• menu.

## What it does

- **Checks every roadworks site against the published detours.** For each site on a bus route, it checks:
  - that a detour leaves and rejoins the route on either side of the works;
  - that it runs in both directions;
  - that it runs for the whole time the works do.
  A problem is a published detour that ends before the works do. On a fresh install, that is 3 of the 61
  sites on the demo day; 57 more need a closer look, led by works in the roadway with no detour, and 1 is
  covered. The list puts the problems first, and the map draws one line at a time with the detour's start
  and end.
- **Turns the fix into a change request.** It fills in Jira Service Management's own fields: planned start and
  end, change type, risk and impact by the number of lines, implementation, backout and test plans. Each of
  four teams signs off: Operations, Scheduling, Passenger information and Drivers. A team can't sign off
  while a check its own work answers to fails: Operations, for instance, while the detour falls short.
  Changing what the plan is checked against clears the sign-offs and says so on the work item (swapping
  "road closed" for "stops not served", which are checked alike, does not). A plan can say the works run
  longer than the permit, never shorter, so narrowing it cannot make a check pass. The change's own fields (dates, risk, impact,
  implementation plan) follow the plan, and every note the app writes is internal.
- **Keeps checking.** Every hour it compares each plan with what is published, and comments when a plan
  starts or stops matching. A change already live whose checks start failing is never moved back: its
  work item gets a "Live, but the checks no longer pass" note for its teams, and the desk and the panel
  show it in red.
  - **Status:** each plan's status is written to the work item, so JQL can find it, for example
    `detourCheck = failing` or `detourCheck = waiting`. The statuses are `unanswered`, `waiting`,
    `failing`, `ready`, `gone` (the roadworks left the feed) and `unknown` (the data can't vouch for it
    right now).
  - **Go-live gate:** setup adds the **Detour Check is ready** validator to every transition into
    Awaiting implementation, Implementing and Completed (Standard change, Approve, Emergency override,
    Implement, Mark as done and the rest), and to finishing in the space's other workflows, so changing
    the work item's type or space skips nothing. A workflow shared with other spaces is left alone.
    Jira then won't let the change go live, or be closed as done, until its checks pass and its teams
    have signed off, and says what is missing. The validator works it out from the app's own storage and
    the published data, not from anything on the work item, and says no when it can't be sure.
  - **Lowering a plan takes two people.** Saying the works have no effect on buses, only slow them, or
    need a detour one way only asks for a written reason, which goes on the work item. Operations must
    then sign off as someone other than the person who lowered it. Rovo and MCP clients can't lower a
    plan at all, and only answer the impact while nobody has.
- **Works with Rovo and other agents.** The Detour Check agent and an MCP server share five actions:
  - list disruptions;
  - get one;
  - create a change request;
  - check it;
  - record an assessment.
  Agents can only write to change requests that Detour Check opened. Every limit is enforced in code, never
  left to the model.

### Setting it up on your site

- **Space for plans:** **Set up** on the Detour Check page creates one, or a Jira admin picks one. The
  menu shows what the space offers: its issue type, how many of the change fields it has, who can sign
  off, and how many transitions the go-live check guards.
- **Who signs off:** by default, anyone who can edit the change request signs off for any team, and only
  they can change its plan. To restrict a
  team, create a group named `detour-check-ops`, `detour-check-scheduling`, `detour-check-passengers` or
  `detour-check-drivers`; only its members then sign off for that team.
- **Who hears about it:** a team's group members are @mentioned in an internal note and added as
  watchers whenever a plan needs them: when it is first answered, when a change clears the sign-offs,
  when someone lowers it (Operations), and when the hourly check finds it no longer matches what is
  published. Jira's own notifications (bell, email, mobile app) do the rest.
- **Go-live gate:** if the space's workflow later loses it, the page says so and offers **Add the go-live
  check**. It can also be added by hand under Rules → Validate details.
- **MCP clients:** a site admin turns on Detour Check's tools under admin.atlassian.com → Apps → Sites →
  your site → Connected apps. Then, for example:
  `claude mcp add --transport http detour-check https://mcp.atlassian.com/forge/6da71f64-f985-4d80-8158-d64afc976b81`

## Beyond Bordeaux

The check needs three things, and most cities publish all three:

| Detour Check reads | In Bordeaux | Elsewhere |
|---|---|---|
| Planned roadworks, with an outline and dates | `ci_chantier` permits | [WZDx](https://github.com/usdot-jpo-ode/wzdx) work zone feeds (US), DATEX II roadworks (EU), city permit registers |
| The network: lines, routes and stops | `sv_ligne_a`, `sv_chem_l`, `sv_arret_p` | Any [GTFS](https://gtfs.org) feed |
| Published detours and passenger messages | `sv_devia_l`, `sv_messa_a` | [GTFS-Realtime Service Alerts](https://gtfs.org/realtime/), GTFS-Flex or the operator's own detour export |

Everything specific to Bordeaux sits in one place: the feed names in `app/src/model.js`, and the snapshot
script for the network. The checks, the change requests, the sign-offs and the agent work on any city's
data. A second city means a small adapter that turns its feeds into the same three shapes.

The people who would install it are a transit operator's network planning and passenger information teams,
or a city's roads department. Both already run planned changes through a service desk.

## Data and licences

All data is open and needs no key.

| What | Dataset | Publisher |
|---|---|---|
| Roadworks permits | [ci_chantier](https://opendata.bordeaux-metropole.fr/explore/dataset/ci_chantier/) | Ville de Bordeaux |
| Published bus detours | [sv_devia_l](https://opendata.bordeaux-metropole.fr/explore/dataset/sv_devia_l/) | Bordeaux Métropole |
| Messages at stops | [sv_messa_a](https://opendata.bordeaux-metropole.fr/explore/dataset/sv_messa_a/) | Bordeaux Métropole |
| Lines, routes, stops | [sv_ligne_a](https://opendata.bordeaux-metropole.fr/explore/dataset/sv_ligne_a/), [sv_chem_l](https://opendata.bordeaux-metropole.fr/explore/dataset/sv_chem_l/), [sv_arret_p](https://opendata.bordeaux-metropole.fr/explore/dataset/sv_arret_p/) | Bordeaux Métropole |

- **Licence:** the datasets are published under the [Licence Ouverte](https://www.etalab.gouv.fr/wp-content/uploads/2014/05/Licence_Ouverte.pdf).
- **Map tiles:** © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
- **Coverage:** the roadworks feed is the City of Bordeaux's own, titled for Bordeaux and Mérignac. On the
  demo day, 58 of the 61 roadworks on bus routes are in Bordeaux. Works permitted by the other towns on
  the network are not in it.

## How it is built

- **`app/`:** a Forge app on Node 24.
  - A Jira global page and an issue panel, both Custom UI: `static/brief`.
  - A resolver: `src/index.js`.
  - A Rovo agent with five actions, served over MCP too.
  - An hourly scheduled trigger.
  - A queue consumer that builds live data in the background: `src/live.js`.
  - An issue-deleted trigger.
  - An indexed issue property for JQL, and a workflow validator function.
- **`src/model.js`:** the matching and the checks. It matches permit outlines to routes within 15 m, decides
  whether a detour goes round the works, and computes the coverage dates.
- **Data:**
  - The demo day is computed at build time (`scripts/precompute.mjs`).
  - Live data is built by the queue consumer and stored gzipped in Forge storage.
  - The page draws the last copy it saw straight away, then refreshes it.
- **Requests:** they run as the person using the app, so Jira's own permissions apply and the history
  shows who did what. A few run as the app: the hourly check, the status written on work items, the
  team-group lookup and the clean-up when a work item is deleted.

```bash
cd app
npm install && npm --prefix static/brief install
npm run check      # lint and tests (a fake Jira and fake Forge storage, no site needed)
npm run build      # precomputes the demo day and builds the page
npm run deploy     # check, build, deploy to the development environment
npm run demo-day   # freezes today's feeds as the demo day
npm run snapshot   # refreshes the network snapshot
```

Forge needs Node 24.22.2 or newer (`.node-version`). Opened outside Jira, the page runs on a local stand-in
(`static/brief/src/local.js`), so it can be tried with any static server.

`prototype/` is the first local prototype, kept for reference.

## Licence

MIT. See [LICENSE](LICENSE).
