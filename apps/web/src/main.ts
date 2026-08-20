import type {
  SourceHealth,
  TenderChange,
  TenderSummary,
} from "@bidsentinel/contracts";

import {
  DataClientError,
  FixtureBidSentinelDataClient,
  HttpBidSentinelDataClient,
  type BidSentinelDataClient,
  type CollectionMode,
  type DashboardSnapshot,
  type HealingState,
  type RuntimeStatus,
} from "./data-client";
import "./style.css";

const appElement = document.querySelector<HTMLElement>("#app");
if (appElement === null) throw new Error("Missing #app root");
const app: HTMLElement = appElement;

const query = new URLSearchParams(window.location.search);
const useFixtures = query.get("adapter") === "fixture";
const configuredApiBase = import.meta.env.VITE_API_BASE_URL?.trim() ?? "";
const fixtureClient = useFixtures ? new FixtureBidSentinelDataClient() : null;
const client: BidSentinelDataClient =
  fixtureClient ?? new HttpBidSentinelDataClient(configuredApiBase);

let snapshot: DashboardSnapshot | null = null;
let busyAction: string | null = null;
let actionError: string | null = null;
let operatorToken = "";

const dateFormatter = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Kolkata",
});

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value: string | null): string {
  return value === null
    ? "Not published"
    : dateFormatter.format(new Date(value));
}

function labelState(value: string): string {
  return value.replaceAll("_", " ").replaceAll("-", " ");
}

function stateTone(state: HealingState): string {
  if (["healthy", "recovered", "preview_valid"].includes(state)) return "good";
  if (["recovery_failed", "rejected", "preview_invalid"].includes(state)) {
    return "danger";
  }
  if (["quarantined", "healing_requested"].includes(state)) return "warning";
  return "active";
}

function renderLoading(): void {
  app.innerHTML = `<main class="shell"><section class="loading-state" aria-live="polite">
    <span class="loader" aria-hidden="true"></span>
    <p class="eyebrow">Reading verified state</p>
    <h1>Connecting to BidSentinel…</h1>
    <p>The dashboard is loading tenders, incidents, recovery evidence and amendments.</p>
  </section></main>`;
}

function runtimeLabel(runtime: RuntimeStatus): string {
  if (runtime.mode === "live") return "Live Bright Data";
  return useFixtures ? "Mock Demo · Fixture Adapter" : "Mock Demo · Local API";
}

function renderRuntime(runtime: RuntimeStatus): string {
  const ready =
    runtime.mode === "mock" ||
    (runtime.collectorConfigured && runtime.targetConfigured);
  const issues = runtime.configurationIssues.length
    ? `<details class="runtime-issues"><summary>Runtime notes (${runtime.configurationIssues.length})</summary><ul>${runtime.configurationIssues
        .map((issue) => `<li>${escapeHtml(issue)}</li>`)
        .join("")}</ul></details>`
    : "";
  return `<div class="runtime-cluster">
    <span class="mode-pill ${runtime.mode}"><span aria-hidden="true"></span>${escapeHtml(runtimeLabel(runtime))}</span>
    <span class="readiness ${ready ? "ready" : "not-ready"}">${ready ? "Runtime ready" : "Configuration incomplete"}</span>
    ${issues}
  </div>`;
}

const flowStates: Array<{ state: HealingState; title: string; copy: string }> =
  [
    {
      state: "healthy",
      title: "Verified baseline",
      copy: "A schema-valid snapshot is protected.",
    },
    {
      state: "quarantined",
      title: "Layout drift contained",
      copy: "Broken extraction cannot overwrite good data.",
    },
    {
      state: "healing_requested",
      title: "Repair requested",
      copy: "The same collector is sent for refactoring.",
    },
    {
      state: "awaiting_approval",
      title: "Human safety gate",
      copy: "Preview must validate before approval.",
    },
    {
      state: "recovered",
      title: "Verified recovery",
      copy: "The repaired collector reruns successfully.",
    },
  ];

function flowIndex(state: HealingState, hasAmendment: boolean): number {
  if (hasAmendment) return 5;
  if (["recovered", "approved"].includes(state)) return 4;
  if (
    [
      "awaiting_approval",
      "preview_valid",
      "preview_invalid",
      "rejected",
      "recovery_failed",
    ].includes(state)
  ) {
    return 3;
  }
  if (state === "healing_requested") return 2;
  if (state === "quarantined") return 1;
  return 0;
}

