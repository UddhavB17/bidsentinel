import { validTenderFixture } from "@bidsentinel/contracts/fixtures";

import "./style.css";

const app = document.querySelector<HTMLElement>("#app");
if (app === null) {
  throw new Error("Missing #app root");
}

const deadline = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Kolkata",
}).format(new Date(validTenderFixture.submissionDeadline));

app.innerHTML = `
  <header class="topbar">
    <a class="brand" href="/" aria-label="BidSentinel home">
      <span class="brand-mark" aria-hidden="true">B</span>
      <span>BidSentinel</span>
    </a>
    <span class="environment">Local MVP</span>
  </header>
  <section class="hero" aria-labelledby="page-title">
    <p class="eyebrow">Tender intelligence</p>
    <h1 id="page-title">Changes that should not surprise you.</h1>
    <p class="lede">
      A typed dashboard shell for monitored tenders, quarantined extraction,
      and recovery evidence.
    </p>
  </section>
  <section class="metrics" aria-label="Source status">
    <article>
      <span>Source health</span>
      <strong class="healthy">Healthy</strong>
    </article>
    <article>
      <span>Tracked tenders</span>
      <strong>1</strong>
    </article>
    <article>
      <span>Quarantined</span>
      <strong>0</strong>
    </article>
  </section>
  <section class="tenders" aria-labelledby="tenders-title">
    <div class="section-heading">
      <div>
        <p class="eyebrow">Latest observation</p>
        <h2 id="tenders-title">Monitored tender</h2>
      </div>
      <span class="status">Open</span>
    </div>
    <article class="tender-card">
      <div>
        <p class="source">${validTenderFixture.sourceId.toUpperCase()} · ${validTenderFixture.externalId}</p>
        <h3>${validTenderFixture.title}</h3>
        <p>${validTenderFixture.buyer.name}</p>
      </div>
      <dl>
        <div>
          <dt>Deadline</dt>
          <dd>${deadline}</dd>
        </div>
        <div>
          <dt>State version</dt>
          <dd>1</dd>
        </div>
      </dl>
    </article>
  </section>
`;
