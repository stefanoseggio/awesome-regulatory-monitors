# Apify Pay-Per-Event policy verification

Researched 2026-10-21 against current primary sources. Every fact carries a URL (or an installed-package file path) and a verbatim quote. Anything not confirmed from a primary source is marked UNVERIFIED.

Installed packages inspected (in `/home/user/awesome-regulatory-monitors/master_engines/node_modules`): `apify` 3.7.2, `apify-client` 2.25.0, `@crawlee/core` 3.18.2.

Method notes:
- `WebFetch` could not resolve `docs.apify.com` (DNS `ENOTFOUND`). Pages were fetched with `curl` through the session's configured proxy and CA bundle instead. Nothing was routed around a policy denial.
- Two lookups were blocked or failed and are not used: the Wayback Machine (connection reset) and the GitHub API (HTTP 403). No claim below depends on them.
- The Apify Console is authenticated, so Console-only validation (price bounds, form rules) could not be observed directly.

---

## 0. Premises that turned out wrong, imprecise, or unverifiable

| # | Premise in the request | Finding |
|---|---|---|
| P1 | "Store policy section 2.2.4.2 sets a 14-day advance notice for price changes" | WRONG. Section 2.2.4.2 of the current terms is "Specific Prohibitions" (no off-platform promotion, no review abuse). The 14-day rule is Section 9.4 of the same document, and the docs page "Set up Actor monetization" describes the user-facing process. If an older edition numbered it 2.2.4.2, that could not be checked (see Q3). |
| P2 | "`PUT /v2/acts/{actorId}`" | The current reference documents the path as `/v2/actors/:actorId` (the old slug `act-put` redirects to `actor-put`). `GET /v2/acts/...` and `GET /v2/actors/...` both returned HTTP 200 with identical bodies, so the alias exists. The PUT alias was not tested because that needs an owner token. The installed `apify-client` uses `resourcePath: 'actors'`. |
| P3 | "`apify-actor-start` start floor range of $0.002 - $0.01" | There is no "floor" concept. The default price is $0.00005. Apify recommends keeping the default. Raising it is allowed but buys no extra free compute. No maximum is documented. The requested range is 40x to 200x the default. It is not prohibited by any term found, and 880 of 3,386 sampled live Actors price it in that range (Section 7). It is also charged once per GB of RAM, so the real per-run cost scales with memory. |
| P4 | "`Actor.charge(...)` strictly protected by `perEventPrices` validation rules" | The SDK has no such validation. `perEventPrices` is only a field returned by `ChargingManager.getPricingInfo()`. A charge for an unregistered event name is free and is reported as successful (`chargedCount === count`). The guard must be written in application code (Q4). |
| P5 | "mandatory 14-day advance notice metadata" in the PUT body | There is no field that sets a notice period. The platform records `notifiedAboutFutureChangeAt` and `notifiedAboutChangeAt` itself. `startedAt` is the effective date. `reasonForChange` is a free-text field. The notice is given by the platform to users when a significant change is submitted (Q3). |
| P6 | Typed client can set pricing | The installed `apify-client` 2.25.0 `ActorUpdateOptions` type does not include `pricingInfos`, and its charge-event type lacks `eventTieredPricingUsd`, `isPrimaryEvent`, and `isOneTimeEvent`. Pricing must be sent as a raw HTTP PUT body, or via the client with a type cast (Q1). |
| P7 | "`Actor.charge({eventName:'apify-actor-start'})` will fail" (docs) | The docs say manual charging "will fail". In SDK 3.7.2 `Actor.charge` for an `apify-*` event does not throw and makes no API call. It silently consumes local budget accounting. `Actor.pushData(item, 'apify-...')` does throw. See Q2 and the experiment in Section 8. |
| P8 | "$0.15 ghost billing per record" | Not a platform-policy claim and not assessed here. It cannot be confirmed or refuted from platform sources. Q6 covers the policy angle only. |

---

## Q1. Request body that sets Pay-Per-Event pricing

Verdict: PARTIALLY VERIFIED. Field names are verified from the API reference, from the installed client types, and from live public Actor records. Server-side rules for a new record (which fields the server requires or overwrites, whether a past record may be resent) are not documented.