function renderFlow(data: DashboardSnapshot): string {
  const currentIndex = flowIndex(
    data.healing.state,
    data.changes.data.length > 0,
  );
  const steps = [
    ...flowStates,
    {
      state: "healthy" as const,
      title: "Real amendment detected",
      copy: "Deadline and corrigendum changes become alerts.",
    },
  ];
  return `<ol class="flow" aria-label="BidSentinel recovery demonstration">
    ${steps
      .map((step, index) => {
        const status =
          index < currentIndex
            ? "complete"
            : index === currentIndex
              ? "current"
              : "pending";
        return `<li class="${status}"${status === "current" ? ' aria-current="step"' : ""}>
          <span class="step-number">${index + 1}</span>
          <div><strong>${escapeHtml(step.title)}</strong><p>${escapeHtml(step.copy)}</p></div>
        </li>`;
      })
      .join("")}
  </ol>`;
}

function actionButton(
  action: string,
  label: string,
  detail: string,
  enabled: boolean,
): string {
  const isBusy = busyAction === action;
  return `<button class="action-card" type="button" data-action="${action}" ${enabled && busyAction === null ? "" : "disabled"}>
    <span>${isBusy ? "Working…" : escapeHtml(label)}</span>
    <small>${escapeHtml(detail)}</small>
  </button>`;
}

function renderActions(data: DashboardSnapshot): string {
  const state = data.healing.state;
  const live = data.runtime.mode === "live";
  const liveAuthorized = !live || data.runtime.liveMutationsEnabled;
  const initialCollectionMode = live ? "live" : "valid";
  const layoutCollectionMode = live ? "live" : "drift";
  const amendmentCollectionMode = live ? "live" : "amended";
  const authPanel = live
    ? `<div class="operator-gate">
        <div><strong>Operator safety gate</strong><p>${data.runtime.liveMutationsEnabled ? "Live writes are enabled. The token stays in this tab's memory only and is never logged or stored." : "Live mutations are disabled by the backend. Read-only monitoring still works."}</p></div>
        ${
          data.runtime.liveMutationsEnabled
            ? `<label><span>Operator token</span><input id="operator-token" type="password" autocomplete="off" placeholder="32+ character token" aria-describedby="token-note"></label>
               <button class="text-button" type="button" data-action="forget-token">Forget token</button>
               <small id="token-note">${operatorToken ? "Token loaded in memory for this tab." : "Required for every live mutation."}</small>`
            : ""
        }
      </div>`
    : "";
  const sourceInstruction = live
    ? "Change the public chaos source to cards first, then run this same live collector."
    : "Submits the deterministic malformed drift fixture to the local API.";
  const amendmentInstruction = live
    ? "Publish the deadline extension on the source first, then scrape live."
    : "Submits the deterministic amended fixture to the local API.";

  return `<section class="demo-panel" aria-labelledby="demo-title">
    <div class="section-heading">
      <div><p class="eyebrow">Guided judge demo</p><h2 id="demo-title">Run the failure-to-signal proof</h2></div>
      <span class="state-badge ${stateTone(state)}">${escapeHtml(labelState(state))}</span>
    </div>
    ${authPanel}
    <div class="action-grid">
      ${actionButton(`collect:${initialCollectionMode}`, "1. Collect baseline", live ? "Run the configured Bright Data collector." : "Create the last verified snapshot through the mock API.", liveAuthorized)}
      ${actionButton(`collect:${layoutCollectionMode}`, "2. Detect layout drift", sourceInstruction, liveAuthorized && ["healthy", "recovered"].includes(state))}
      ${actionButton("heal-progress", "3. Fetch healing preview", "Poll the existing self-heal job; no collector is replaced.", liveAuthorized && ["healing_requested", "approved"].includes(state))}
      ${actionButton("validate-preview", "4. Validate preview", "Run the preview through the frozen tender contract.", liveAuthorized && ["awaiting_approval", "preview_invalid"].includes(state))}
      ${actionButton("approve", "5. Approve & verify", "Human approval, same-collector rerun, then recovery evidence.", liveAuthorized && state === "preview_valid")}
      ${actionButton(`collect:${amendmentCollectionMode}`, "6. Detect amendment", amendmentInstruction, liveAuthorized && state === "recovered")}
    </div>
    ${actionError ? `<p class="inline-error" role="alert">${escapeHtml(actionError)}</p>` : ""}
  </section>`;
}

