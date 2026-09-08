# DevRel Article 2: OFAC Sanctions Screening via Webhooks

> **Enhanced edition:** This is an enhanced edition of the original article with an added architecture diagram and Python example; the underlying technical content is unchanged.

## Dev.to / Medium version

**Title:** Automating Real-Time OFAC Maritime Sanctions Screening Using Node.js & Webhooks

**Tags:** #compliance #nodejs #webhooks #apify #sanctions

---

### Why vessel sanctions screening is harder than it looks

OFAC's Specially Designated Nationals (SDN) list is a real, live, unauthenticated XML export — no API key needed, no CAPTCHA, no login wall. The vessel-type subset alone runs to over 1,500 entries. Screening a fleet or a set of counterparties against it sounds like a straightforward "download and grep" problem. It isn't, for one reason: **knowing when a vessel comes OFF the list is a real signal, and most naive implementations get it wrong.**

### The complete-file advantage

Unlike a paginated API where "not in this page" is ambiguous, OFAC's SDN.XML is published as one complete file per fetch. That means a previously-seen vessel's absence from a fresh, *untruncated* fetch is a trustworthy signal — the vessel was genuinely delisted, not just missed by pagination.

The "untruncated" qualifier matters. If you cap your own processing at some `maxItems` limit (to control run cost), you need to explicitly gate delisting detection on whether you actually walked the full file:

```typescript
let truncatedByMaxItems = false;
for (let i = 0; i < entries.length; i++) {
    // ... classify and push entries[i] ...
    if (recordsDelivered >= maxItems) {
        truncatedByMaxItems = i < entries.length - 1;
        break;
    }
}

// Only trust an absence as "delisted" when the walk actually completed
const delistedVessels = truncatedByMaxItems
    ? []
    : previouslySeenUids.filter((uid) => !currentUids.has(uid));
```

### Architecture: from OFAC's XML to a Slack alert

The diagram below traces the actual mechanism described in this article end to end: the SDN.XML fetch and completeness gate inside the actor, the native Apify webhook firing on a successful run, and the no-code Zapier hop that turns dataset items into a filtered Slack message.

```mermaid
sequenceDiagram
    participant OFAC as OFAC SDN.XML
    participant Actor as Apify Actor<br/>(actor-19-maritime-sanctions-monitor)
    participant DS as Apify Dataset
    participant WH as Apify Native Webhook<br/>(Event: Run succeeded)
    participant Zap as Zapier<br/>(Catch Hook → GET → Filter)
    participant Slack as Slack Channel

    Actor->>OFAC: Fetch complete SDN.XML (unauthenticated)
    OFAC-->>Actor: Full XML export

    Note over Actor: Walk entries up to maxItems.<br/>Set truncatedByMaxItems if the walk<br/>stopped before the last entry.

    alt walk completed untruncated
        Actor->>Actor: delistedVessels = previouslySeenUids<br/>minus currentUids
    else walk truncated by maxItems
        Actor->>Actor: delistedVessels = [] (absence not trustworthy)
    end

    Actor->>DS: Push classified events<br/>(SANCTION / DELISTED / STATUS_CHANGE)
    Actor->>WH: Run succeeds

    WH->>Zap: POST to Catch Hook trigger
    Zap->>DS: GET /v2/datasets/{defaultDatasetId}/items?token=...
    DS-->>Zap: Dataset items (vessel events)
    Zap->>Zap: Filter: event_type in<br/>[DELISTED, STATUS_CHANGE, SANCTION]
    Zap->>Slack: Send Channel Message
```

### Building the Node.js integration

```javascript
import { ApifyClient } from 'apify-client';

const client = new ApifyClient({ token: process.env.APIFY_TOKEN });

const run = await client.actor('stefano_seggio/actor-19-maritime-sanctions-monitor').call({
    maxItems: 500,       // set high enough to avoid truncating your real register
    onlyNew: true,
    enrichWithUnConsolidatedList: true,
});

const { items } = await client.dataset(run.defaultDatasetId).listItems();

for (const vessel of items) {
    if (vessel.event_type === 'DELISTED') {
        console.log(`DELISTED: ${vessel.vesselName} (was listed since ${vessel.lastConfirmedListedAt})`);
    } else if (vessel.event_type === 'STATUS_CHANGE') {
        console.log(`PROGRAM CHANGE: ${vessel.vesselName}`);
    } else if (vessel.event_type === 'SANCTION') {
        console.log(`NEW DESIGNATION: ${vessel.vesselName}`);
    }
}
```

### The same integration in Python

The `apify-client` Python library mirrors the Node.js client one-to-one — same actor ID, same input fields, same dataset read pattern:

```python
import os
from apify_client import ApifyClient

client = ApifyClient(os.environ["APIFY_TOKEN"])

run = client.actor("stefano_seggio/actor-19-maritime-sanctions-monitor").call(
    run_input={
        "maxItems": 500,       # set high enough to avoid truncating your real register
        "onlyNew": True,
        "enrichWithUnConsolidatedList": True,
    }
)

for vessel in client.dataset(run["defaultDatasetId"]).iterate_items():
    if vessel["event_type"] == "DELISTED":
        print(f"DELISTED: {vessel['vesselName']} (was listed since {vessel['lastConfirmedListedAt']})")
    elif vessel["event_type"] == "STATUS_CHANGE":
        print(f"PROGRAM CHANGE: {vessel['vesselName']}")
    elif vessel["event_type"] == "SANCTION":
        print(f"NEW DESIGNATION: {vessel['vesselName']}")
```

### Wiring it to a Slack alert with a webhook (no server required)

Apify Actors support native webhooks — no need to run your own listener. Console → your actor run → Integrations → Webhooks → Event: `Run succeeded`. Point the target URL at a Zapier "Webhooks by Zapier → Catch Hook" trigger, add a step to fetch the dataset items via the Apify API, filter to the event types you care about, and post to Slack. Zero infrastructure of your own to maintain:

```
Apify webhook (Run succeeded)
    → Zapier "Catch Hook" trigger
    → Zapier "GET" step: https://api.apify.com/v2/datasets/{{defaultDatasetId}}/items?token=...
    → Zapier "Filter" step: event_type in [DELISTED, STATUS_CHANGE, SANCTION]
    → Zapier "Slack: Send Channel Message" action
```

### Cross-referencing against the UN Consolidated List

The UN Security Council's Consolidated Sanctions List has no dedicated vessel record type — IMO numbers appear only inside free-text fields on individual/entity records. A useful enrichment here isn't pretending the UN list has a structured vessel type it doesn't; it's flagging when an OFAC vessel's IMO number is independently mentioned in a UN entity's designation text — real corroboration, honestly derived from what the source actually provides.

---

## Hacker News "Show HN" draft

**Title:** Show HN: Real-time OFAC vessel-sanctions delisting alerts via a Slack webhook, no server

**Submission URL:** (link to the Dev.to/Medium post above)

**First comment:**

Built this because most sanctions-screening setups only alert on new designations, not delistings — and delisting detection is only trustworthy when you know your fetch was a complete census of the register, not a partial/paginated one (OFAC's SDN.XML happens to be published as one complete file, which makes this tractable).

Wired it to Slack via Apify's native webhooks + a no-code Zapier hop — zero servers of my own. Happy to answer questions about the completeness-gating logic or the webhook wiring in the comments.