### Verified field names

Source: https://docs.apify.com/api/v2/actor-put (alias https://docs.apify.com/api/v2/act-put)

- Endpoint and merge semantics. Quote: "Updates an Actor's settings with the values specified in an Actor object passed as JSON in the POST payload. Only the fields specified in the request body are updated." (The page says POST payload, but the method is PUT. This is a typo in the reference.)
- Array and allowed models. Quote: "pricingInfos object[] The Actor's pricing records. You can't add the FLAT_PRICE_PER_MONTH or PRICE_PER_DATASET_ITEM records, because these pricing models are no longer supported."
- Record fields on a PAY_PER_EVENT item, as listed in the request schema:
  - `pricingModel` (required, "Constant value: PAY_PER_EVENT")
  - `pricingPerEvent` (required) containing `actorChargeEvents` (object keyed by event name)
  - `apifyMarginPercentage` (required in schema). Quote: "Apify's share of the revenue generated under this pricing info record, as a fraction between 0 and 1. Set by the Apify platform."
  - `createdAt` (required in schema). Quote: "When this pricing info record has been created"
  - `startedAt` (required in schema). Quote: "Since when is this pricing info record effective for a given Actor"
  - `notifiedAboutFutureChangeAt`, `notifiedAboutChangeAt` (nullable date-times, no description)
  - `reasonForChange` (nullable string, no description)
  - `isPriceChangeNotificationSuppressed` (boolean, no description)
  - `forceContainsSignificantPriceChange` (boolean, no description)
  - `minimalMaxTotalChargeUsd` (nullable number, no description in the reference)
- Per-event fields. Quote: "Definition of a single chargeable event for a pay-per-event Actor. Each event is either flat-priced (eventPriceUsd is set) or tier-priced (eventTieredPricingUsd is set); the two are mutually exclusive."
  - "eventTitle string required Human-readable title shown to users in the billing UI."
  - "eventDescription string required Human-readable description of what triggers this event."
  - "eventPriceUsd number Flat price per event in USD. Present only for non-tiered events. Mutually exclusive with eventTieredPricingUsd."
  - `eventTieredPricingUsd`: "Tiered price-per-event pricing for a single charge event, keyed by subscription tier (e.g. FREE, BRONZE, SILVER, GOLD, PLATINUM, DIAMOND)." Each entry is `{ tieredEventPriceUsd: number }` (required).
  - "isPrimaryEvent boolean Whether this event is the Actor's primary chargeable event."
  - "isOneTimeEvent boolean | null Whether this event can only be charged once per Actor run."

Minimum and maximum values: the API reference states none for `eventPriceUsd`, `startedAt`, or `minimalMaxTotalChargeUsd`. No bounds were found in the PPE docs either (UNVERIFIED whether the Console enforces any).

### Installed client types (field names as shipped)

File: `/home/user/awesome-regulatory-monitors/master_engines/node_modules/apify-client/dist/resource_clients/actor.d.ts`

- Lines 686-698, `CommonActorPricingInfo`: `apifyMarginPercentage: number; createdAt: Date; startedAt: Date; notifiedAboutFutureChangeAt?: Date; notifiedAboutChangeAt?: Date; reasonForChange?: string;`
- Lines 727-731, `ActorChargeEvent`: `eventPriceUsd: number; eventTitle: string; eventDescription?: string;`
- Lines 741-747, `PricePerEventActorPricingInfo`: `pricingModel: 'PAY_PER_EVENT'; pricingPerEvent: { actorChargeEvents: ActorChargeEvents }; minimalMaxTotalChargeUsd?: number;`
- Line 390: `export type ActorUpdateOptions = Partial<Pick<Actor, 'name' | 'description' | 'isPublic' | 'isDeprecated' | 'seoTitle' | 'seoDescription' | 'title' | 'restartOnError' | 'versions' | 'categories' | 'defaultRunOptions' | 'actorStandby' | 'actorPermissionLevel' | 'taggedBuilds'>>;` This has no `pricingInfos`.
- Runtime: `actor.js` `update(newFields)` only checks `ow.object` and forwards the object unchanged as the PUT body, so a cast works at runtime.