function renderSource(
  source: SourceHealth | undefined,
  data: DashboardSnapshot,
): string {
  if (source === undefined) {
    return `<article class="empty-card"><h3>No source health yet</h3><p>Run the baseline collection to create the first monitored source record.</p></article>`;
  }
  const incident = source.activeIncident;
  return `<article class="source-card">
    <div class="source-card-head">
      <div><p class="eyebrow">${escapeHtml(source.sourceId)}</p><h3>${escapeHtml(labelState(source.state))}</h3></div>
      <span class="health-dot ${escapeHtml(source.state)}" aria-label="Source ${escapeHtml(source.state)}"></span>
    </div>
    <dl class="fact-grid">
      <div><dt>Last verified</dt><dd>${formatDate(source.lastSuccessfulAt)}</dd></div>
      <div><dt>Failure streak</dt><dd>${source.consecutiveFailures}</dd></div>
      <div><dt>Quarantined rows</dt><dd>${data.quarantines.data.length}</dd></div>
      <div><dt>Failure rate</dt><dd>${Math.round(source.recentFailureRate * 100)}%</dd></div>
    </dl>
    ${incident ? `<div class="incident"><strong>${escapeHtml(labelState(incident.reason))}</strong><p>${escapeHtml(incident.detail)}</p><small>Opened ${formatDate(incident.openedAt)}</small></div>` : '<p class="verified-copy">No active incident. The current snapshot passed contract validation.</p>'}
  </article>`;
}

function renderTender(tender: TenderSummary): string {
  const value = tender.estimatedValue
    ? new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: tender.estimatedValue.currency,
        maximumFractionDigits: 0,
      }).format(tender.estimatedValue.amount)
    : "Not disclosed";
  return `<article class="tender-card">
    <div class="tender-main">
      <p class="eyebrow">${escapeHtml(tender.sourceId)} · ${escapeHtml(tender.externalId)}</p>
      <h3><a href="${escapeHtml(tender.url)}" target="_blank" rel="noreferrer">${escapeHtml(tender.title)}</a></h3>
      <p>${escapeHtml(tender.buyer.name)}</p>
    </div>
    <dl class="tender-facts">
      <div><dt>Submission deadline</dt><dd>${formatDate(tender.submissionDeadline)}</dd></div>
      <div><dt>Estimated value</dt><dd>${escapeHtml(value)}</dd></div>
      <div><dt>Verified version</dt><dd>v${tender.latestSnapshot.version}</dd></div>
      <div><dt>Corrigenda</dt><dd>${tender.corrigendumCount}</dd></div>
    </dl>
  </article>`;
}

function describeChange(change: TenderChange): string {
  if (change.kind === "deadline") {
    return `Deadline moved from ${formatDate(change.before)} to ${formatDate(change.after)}`;
  }
  if (change.kind === "status") {
    return `Status changed from ${labelState(change.before)} to ${labelState(change.after)}`;
  }
  const count = change.added.length;
  return `${count} corrigendum${count === 1 ? "" : "s"} added`;
}

function renderChanges(data: DashboardSnapshot): string {
  if (data.changes.data.length === 0) {
    return `<article class="empty-card compact"><h3>No material amendments</h3><p>Layout changes are reliability incidents, not tender alerts.</p></article>`;
  }
  return data.changes.data
    .map(
      (event) => `<article class="alert-card">
        <span class="alert-icon" aria-hidden="true">!</span>
        <div><p class="eyebrow">Verified amendment · ${formatDate(event.detectedAt)}</p><h3>Action may be required</h3>
        <ul>${event.changes.map((change) => `<li>${escapeHtml(describeChange(change))}</li>`).join("")}</ul></div>
      </article>`,
    )
    .join("");
}

