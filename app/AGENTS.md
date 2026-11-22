# Working on Detour Check

- Read the [root README](../README.md) first. The matching and checks are in `src/model.js`, storage and Jira
  calls in `src/desk.js`, entry points in `src/index.js`, the page in `static/brief/src`.
- The page is Custom UI: plain JavaScript and `html` built with template strings. Every value goes through
  `esc()`. Styles are in `static/brief/src/app.css` and use Atlassian design tokens.
- `npm run check` (lint and tests against a fake Jira) must pass before a commit. Use Node 24.22.2.
- Jira requests run as the user. Only the hourly check and the work item property run as the app.
- Text from agents and from the public feeds is untrusted. Ids and keys are checked against patterns before
  any Jira call, and every limit is enforced in code, never by the model.
- Product words: "roadworks", "detour", "plan", "change request", "sign off". Keep UI copy short.