Discrepancies between the installed client and the reference:
- The reference marks `eventDescription` required; the installed type marks it optional.
- The installed client lacks `eventTieredPricingUsd`, `isPrimaryEvent`, `isOneTimeEvent`, `isPriceChangeNotificationSuppressed`, `forceContainsSignificantPriceChange`. The newer client docs (https://docs.apify.com/api/client/js/reference/next/interface/PayPerEventActorPricingInfo) list them as "Added in 2.11.1" on the `next` branch.

### Observed in live data but not in the reference

The public Store API (`https://api.apify.com/v2/store`) returns `currentPricingInfo` objects. Across 5,230 live PPE records these field names also appear: `isPPEPlatformUsagePaidByUser` (559 records; apparently the "Pay per event + usage" option, but no source says so), `notifiedAboutRentalToPpePriceChangeAt` (168 records). Treat both as observed only, not documented.

### What is not documented

- Whether a PUT must resend the existing `pricingInfos` history and append one record, or whether a lone new record is accepted.
- Whether the server overwrites a client-supplied `createdAt`, `startedAt`, or `apifyMarginPercentage`.
- The global error-type enum on the API pages (e.g. https://docs.apify.com/api/v2/post-charge-run) contains these identifiers, with no descriptions: `cannot-add-multiple-pricing-infos`, `cannot-add-pricing-info-that-alters-past`, `cannot-add-second-future-pricing-info`, `cannot-remove-pricing-info`, `cannot-modify-actor-pricing-too-frequently`, `cannot-modify-actor-pricing-with-immediate-effect`, `cannot-add-apify-events-to-ppe-actor`, `cannot-charge-apify-event`, `cannot-disable-one-time-event-for-apify-start-event`, `max-total-charge-usd-below-minimum`. They suggest the API enforces an append-only history, a single pending future record, and a rate limit on pricing edits, but this is inference from names only (UNVERIFIED).
- `cannot-add-apify-events-to-ppe-actor` is ambiguous. It could mean the API refuses to add `apify-*` events to an existing PPE Actor, while the docs describe adding `apify-actor-start` in the Console. Whether a PUT may add it is UNVERIFIED. Safest plan: set the start event in the Console, or test with a throwaway Actor first.

---

## Q2. The synthetic event `apify-actor-start`

Verdict: VERIFIED (what it is, default price, override, per-GB semantics). No maximum price is documented (UNVERIFIED that none exists in the Console).

Source: https://docs.apify.com/platform/actors/publishing/monetize/pay-per-event

- What it is. Quotes: "Synthetic events are predefined by Apify and charged automatically: apify-actor-start reduces the costs of starting the Actor. apify-default-dataset-item charges for each item written to the default dataset of the run." and "When enabled, Apify covers the compute cost of the first 5 seconds of every run."
- Default price. Quote: "The default price of the event is $0.00005, which equals to $0.05 per 1,000 starts. To keep your Actor competitive, Apify recommends keeping the default price."
- Override. Quotes: "You can increase the price of the event, but you won't get more free compute." and "You can delete the event, but then you will lose the free 5 seconds of compute." and "You can remove synthetic events or change their price in Apify Console."
- Per-GB semantics. Quote: "The number of events charged depends on the amount of memory allocated to the run. Up to and including 1 GB of RAM, the event is charged once. Then, it's charged once for each extra GB of memory." Examples given: "128 MB RAM: 1 event, $0.00005", "1 GB RAM: 1 event, $0.00005", "4 GB RAM: 4 events, $0.0002".
- Manual charging. Quote: "Apify automatically charges the event. Don't manually charge the event in your Actor code, as it will fail."
- Availability. Quote: "It's available by default for all new PPE Actors. For existing Actors, you can enable it in Apify Console."
- Custom start events. Quote: "Don't use both the synthetic and custom start events."
- Allowed range. No minimum or maximum is stated.

Implications for a $0.002-$0.01 start price:
- At $0.005: 1 GB costs $0.005, 4 GB costs $0.02, 8 GB costs $0.04 per run.
- `minimalMaxTotalChargeUsd` should cover the start event at the maximum memory plus one result. Quote (same page): "To prevent users from setting the maximum cost for the run too low, set the minimum value during the monetization setup. For example, you can use it to cover the price of starting the Actor and producing one result."
- Console-created records observed live carry `isOneTimeEvent: true` on `apify-actor-start` together with the title "Actor Start" and the description "Charged when the Actor starts running. Number of events charged depends on Actor memory (one event per GB, minimum one event)." How `isOneTimeEvent: true` squares with per-GB multiplicity is not documented (UNVERIFIED). Mirror the Console default when adding the event.

---

## Q3. Notice rule for price changes

Verdict: VERIFIED for the rule, the period, and who is notified. The channel through which users are notified is UNVERIFIED. The API has no field that sets the notice.

Terms (https://docs.apify.com/legal/store-publishing-terms-and-conditions, "Last updated: September 15, 2026"):
- Section 9.4. Quote: "Changes to an Actor's price that might lead to a price increase for a User, including pricing model changes you make, are limited to a maximum of 1 change per month. Any such changes shall become effective only after fourteen (14) days from the date thereof."
- Section 9.3 (tiers). Quote: "Where you set Apify Store Discount Tiers, the price at each tier must be equal to or lower than the price at the next lower tier."
- Section 2.2.4.2 (the section the request cites). Quote: "2.2.4.2. Specific Prohibitions. In addition to the Prohibited Activities, you must not: (i) Promote off-platform products or services. ... (ii) Abuse the review system." It says nothing about price changes.
- Section 11.5 concerns amendments to the terms themselves ("We shall notify you of such an amendment in advance"), not Actor price changes.
- The Standard Actor Contract (https://docs.apify.com/legal/standard-actor-contract), clause 3.2: "Creator reserves the right to update pricing in accordance with Apify Store Publishing Terms."

Docs (https://docs.apify.com/actors/monetize/set-up-monetization):
- Quote: "The following changes are considered significant: Changing the pricing model. Increasing prices. Adding a new paid event."
- Quote: "When you submit a significant change, users of your Actor are notified and the change is scheduled to take effect after 14 days. During this notice period, the current pricing remains active."
- Quote: "Once you submit a significant change, you can't cancel or modify it. To revert a planned change, contact support."
- Quote: "You can submit significant changes once per month per Actor, so plan your pricing strategy carefully. A pending change blocks submitting new ones."
- Quote: "Note that if your Actor has no paying users, the waiting period doesn't apply and the change takes effect immediately."
- Immediate changes. Quote: "The following changes take effect immediately and don't have any restrictions: Decreasing prices. Increasing prices if the Actor has no paying users. Removing events. Updating event descriptions."
- Pay per event + usage toggle: "Turning this option on takes 14 days to take effect. However, you can turn it off immediately, as it is a positive change for users." (https://docs.apify.com/platform/actors/publishing/monetize/pay-per-event)

Does the API or Console enforce the delay?
- The Console documentation says it does ("scheduled to take effect after 14 days").
- Live data supports a server-computed delay. Of 5,230 public PPE records from the Store API, 3,860 have `startedAt` equal to `createdAt` (immediate), and about 1,340 have `startedAt` 13 to 17 days after `createdAt` (1,096 at 14 days, 204 at 15). Example (`6sigmag/fast-website-content-crawler`): `createdAt` 2026-02-12T15:39:20.326Z, `startedAt` 2026-02-26T15:39:19.815Z, `notifiedAboutFutureChangeAt` 2026-02-12T15:39:44.948Z.
- Whether a PUT with an earlier client-supplied `startedAt` is rejected is not documented (UNVERIFIED). The error identifier `cannot-modify-actor-pricing-with-immediate-effect` hints at server enforcement.

Metadata fields:
- `notifiedAboutFutureChangeAt`: stamped by the platform shortly after submission (about 20 seconds after `createdAt` in the examples).
- `notifiedAboutChangeAt`: stamped after the change takes effect (about 6 minutes after `startedAt` in the xtech example).
- `reasonForChange`: free text, visible in live records (for example "We're migrating to Apify's pay-per-event pricing...").
- `isPriceChangeNotificationSuppressed` and `forceContainsSignificantPriceChange` have no documented semantics. Do not set them to avoid or force a notice.

A blog post confirms the commercial effect (https://blog.apify.com/migrating-to-pay-per-event-pricing/): "lowering a price later is instant, but raising one needs 14 days' notice and can only happen once a month."

What this means for the master engines:
- A brand-new Actor with no paying users takes its initial pricing immediately.
- Any Actor that already has paying users needs 14 days for the start-price increase to $0.002-$0.01, the new `watchlist-hit` paid event, or a pricing-model change, and only one such change per month is allowed.

---

## Q4. `Actor.charge()` for an event not defined in the pricing

Verdict: VERIFIED from installed source and an executed experiment. An unregistered event is free and is still reported as charged.

Source: `/home/user/awesome-regulatory-monitors/master_engines/node_modules/apify/dist/charging.js` (apify 3.7.2)
- Lines 351-361. Quote: "How many events of a given type can still be charged for before reaching the limit; If the event is not registered, returns Infinity (free of charge)". The function returns `Infinity` when `calculateEventPrice(eventName)` is falsy.
- Lines 279-282. Quote: `const pricingInfo = this.pricingInfo[eventName] ?? { price: this.isAtHome ? 0 : 1, // Use a nonzero price for local development so that the maximum budget can be reached title: \`Unknown event '${eventName}'\`, };`
- Lines 291-299. Quote: "if (eventName.startsWith('apify-')) { // Synthetic events (e.g. apify-default-dataset-item) are tracked locally only, the platform handles them automatically based on dataset writes. } else if (this.pricingInfo[eventName] !== undefined) { await this.apifyClient.run(this.actorRunId).charge({ eventName, count: chargedCount }); } else { log_1.default.warning(\`Attempting to charge for an unknown event '${eventName}'\`); }"

The same sentence appears in the published SDK docs: https://docs.apify.com/sdk/js/reference/class/ChargingManager ("If the event is not registered, returns Infinity (free of charge)").

Effects (confirmed by the experiment in Section 8):
- On the platform, a charge for an unknown name makes no API call, logs a warning, and returns `chargedCount` equal to the requested `count`. The result looks like a success while nothing is billed.
- Outside the platform (local runs without `ACTOR_TEST_PAY_PER_EVENT`), every event is priced at $1 and unknown events default to $1 as well.
- The REST endpoint behaves differently if called directly. Source: https://docs.apify.com/api/v2/post-charge-run. Quote: "The event you are charging for must be one of the configured events in your Actor. If the Actor is not set up as pay per event, or if the event is not configured, the endpoint will return an error." The `apify-client` d.ts agrees: "Name of the event to charge. Must be defined in the Actor's pricing info else the API will throw."
- Also from that page: "The key expires 3 minutes after the charge, so a later request with the same key creates a new charge." The SDK handles idempotency keys.

Guard to implement in application code (SDK offers none): read `Actor.getChargingManager().getPricingInfo().perEventPrices`, confirm `perEventPrices['watchlist-hit']` is a number greater than 0, and refuse to proceed (or skip charging and log loudly) otherwise. `getPricingInfo()` is also where `isPayPerEvent` lives; `charge()` on a non-PPE Actor logs "Ignored attempt to charge for an event - the Actor does not use the pay-per-event pricing" and returns `chargedCount: 0`.

---

## Q5. `apify-default-dataset-item` and `pushData(item, eventName)`

Verdict: VERIFIED. When both events are priced, a call to `pushData(item, 'watchlist-hit')` bills both events per item.

Docs (https://docs.apify.com/platform/actors/publishing/monetize/pay-per-event):
- Quote: "It automatically charges users for each item that your Actor writes to the default dataset. For example, when using Actor.pushData()."
- Quote: "It applies only to the default dataset of the run."
- Quote: "It's enabled by default, you don't need to add extra charging code to your Actor."
- Quote: "To stop charging for default dataset items automatically, remove this event from your Actor in Apify Console."
- SDK docs (https://docs.apify.com/sdk/js/docs/concepts/pay-per-event): "// Shortcut for charging for each pushed dataset item await Actor.pushData(result, 'result-item');"
- Guidance against stacking charges. Quotes: "Avoid cases where producing a single result triggers too many events. It makes your Actor more expensive." and "Don't charge users for actions they don't see."

Installed source, `charging.js`:
- Lines 389-391 (`calculatePushDataLimits`): the per-item price is the sum of `calculateEventPrice(eventName)` and, when the dataset is the default one, `calculateEventPrice('apify-default-dataset-item')`.
- Lines 407-412: `eventsToCharge[eventName] = itemsToKeep;` and, for the default dataset, `eventsToCharge['apify-default-dataset-item'] = itemsToKeep;`
- `patched_apify_client.js` only intercepts writes when `'apify-default-dataset-item'` is among `perEventPrices`. `actor.js` lines 667-668 reject a manual synthetic event name in `pushData`: "Cannot charge for synthetic event '${eventName}' manually".

How to avoid double billing (choose one per item class):
1. Remove `apify-default-dataset-item` from the pricing and bill only through explicit events (`pushData(item, 'watchlist-hit')`).
2. Keep `apify-default-dataset-item` as the result price, never pass an `eventName` for the same item, and do not also call `Actor.charge` for it.
3. If the hit must be billed under its own event while the dataset write must stay free, leave `apify-default-dataset-item` out of the pricing, or write non-billable records to a named (non-default) dataset with `Dataset.pushData`, which is not charged by `Actor.pushData`.
4. Do not compare `chargedCount` with the number of items when both events are priced: the aggregated result sums events, so 3 items return `chargedCount` 6 (Section 8, case A).
5. Charge only after the item is stored. Quote: "Charge for results after they're saved and available for users. Don't bill users for what they can't access, for example if a run gets aborted."

Observed in the wild: 546 of 5,230 sampled live PPE Actors define both `apify-default-dataset-item` and at least one custom event, so the combination is accepted by the platform. Whether those Actors double-bill on purpose is not knowable from the data.

---

## Q6. Anything in the terms that makes these prices or events non-compliant

Verdict: NO HARD PROHIBITION FOUND for a start-event price of $0.002-$0.01 or for a custom `watchlist-hit` event. Several recommendations and one structural rule apply.

Searched documents: Store Publishing Terms, Acceptable Use Policy (https://docs.apify.com/legal/acceptable-use-policy), Actor Terms (https://docs.apify.com/legal/actor-terms-and-conditions), Standard Actor Contract, the monetization docs pages, and the quality score page (https://docs.apify.com/actors/publishing/quality-score).

Rules and recommendations that matter:
- Start price: only a recommendation. "To keep your Actor competitive, Apify recommends keeping the default price." No maximum.
- Empty results: no term addresses charging for empty results. Docs best practice: "Don't charge users for actions they don't see. For Actors that produce data, events should map to concrete results in the user's dataset or storage." The blog says the start event "cushions you against empty runs that fail on input validation." Charging a hit event with no delivered item would contradict the best practice (not a hard term).
- Event titles: no wording rule. The API says `eventTitle` is "Human-readable title shown to users in the billing UI." The Console defaults are "Actor Start" and "result". Misleading text could fall under Section 2.2.4.3 ("otherwise unlawful, offensive, harmful, or misleading"), which allows unpublishing "without prior notice".
- Tier monotonicity (Section 9.3): higher tiers must be equal to or lower than lower tiers. Applies if `eventTieredPricingUsd` is used.
- Price-change cadence (Section 9.4): max 1 increase-type change per month, effective after 14 days. See Q3.
- FREE tier: "Don't set excessively high prices for FREE tier users. It prevents them from testing your Actor on enough data to see its value. A higher price makes sense only to protect your Actor from fraudulent activity or to cover third-party costs, such as LLM API calls." (https://docs.apify.com/platform/actors/publishing/monetize/pricing-and-costs). Section 5.1 backs this: "You must ensure that your pricing accounts for any such third-party costs you incur."
- Free users: "If a free user hits a limit, don't crash the Actor or return a system error. Instead, exit gracefully with a clear status message" (https://docs.apify.com/platform/actors/publishing/monetize).
- Primary event: "You must define the primary event when setting up monetization for your Actor."
- Quality score (https://docs.apify.com/actors/publishing/quality-score) mentions pricing transparency and tier discounts. No numeric rule on start price.
- AUP: "any fraudulent or deceptive behavior" is prohibited. Billing a user for items they never receive could be read as deceptive. This is an interpretation, not a stated rule.
- Per-run budget: the user's limit is per run. "Once it's reached, Actor.charge() stop charging and Actor.pushData() stops pushing data over the limit." Respect `eventChargeLimitReached`.
- Charging order and abort handling: "Charge for work as soon as it's done, not in a large batch at the end."
- Agentic payments eligibility (optional): requires PPE only, no "Pay per event + usage", limited permissions, no Standby, and a KYC-verified developer.

---

## 7. Live Store sample (empirical, not authoritative)

Method: paged `GET https://api.apify.com/v2/store?limit=500&offset=...&pricingModel=PAY_PER_EVENT` (public, unauthenticated). 5,230 unique PPE records came back out of roughly 85,000 Store Actors. The pagination totals fluctuate between pages, so this is a sample, not a census.

- 3,386 of 5,230 have an `apify-actor-start` event.
- Its price ranges from $0.00001 to $24.50, median $0.0005. 1,503 sit at the default $0.00005.
- 880 are inside $0.002-$0.01. 581 are above $0.01.
- 515 use tiered pricing for the start event.
- Titles are almost always the Console default "Actor Start".
- Conclusion: the platform accepts start prices far above the default. That is evidence of no hard cap in the Console or API, not evidence of Store approval or ranking effects.

## 8. SDK behavior experiment (stubbed `ChargingManager`)

A script (`/tmp/claude-0/-home-user-awesome-regulatory-monitors/8d169142-af03-595a-9ef1-d57b13c700fb/scratchpad/sdkcheck/check.cjs`) loaded the installed `charging.js` with a fake configuration (`isAtHome: true`, a $5 budget) and a fake client that records `run().charge()` calls. Pricing: `apify-actor-start` $0.005, `apify-default-dataset-item` $0.001, `watchlist-hit` $0.15.

| Case | Action | Result |
|---|---|---|
| A | `pushDataAndCharge` 3 items, `eventName: 'watchlist-hit'`, default dataset, both events priced | `eventsToCharge` was `{"watchlist-hit":3,"apify-default-dataset-item":3}`. Client calls: `watchlist-hit` x3 (the synthetic event is left to the platform). `chargedCount` returned 6. |
| B | `charge({eventName: 'watchlist_hit', count: 2})` (typo) | WARN "Attempting to charge for an unknown event". `chargedCount` 2. Zero API calls. |
| C | `charge('watchlist-hit')` with that event absent from pricing | Same as B. `perEventPrices` lacked the event. |
| D | `charge({eventName: 'apify-actor-start'})` manually | No error, no API call, but local budget accounting dropped (`chargeableWithinLimit` 1000 to 999). |
| E | Same push as A with `apify-default-dataset-item` unpriced | `eventsToCharge` still lists both names, but the unpriced one costs nothing. |

---

## 9. Recommended PUT body shape (verified field names only)

Endpoint: `PUT https://api.apify.com/v2/actors/{actorId}` (the `acts` alias exists for GET). Use `Authorization: Bearer <token>` and `Content-Type: application/json`.

```json
{
  "pricingInfos": [
    {
      "pricingModel": "PAY_PER_EVENT",
      "pricingPerEvent": {
        "actorChargeEvents": {
          "apify-actor-start": {
            "eventTitle": "Actor Start",
            "eventDescription": "Charged when the Actor starts running. Number of events charged depends on Actor memory (one event per GB, minimum one event).",
            "isOneTimeEvent": true,
            "eventPriceUsd": 0.005
          },
          "watchlist-hit": {
            "eventTitle": "Watchlist hit",
            "eventDescription": "Charged once for each delivered record that matches a watchlist keyword.",
            "isOneTimeEvent": false,
            "isPrimaryEvent": true,
            "eventPriceUsd": 0.05
          }
        }
      },
      "minimalMaxTotalChargeUsd": 0.1,
      "apifyMarginPercentage": 0.2,
      "createdAt": "<ISO-8601 now>",
      "startedAt": "<ISO-8601: now if the Actor has no paying users, otherwise now + 14 days>",
      "reasonForChange": "<plain-language reason shown with the change>"
    }
  ]
}
```

Usage notes:
- Prices shown ($0.005 start, $0.05 hit, $0.10 minimum) are placeholders, not recommendations.
- Do not include `notifiedAboutFutureChangeAt`, `notifiedAboutChangeAt`, `isPriceChangeNotificationSuppressed`, or `forceContainsSignificantPriceChange`.
- `apifyMarginPercentage`, `createdAt`, and `startedAt` are marked required in the shared schema. Whether the server needs them from the client, overwrites them, or rejects a body without them is UNVERIFIED. Test on a throwaway private Actor.
- If the Actor already has pricing history, GET it first (as owner) and keep the existing records in `pricingInfos` unless a test shows a lone record is accepted. The append-only behavior is inferred from error identifiers only.
- `apify-default-dataset-item` is omitted on purpose so `pushData(item, 'watchlist-hit')` bills one event per item. Add it back only if the per-item dataset charge is wanted and the code never passes an event name for the same item.
- Never call `Actor.charge({ eventName: 'apify-actor-start' })`.

---

## 10. UNVERIFIED list

1. Any minimum or maximum for `eventPriceUsd`, `minimalMaxTotalChargeUsd`, or the start event in the Console (none documented; live data shows $0.00001 to $24.50).
2. Whether the PUT API honors or rejects a client-supplied `startedAt` earlier than 14 days when the Actor has paying users.
3. Which fields a PUT must contain for a new record, and whether history must be resent.
4. Whether the PUT API can add `apify-actor-start` to an existing PPE Actor (an error identifier with a similar name exists).
5. How users are notified of a significant change (channel, content). Only "users of your Actor are notified" is documented.
6. Semantics of `isPriceChangeNotificationSuppressed`, `forceContainsSignificantPriceChange`, and `isOneTimeEvent: true` on the per-GB start event.
7. Whether an earlier edition of the Store terms numbered the price-change clause 2.2.4.2 (the Wayback lookup failed).
8. Whether `PUT /v2/acts/{id}` (the `acts` alias) is accepted for writes. GET works on both paths.
9. Any quality-score or ranking penalty for a start price above the default.
10. The "$0.15 ghost billing" claim (out of scope).

## 11. Sources

- https://docs.apify.com/api/v2/actor-put (alias https://docs.apify.com/api/v2/act-put)
- https://docs.apify.com/api/v2/actor-get
- https://docs.apify.com/api/v2/post-charge-run
- https://docs.apify.com/platform/actors/publishing/monetize/pay-per-event
- https://docs.apify.com/platform/actors/publishing/monetize/pricing-and-costs
- https://docs.apify.com/platform/actors/publishing/monetize
- https://docs.apify.com/actors/monetize/set-up-monetization
- https://docs.apify.com/legal/store-publishing-terms-and-conditions (last updated September 15, 2026)
- https://docs.apify.com/legal/standard-actor-contract
- https://docs.apify.com/legal/acceptable-use-policy
- https://docs.apify.com/legal/actor-terms-and-conditions
- https://docs.apify.com/actors/publishing/quality-score
- https://docs.apify.com/sdk/js/docs/concepts/pay-per-event
- https://docs.apify.com/sdk/js/reference/class/ChargingManager
- https://docs.apify.com/api/client/js/reference/next/interface/PayPerEventActorPricingInfo
- https://docs.apify.com/api/client/js/reference/next/interface/ActorChargeEvent
- https://blog.apify.com/migrating-to-pay-per-event-pricing/
- https://api.apify.com/v2/store (public live records)
- `/home/user/awesome-regulatory-monitors/master_engines/node_modules/apify/dist/charging.js`
- `/home/user/awesome-regulatory-monitors/master_engines/node_modules/apify/dist/actor.js`
- `/home/user/awesome-regulatory-monitors/master_engines/node_modules/apify/dist/patched_apify_client.js`
- `/home/user/awesome-regulatory-monitors/master_engines/node_modules/apify-client/dist/resource_clients/actor.d.ts`
- `/home/user/awesome-regulatory-monitors/master_engines/node_modules/apify-client/dist/resource_clients/run.d.ts`
