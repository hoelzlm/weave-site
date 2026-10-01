# Issue tracker: GitHub Issues

Issues and specs for this repo live in GitHub Issues on `hoelzlm/weave-site`. Use the `gh` CLI (`-R hoelzlm/weave-site`).

## Conventions

- One feature per spec issue, titled `Spec: <feature>` and labelled `spec` plus the feature label (e.g. `seo`, `german-launch`; create a new feature label for a new feature)
- Implementation tickets are one issue each, added as **sub-issues** of the spec (`gh api -X POST repos/hoelzlm/weave-site/issues/<spec>/sub_issues -F sub_issue_id=<ticket's id>`; the `id` is in the create response, not the `#number`) — never a single combined tickets issue
- A ticket's body starts with `Part of #<spec>`, then `**What to build:**`, `**Blocked by:** #N, #N` (or `None — can start immediately`) and a checklist of acceptance criteria
- Triage state is a label: `ready-for-agent` (fully specified, an agent can take it) or `owner-task` (needs the owner's accounts or a decision). A finished ticket is closed as completed, with a closing comment saying where the work landed
- Comments and conversation history go in issue comments

## When a skill says "publish to the issue tracker"

Create the spec issue first, then each ticket issue, then link every ticket to the spec as a sub-issue.

## When a skill says "fetch the relevant ticket"

`gh issue view <number> -R hoelzlm/weave-site --comments`. The user will normally pass the issue number or URL.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a parent issue with one **child** sub-issue per ticket.

- **Map**: an issue titled `Map: <effort>`, labelled `map`, whose body holds the Notes / Decisions-so-far / Fog sections.
- **Child ticket**: a sub-issue of the map with the question in the body and a type label (`research`/`prototype`/`grilling`/`task`).
- **Blocking**: a `**Blocked by:** #N, #N` line near the top. A ticket is unblocked when every issue it lists is closed.
- **Frontier**: open sub-issues of the map that are unblocked and unassigned; lowest number wins.
- **Claim**: assign the issue to yourself (`gh issue edit <n> --add-assignee @me`) before any work.
- **Resolve**: post the answer as a comment headed `## Answer`, close the issue, then add a context pointer (gist + link) to the map issue's Decisions-so-far.