function renderRecovery(data: DashboardSnapshot): string {
  const incident = data.healing.incident;
  const evidence =
    incident?.evidence ?? data.sources.data[0]?.latestRecoveryEvidence;
  if (incident === null && evidence == null) {
    return `<article class="empty-card compact"><h3>No recovery attempt yet</h3><p>Recovery evidence appears only after a layout failure and verified rerun.</p></article>`;
  }
  const validation =
    data.healing.state === "preview_invalid"
      ? `<div class="validation-callout danger"><strong>Preview blocked</strong><p>The candidate output failed the frozen contract. Approval is disabled.</p></div>`
      : data.healing.state === "preview_valid"
        ? `<div class="validation-callout good"><strong>Preview passed</strong><p>${incident?.previewCount ?? 0} candidate record passed schema and count canaries.</p></div>`
        : "";
  const actions = evidence?.actions ?? [];
  return `<article class="ledger-card">
    <div><p class="eyebrow">Recovery ledger</p><h3>${escapeHtml(labelState(data.healing.state))}</h3></div>
    ${validation}
    <dl class="fact-grid">
      <div><dt>Collector</dt><dd>${escapeHtml(incident?.collectorId ?? "Recorded in evidence")}</dd></div>
      <div><dt>Preview rows</dt><dd>${incident?.previewCount ?? 0}</dd></div>
      <div><dt>Human gate</dt><dd>${["preview_valid", "preview_invalid", "awaiting_approval"].includes(data.healing.state) ? "Pending" : data.healing.state === "recovered" ? "Approved" : "Not reached"}</dd></div>
      <div><dt>Outcome</dt><dd>${evidence ? escapeHtml(evidence.outcome) : "In progress"}</dd></div>
    </dl>
    ${actions.length ? `<ol class="evidence-list">${actions.map((action) => `<li>${escapeHtml(action)}</li>`).join("")}</ol>` : ""}
    ${data.healing.state === "recovery_failed" ? '<div class="validation-callout danger"><strong>Recovery failed safely</strong><p>The last verified snapshot is still protected; operator intervention is required.</p></div>' : ""}
  </article>`;
}

function renderQuarantine(data: DashboardSnapshot): string {
  if (data.quarantines.data.length === 0) {
    return `<article class="empty-card compact"><h3>Quarantine is empty</h3><p>No invalid extraction is waiting for review.</p></article>`;
  }
  return data.quarantines.data
    .map(
      (entry) => `<article class="quarantine-card">
        <div><p class="eyebrow">Retained · ${formatDate(entry.observedAt)}</p><h3>Invalid output isolated</h3></div>
        <p>${entry.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .map(escapeHtml)
          .join(" · ")}</p>
        <small>Extractor ${escapeHtml(entry.extractorVersion)} · raw payload hidden from the primary view</small>
      </article>`,
    )
    .join("");
}

const inspectableStates: Array<HealingState | "stale" | "unavailable"> = [
  "healthy",
  "quarantined",
  "healing_requested",
  "awaiting_approval",
  "preview_valid",
  "preview_invalid",
  "recovered",
  "recovery_failed",
  "stale",
  "unavailable",
];

function renderFixtureInspector(data: DashboardSnapshot): string {
  if (fixtureClient === null) return "";
  return `<aside class="state-inspector" aria-label="Mock state inspector">
    <label for="inspection-state">Mock-only state inspector</label>
    <select id="inspection-state">
      ${inspectableStates.map((state) => `<option value="${state}"${state === data.healing.state ? " selected" : ""}>${escapeHtml(labelState(state))}</option>`).join("")}
    </select>
    <small>Use this only to inspect edge-state rendering. The guided buttons above exercise the actual API-shaped flow.</small>
  </aside>`;
}

