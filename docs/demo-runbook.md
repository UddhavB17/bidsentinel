# BidSentinel judge demo runbook

## The 90-second story

1. Start the chaos source, API, and dashboard with the commands in the README.
2. Point out the **Mock Demo** badge. The local flow is deterministic evidence,
   not a fake claim of a live provider call.
3. Click **Collect baseline**. Show the verified tender and snapshot.
4. Click **Detect layout drift**. Show that the broken extraction is quarantined
   while the last verified tender remains protected.
5. Click **Fetch healing preview**, then **Validate preview**. Explain that the
   repair keeps the same collector ID and cannot be approved until its preview
   passes the frozen contract.
6. Click **Approve & verify**. Show the successful same-collector rerun and the
   recovery ledger with counts/hashes.
7. Click **Detect amendment**. Show the deadline and corrigendum event, proving
   BidSentinel distinguishes website-structure drift from real business change.

## Live evidence checklist

Before recording the final submission video:

- Create/configure a real Bright Data Scraper Studio `c_*` collector against the
  stable chaos-source `/tenders` URL.
- Keep the collector ID, API token, and operator token out of Git and recordings.
- Capture a redacted baseline job result.
- Switch the chaos source from `baseline-table` to `layout-cards`.
- Capture the refactor request, structured preview, human approval, terminal
  `done` state, and rerun using the same redacted collector ID.
- Switch to `amended` and capture the deadline/corrigendum event.
- Run `pnpm check` immediately before recording; state the exact result.

Do not say “live self-healing is proven” until this credentialed trail exists.