function renderDashboard(data: DashboardSnapshot): void {
  const source = data.sources.data[0];
  app.innerHTML = `<header class="topbar shell">
    <a class="brand" href="/" aria-label="BidSentinel home"><span class="brand-mark" aria-hidden="true">B</span><span>BidSentinel</span></a>
    ${renderRuntime(data.runtime)}
  </header>
  <main class="shell">
    ${data.stale ? '<div class="stale-banner" role="status"><strong>Stale data:</strong> API responses are older than two minutes. Values remain visible but must not be treated as current.</div>' : ""}
    <section class="hero" aria-labelledby="page-title">
      <div><p class="eyebrow">Self-healing tender intelligence</p><h1 id="page-title">Break the scraper.<br><em>Keep the truth.</em></h1></div>
      <p>BidSentinel separates website damage from real procurement changes, preserves the last verified snapshot, and puts every repair behind evidence and human approval.</p>
    </section>
    <section class="proof-strip" aria-label="Current proof state">
      <div><span>Source</span><strong>${source ? escapeHtml(labelState(source.state)) : "Not observed"}</strong></div>
      <div><span>Verified tenders</span><strong>${data.tenders.data.length}</strong></div>
      <div><span>Quarantined</span><strong>${data.quarantines.data.length}</strong></div>
      <div><span>Amendments</span><strong>${data.changes.data.length}</strong></div>
    </section>
    <section class="flow-section" aria-labelledby="flow-title">
      <div class="section-heading"><div><p class="eyebrow">Observable safety chain</p><h2 id="flow-title">One failure. Six auditable moments.</h2></div></div>
      ${renderFlow(data)}
    </section>
    ${renderActions(data)}
    ${renderFixtureInspector(data)}
    <section class="dashboard-grid" aria-label="Operational overview">
      <div class="wide-panel"><div class="section-heading"><div><p class="eyebrow">Monitored procurement</p><h2>Verified tender state</h2></div></div>${data.tenders.data.length ? data.tenders.data.map(renderTender).join("") : '<article class="empty-card"><h3>No verified tenders</h3><p>Collect a valid baseline before BidSentinel can monitor changes.</p></article>'}</div>
      <div><div class="section-heading"><div><p class="eyebrow">Source integrity</p><h2>Health</h2></div></div>${renderSource(source, data)}</div>
      <div><div class="section-heading"><div><p class="eyebrow">Business signal</p><h2>Alerts</h2></div></div>${renderChanges(data)}</div>
      <div><div class="section-heading"><div><p class="eyebrow">Safety gate</p><h2>Quarantine</h2></div></div>${renderQuarantine(data)}</div>
      <div><div class="section-heading"><div><p class="eyebrow">Audit trail</p><h2>Recovery</h2></div></div>${renderRecovery(data)}</div>
    </section>
    <footer><span>Last refreshed ${formatDate(data.receivedAt)}</span><button class="text-button" type="button" data-action="refresh">Refresh verified state</button></footer>
  </main>`;
}

function renderUnavailable(error: unknown): void {
  const message =
    error instanceof DataClientError || error instanceof Error
      ? error.message
      : "The BidSentinel API is unavailable";
  const fixtureUrl = new URL(window.location.href);
  fixtureUrl.searchParams.set("adapter", "fixture");
  app.innerHTML = `<main class="shell"><section class="unavailable-state" role="alert">
    <p class="eyebrow">Unavailable</p><h1>The dashboard cannot verify current data.</h1>
    <p>${escapeHtml(message)}</p>
    <div class="error-actions"><button type="button" data-action="refresh">Retry API</button><a href="${escapeHtml(fixtureUrl.toString())}">Open deterministic mock demo</a></div>
    <small>No stale values are presented as live while the API is unreachable.</small>
  </section></main>`;
}

async function refresh(options: { showLoading?: boolean } = {}): Promise<void> {
  if (options.showLoading) renderLoading();
  try {
    snapshot = await client.load();
    renderDashboard(snapshot);
  } catch (error) {
    snapshot = null;
    renderUnavailable(error);
  }
}

async function runAction(action: string): Promise<void> {
  if (busyAction !== null) return;
  if (action === "refresh") {
    await refresh({ showLoading: snapshot === null });
    return;
  }
  if (action === "forget-token") {
    operatorToken = "";
    if (snapshot) renderDashboard(snapshot);
    return;
  }

  busyAction = action;
  actionError = null;
  if (snapshot) renderDashboard(snapshot);
  try {
    const options = operatorToken ? { operatorToken } : undefined;
    if (action.startsWith("collect:")) {
      await client.collect(
        action.slice("collect:".length) as CollectionMode,
        options,
      );
    } else if (action === "heal-progress") {
      await client.progressHealing(options);
    } else if (action === "validate-preview") {
      await client.validatePreview(options);
    } else if (action === "approve") {
      await client.approve(true, options);
    }
  } catch (error) {
    actionError = error instanceof Error ? error.message : String(error);
  } finally {
    busyAction = null;
  }
  await refresh();
}

app.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLElement>("[data-action]");
  const action = button?.dataset.action;
  if (action) void runAction(action);
});

app.addEventListener("input", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.id === "operator-token") {
    operatorToken = target.value;
  }
});

app.addEventListener("change", (event) => {
  const target = event.target;
  if (
    fixtureClient !== null &&
    target instanceof HTMLSelectElement &&
    target.id === "inspection-state"
  ) {
    fixtureClient.setInspectionScenario(
      target.value as HealingState | "stale" | "unavailable",
    );
    void refresh();
  }
});

renderLoading();
void refresh();
