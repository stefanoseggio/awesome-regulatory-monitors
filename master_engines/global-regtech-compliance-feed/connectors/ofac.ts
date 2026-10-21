/**
 * ofac.ts - OFAC Specially Designated Nationals (SDN) vessel connector.
 *
 * Absorbs `actor-19-maritime-sanctions-monitor` (fetch + parse + normalise +
 * UN cross-reference). `delta-registry-ofac-sanctions-stub` (a one-off Python
 * sample puller, vessel-only, 20 records, same endpoint, same parse rules) adds
 * nothing beyond what is ported here; its README only documents intent.
 *
 * SCOPE (inherited from the legacy actor, deliberately unchanged): sdnType =
 * "Vessel" entries only. Individual / Entity / Aircraft SDN designations are NOT
 * emitted - the legacy actor never parsed them, so there is no legacy field
 * vocabulary to preserve for them and no verified normalisation to port.
 *
 * ============================================================================
 * LIVE SOURCE VERIFICATION
 * ============================================================================
 * Original verification (legacy src/http.ts, 2026-09-07), kept because it is the
 * evidence for the endpoints and for the sources that were REJECTED:
 *
 * 1. VERIFIED OPEN - PRIMARY SOURCE:
 *    US Treasury OFAC SDN List
 *      https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML
 *    A bare unauthenticated GET (no cookies, no API key) returns HTTP 302 to a
 *    time-limited pre-signed S3 URL (wc2h-sls-prod-public-published.s3.us-gov-west-1
 *    .amazonaws.com) which returns HTTP 200 text/xml. No CAPTCHA, no WAF challenge,
 *    no session. robots.txt on sanctionslistservice.ofac.treas.gov is a bare 404.
 *    Per-vessel human-readable permalink (verified live, resolves to the record):
 *    https://sanctionssearch.ofac.treas.gov/Details.aspx?id=<uid>
 *
 * 2. VERIFIED OPEN - ENRICHMENT SOURCE:
 *    UN Security Council Consolidated Sanctions List
 *      https://scsanctions.un.org/resources/xml/en/consolidated.xml
 *    302 to a pre-signed Azure Blob URL, then 200 XML. The list has NO vessel
 *    record type and NO structured IMO field: IMO numbers appear only inside the
 *    free-text <COMMENTS1> of ENTITY/INDIVIDUAL records. It is used ONLY as an
 *    IMO cross-reference, never to fabricate a structured UN vessel record.
 *
 * 3. VERIFIED GATED - REJECTED (not ported, not selectable):
 *    Paris MoU / Tokyo MoU port-state-control data: Paris MoU proxies to EMSA
 *    THETIS (Keycloak OpenID Connect login wall); Tokyo MoU's APCIS public search
 *    form contains <input name="captcha">. IMO GISIS: robots.txt disallows
 *    /Members/, /Secretariat/, /WebServices/ and its Public module is
 *    session/registration-gated. No CAPTCHA solving, no login bypass.
 *
 * Re-verified in THIS port session (2026-10-21, plain curl through the sandbox
 * egress proxy, recorded here rather than assumed):
 *    SDN.XML  -> 302 (pre-signed S3 URL) -> 200 Content-Type: text/xml,
 *                29,231,187 bytes, <Publish_Date>10/15/2026</Publish_Date>,
 *                <Record_Count>19457</Record_Count>, exactly 19,457 <sdnEntry>
 *                elements (declared == actual), of which 1,559 are
 *                <sdnType>Vessel</sdnType>; 334 vessels carry >1 program.
 *    UN list  -> 302 -> 200 application/xml, 2,185,376 bytes, 274 <ENTITY> and
 *                736 <INDIVIDUAL> records, IMO sentences still present as
 *                free text ("International Maritime Organization (IMO) Number:
 *                1790183.", "IMO number: 5571322").
 *    End to end: the connector, driven through lib/http.ts createHttpClient (Node's
 *    global fetch, honest User-Agent, redirects followed) against both live hosts,
 *    returned vessel records in ~11 s (both downloads + both parses).
 *    Two structural observations the port preserves rather than "fixes":
 *      - 5 of 1,559 vessels have a "Vessel Registration Identification" idNumber
 *        that is not "IMO <7 digits>": two bare 7-digit numbers (uid 17104
 *        "8606173", uid 33809 "9894387"), one 5-digit number (uid 23424 "15411")
 *        and two national-registry strings (uid 37479 "RS 150443", uid 37482
 *        "RS 130280"). The legacy parser only accepts "IMO <7 digits>" as an IMO
 *        and files everything else under otherIds; that behaviour is kept (a bare
 *        7-digit number is not provably an IMO) so the legacy field semantics do
 *        not shift under consumers.
 *      - remarks may carry several "Linked To:" clauses (uid 15055 has two); the
 *        legacy `linkedTo` field keeps the first only. The watch text below reads
 *        all of them.
 *
 * RESOURCE NOTE: the legacy actor runs this parse at 1-4 GB of memory because
 * the 29 MB XML is loaded into a full cheerio DOM. This connector keeps that
 * parser, so the hosting Actor's memory setting must be >= 1024 MB.
 * ============================================================================
 *
 * The router owns delta memory, so the legacy event_type classification
 * (SANCTION / STATUS_CHANGE / UPDATED / SNAPSHOT_NO_DIFF / DELISTED) and the
 * truncation/DELISTED bookkeeping are not ported; the router's `delta_status`
 * (first_seen / updated / unchanged) replaces them.
 */
import * as cheerio from 'cheerio';
import { z } from 'zod';

import { describeSanitization, findKeywordMatch, type SanitizedKeywordList, sanitizeKeywordList } from '../../lib/_guards.js';
import { fingerprintOf } from '../../lib/connector_helpers.js';
import { type Connector, type ConnectorContext, type RunParams, SourceFetchError, type SourceRecord } from '../../lib/types.js';

export const OFAC_SDN_XML_URL = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML';
export const UN_CONSOLIDATED_XML_URL = 'https://scsanctions.un.org/resources/xml/en/consolidated.xml';
export const OFAC_DETAILS_BASE_URL = 'https://sanctionssearch.ofac.treas.gov/Details.aspx';

/** The SDN.XML download is ~29 MB; the shared client's 30 s default is too tight for a slow link. */
const FEED_TIMEOUT_MS = 180_000;

/**
 * A complete SDN.XML always has <Record_Count> equal to the number of <sdnEntry>
 * elements (verified live 2026-10-21: 19457 == 19457). Below this fraction of the
 * declared count the document is treated as truncated/malformed rather than
 * delivered as if it were a complete census.
 */
const STRUCTURAL_COMPLETENESS_RATIO = 0.99;

// ---------------------------------------------------------------------------
// Types (field names are the legacy actor's, unchanged)
// ---------------------------------------------------------------------------

export interface AkaName {
    type: string | null;
    category: string | null;
    name: string;
}

export interface OtherId {
    idType: string;
    idNumber: string;
}

export interface UnConsolidatedListMatch {
    dataId: string;
    name: string;
    referenceNumber: string | null;
    listedOn: string | null;
}

/** One <sdnEntry> from the OFAC SDN.XML feed with sdnType=Vessel, parsed into a typed shape. */
export interface OfacVesselEntry {
    uid: string;
    vesselName: string;
    sdnType: 'Vessel';
    programs: string[];
    remarks: string | null;
    linkedTo: string | null;
    akaNames: AkaName[];
    imoNumber: string | null;
    mmsi: string | null;
    otherIds: OtherId[];
    callSign: string | null;
    vesselType: string | null;
    vesselFlag: string | null;
    tonnage: string | null;
    grossRegisteredTonnage: string | null;
    vesselOwner: string | null;
    /** The SDN list's own <Publish_Date> (MM/DD/YYYY), one value shared by every entry parsed from the same feed fetch. */
    listPublishDateRaw: string;
}

export interface ParsedSdnFeed {
    entries: OfacVesselEntry[];
    publishDateRaw: string;
    /** Every <sdnEntry> element of ANY sdnType - the stable number the completeness guard compares against the declared count. */
    totalEntryCount: number;
    /** The feed's own <publshInformation><Record_Count>, or null when absent (never the case in a genuine fetch). */
    declaredRecordCount: number | null;
}

// ---------------------------------------------------------------------------
// SDN.XML parser (port of legacy src/parseSdnXml.ts)
// ---------------------------------------------------------------------------

/** Matches "IMO 9187629", "IMO  8730455" (double space seen in the live feed), case-insensitive. IMO ship numbers are always exactly 7 digits. */
const IMO_PATTERN = /IMO\s*(\d{7})\b/i;
/** Matches a "(Linked To: X)" or "Linked To: X;" clause inside OFAC's free-text remarks. */
const LINKED_TO_PATTERN = /Linked To:\s*([^);]+)/i;
const LINKED_TO_PATTERN_ALL = /Linked To:\s*([^);]+)/gi;

function textOrNull(value: string | undefined | null): string | null {
    const trimmed = (value ?? '').trim();
    return trimmed.length > 0 ? trimmed : null;
}

/**
 * Every "Linked To: X" clause of a remarks string, in order, de-duplicated. The
 * legacy `linkedTo` field keeps only the first; screening needs all of them
 * (live uid 15055 carries "Linked To: NATIONAL IRANIAN TANKER COMPANY; Linked To:
 * HOKOUL SAL OFFSHORE").
 */
export function extractAllLinkedTo(remarks: string | null): string[] {
    if (!remarks) return [];
    const out: string[] = [];
    for (const match of remarks.matchAll(LINKED_TO_PATTERN_ALL)) {
        const name = textOrNull(match[1]);
        if (name !== null && !out.includes(name)) out.push(name);
    }
    return out;
}

/**
 * Parses one raw OFAC SDN.XML document into typed vessel entries, filtering out
 * every non-vessel sdnType (Individual, Entity, Aircraft).
 *
 * Also surfaces two structural signals used by the completeness guard in
 * {@link assertCompleteSdnFeed}, independent of how many Vessel entries came out:
 * `totalEntryCount` (every <sdnEntry>) and `declaredRecordCount` (the feed's own
 * Record_Count).
 *
 * Uses cheerio in xmlMode - the document's default xmlns is unprefixed, so plain
 * tag-name selectors (`sdnEntry`, `uid` and so on) match.
 */
export function parseSdnXml(xml: string): ParsedSdnFeed {
    const $ = cheerio.load(xml, { xmlMode: true });

    const publishDateRaw = textOrNull($('publshInformation Publish_Date').first().text()) ?? '';
    const recordCountRaw = textOrNull($('publshInformation Record_Count').first().text());
    const declaredRecordCount = recordCountRaw !== null && /^\d+$/.test(recordCountRaw) ? Number(recordCountRaw) : null;

    const entries: OfacVesselEntry[] = [];
    let totalEntryCount = 0;

    $('sdnEntry').each((_index, element) => {
        totalEntryCount += 1;
        const $entry = $(element);
        const sdnType = textOrNull($entry.children('sdnType').first().text());
        if (!sdnType || sdnType.toLowerCase() !== 'vessel') return;

        const uid = textOrNull($entry.children('uid').first().text());
        const vesselName = textOrNull($entry.children('lastName').first().text());
        if (!uid || !vesselName) return;

        const programs: string[] = [];
        $entry.find('programList > program').each((_i, programEl) => {
            const program = textOrNull($(programEl).text());
            if (program) programs.push(program);
        });

        const remarks = textOrNull($entry.children('remarks').first().text());
        const linkedToMatch = remarks ? remarks.match(LINKED_TO_PATTERN) : null;
        const linkedTo = linkedToMatch ? textOrNull(linkedToMatch[1]) : null;

        const akaNames: AkaName[] = [];
        $entry.find('akaList > aka').each((_i, akaEl) => {
            const $aka = $(akaEl);
            const name = textOrNull($aka.children('lastName').first().text());
            if (!name) return;
            akaNames.push({
                type: textOrNull($aka.children('type').first().text()),
                category: textOrNull($aka.children('category').first().text()),
                name,
            });
        });

        let imoNumber: string | null = null;
        let mmsi: string | null = null;
        const otherIds: OtherId[] = [];
        $entry.find('idList > id').each((_i, idEl) => {
            const $id = $(idEl);
            const idType = textOrNull($id.children('idType').first().text());
            const idNumber = textOrNull($id.children('idNumber').first().text());
            if (!idType || !idNumber) return;

            if (idType === 'Vessel Registration Identification') {
                const match = idNumber.match(IMO_PATTERN);
                if (match?.[1]) {
                    imoNumber = match[1];
                    return;
                }
                // A "Vessel Registration Identification" entry that is NOT an
                // "IMO <7 digits>" string (real, verified: some vessels carry a bare
                // number or a national registry number here). Keep it as a generic
                // identifier rather than discarding it or mislabelling it as an IMO.
                otherIds.push({ idType, idNumber });
                return;
            }
            if (idType === 'MMSI') {
                mmsi = idNumber;
                return;
            }
            otherIds.push({ idType, idNumber });
        });

        const vesselInfo = $entry.children('vesselInfo').first();
        const callSign = textOrNull(vesselInfo.children('callSign').first().text());
        const vesselType = textOrNull(vesselInfo.children('vesselType').first().text());
        const vesselFlag = textOrNull(vesselInfo.children('vesselFlag').first().text());
        const tonnage = textOrNull(vesselInfo.children('tonnage').first().text());
        const grossRegisteredTonnage = textOrNull(vesselInfo.children('grossRegisteredTonnage').first().text());
        const vesselOwner = textOrNull(vesselInfo.children('vesselOwner').first().text());

        entries.push({
            uid,
            vesselName,
            sdnType: 'Vessel',
            programs,
            remarks,
            linkedTo,
            akaNames,
            imoNumber,
            mmsi,
            otherIds,
            callSign,
            vesselType,
            vesselFlag,
            tonnage,
            grossRegisteredTonnage,
            vesselOwner,
            listPublishDateRaw: publishDateRaw,
        });
    });

    return { entries, publishDateRaw, totalEntryCount, declaredRecordCount };
}

/**
 * Refuses a document that is not a complete SDN.XML. A bot-check page, a redirect
 * target or a body cut off mid-download is HTTP 200 and parses to zero or too few
 * entries - indistinguishable from "OFAC has no vessels" unless the document's own
 * metadata is checked. Throwing here keeps the router from treating an empty or
 * partial read as a genuine census.
 */
export function assertCompleteSdnFeed(feed: ParsedSdnFeed): void {
    if (feed.declaredRecordCount === null) {
        throw new SourceFetchError(
            `OFAC SDN.XML response has no <Record_Count> (found ${feed.totalEntryCount} <sdnEntry> element(s)); not a genuine SDN feed - refusing to treat it as an empty list.`,
            'ofac',
        );
    }
    if (feed.totalEntryCount < feed.declaredRecordCount * STRUCTURAL_COMPLETENESS_RATIO) {
        throw new SourceFetchError(
            `OFAC SDN.XML looks truncated: declared Record_Count=${feed.declaredRecordCount} but only ${feed.totalEntryCount} <sdnEntry> element(s) were parsed; refusing to deliver a partial list as complete.`,
            'ofac',
        );
    }
}

// ---------------------------------------------------------------------------
// UN Consolidated List IMO index (port of legacy src/unConsolidatedList.ts)
// ---------------------------------------------------------------------------

/**
 * The UN list has NO structured IMO field. Every IMO number appears only inside the
 * free-text <COMMENTS1> of an <ENTITY> or <INDIVIDUAL> record, in prose such as
 * "International Maritime Organization (IMO) Number: 1790183." or "IMO Number:
 * 5342883." The index is scoped per record (not a flat whole-document scan, which
 * could attribute an IMO number to the wrong neighbouring entity).
 */
const IMO_IN_TEXT_PATTERN = /IMO[^0-9]{0,40}?(\d{7})\b/gi;

/** Builds a Map from 7-digit IMO number to every UN ENTITY/INDIVIDUAL record whose COMMENTS1 text mentions it. */
export function buildUnImoIndex(xml: string): Map<string, UnConsolidatedListMatch[]> {
    const $ = cheerio.load(xml, { xmlMode: true });
    const index = new Map<string, UnConsolidatedListMatch[]>();

    $('ENTITY, INDIVIDUAL').each((_index, element) => {
        const $record = $(element);
        const dataId = textOrNull($record.children('DATAID').first().text());
        const comments = $record.children('COMMENTS1').first().text() ?? '';
        if (!dataId || !comments) return;

        const matches = [...comments.matchAll(IMO_IN_TEXT_PATTERN)];
        if (matches.length === 0) return;

        const firstName = textOrNull($record.children('FIRST_NAME').first().text());
        const secondName = textOrNull($record.children('SECOND_NAME').first().text());
        const name = [firstName, secondName].filter((part): part is string => part !== null).join(' ') || 'UNKNOWN';
        const referenceNumber = textOrNull($record.children('REFERENCE_NUMBER').first().text());
        const listedOn = textOrNull($record.children('LISTED_ON').first().text());

        const record: UnConsolidatedListMatch = { dataId, name, referenceNumber, listedOn };

        for (const match of matches) {
            const imoNumber = match[1];
            if (!imoNumber) continue;
            const existing = index.get(imoNumber);
            if (existing) {
                // One record can mention the same IMO twice; list it once.
                if (!existing.some((m) => m.dataId === record.dataId)) existing.push(record);
            } else {
                index.set(imoNumber, [record]);
            }
        }
    });

    return index;
}

/** Looks up an OFAC-extracted IMO number in the pre-built UN index. Returns an empty array (never null/undefined) when there is no match. */
export function lookupUnMatches(imoNumber: string | null, index: Map<string, UnConsolidatedListMatch[]>): UnConsolidatedListMatch[] {
    if (!imoNumber) return [];
    return index.get(imoNumber) ?? [];
}

// ---------------------------------------------------------------------------
// Filters (legacy programFilter / vesselNameContains, now behind the keyword guard)
// ---------------------------------------------------------------------------

/**
 * Both filters are keyword lists, so both go through sanitizeKeywordList(): a blank,
 * one-character or punctuation-only needle is dropped instead of matching every
 * vessel (the legacy `includes("")` hazard), and an empty sanitised list means "no
 * filtering requested" - never "match everything" by accident of a vacuous test.
 */
export function matchesProgramFilter(programs: readonly string[], list: SanitizedKeywordList): boolean {
    if (list.needles.length === 0) return true;
    return programs.some((program) => findKeywordMatch(program, list) !== null);
}

export function matchesNameFilter(vesselName: string, list: SanitizedKeywordList): boolean {
    if (list.needles.length === 0) return true;
    return findKeywordMatch(vesselName, list) !== null;
}

function resolveKeywordFilter(ctx: ConnectorContext, fieldName: string, input: unknown): SanitizedKeywordList {
    const list = sanitizeKeywordList(input);
    if (list.keywords.length > 0) {
        ctx.log.info(`[ofac] ${describeSanitization(list, fieldName)}`);
    } else if (list.rejected.length > 0 || list.malformedContainer) {
        ctx.log.warning(`[ofac] ${describeSanitization(list, fieldName)} No valid keyword remained, so NO ${fieldName} filtering is applied.`);
    }
    return list;
}

// ---------------------------------------------------------------------------
// Record construction
// ---------------------------------------------------------------------------

/** Names a compliance watchlist would target: the vessel, its former names, its registered owner and every "Linked To" company. */
export function watchTextOf(entry: OfacVesselEntry): string {
    const names = [entry.vesselName, ...entry.akaNames.map((aka) => aka.name), entry.vesselOwner, ...extractAllLinkedTo(entry.remarks)];
    return [...new Set(names.filter((n): n is string => typeof n === 'string' && n.trim().length > 0))].join(' | ');
}

/**
 * Fingerprint over every consumer-visible field. `programs` is sorted (re-ordering
 * the same set is not a change); `uid` is identity (already the record id) and
 * `listPublishDateRaw` is a feed-level value shared by every entry of one fetch, so
 * neither can signal a per-vessel change. The UN cross-reference IS consumer-visible
 * (a new UN designation naming an already-listed vessel's IMO is a real change), so
 * it is included; consequently toggling `enrichWithUnConsolidatedList` between runs
 * re-fingerprints every vessel once.
 */
export function vesselFingerprint(entry: OfacVesselEntry, unMatches: readonly UnConsolidatedListMatch[]): string {
    return fingerprintOf([
        [...entry.programs].sort(),
        entry.vesselName,
        entry.remarks,
        entry.linkedTo,
        entry.akaNames,
        entry.imoNumber,
        entry.mmsi,
        entry.otherIds,
        entry.callSign,
        entry.vesselType,
        entry.vesselFlag,
        entry.tonnage,
        entry.grossRegisteredTonnage,
        entry.vesselOwner,
        unMatches.map((m) => [m.dataId, m.name, m.referenceNumber, m.listedOn]),
    ]);
}

export function toSourceRecord(entry: OfacVesselEntry, unMatches: UnConsolidatedListMatch[]): SourceRecord {
    return {
        // Same value the legacy actor used as `record_id`.
        recordId: `OFAC-SDN-${entry.uid}`,
        fingerprint: vesselFingerprint(entry, unMatches),
        watchText: watchTextOf(entry),
        payload: {
            uid: entry.uid,
            vesselName: entry.vesselName,
            sdnType: entry.sdnType,
            programs: entry.programs,
            remarks: entry.remarks,
            linkedTo: entry.linkedTo,
            akaNames: entry.akaNames,
            imoNumber: entry.imoNumber,
            mmsi: entry.mmsi,
            otherIds: entry.otherIds,
            callSign: entry.callSign,
            vesselType: entry.vesselType,
            vesselFlag: entry.vesselFlag,
            tonnage: entry.tonnage,
            grossRegisteredTonnage: entry.grossRegisteredTonnage,
            vesselOwner: entry.vesselOwner,
            listPublishDateRaw: entry.listPublishDateRaw,
            crossReferencedInUnConsolidatedList: unMatches.length > 0,
            unConsolidatedListMatches: unMatches,
            source_url: `${OFAC_DETAILS_BASE_URL}?id=${entry.uid}`,
        },
    };
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export const ofacOptionsSchema = z
    .object({
        /** Cross-reference each vessel's IMO number against the UN Consolidated List (one extra ~2 MB download). */
        enrichWithUnConsolidatedList: z.boolean().default(true),
        /** OFAC program codes (case-insensitive substring), e.g. ["IRAN", "RUSSIA-EO14024"]. Empty = all programs. */
        programFilter: z.union([z.array(z.string()), z.string()]).optional(),
        /** Case-insensitive substring of the vessel's listed name. Empty = all vessels. */
        vesselNameContains: z.string().optional(),
    })
    .strict();
export type OfacOptions = z.infer<typeof ofacOptionsSchema>;

async function download(ctx: ConnectorContext, url: string, what: string): Promise<string> {
    try {
        return await ctx.http.getText(url, { timeoutMs: FEED_TIMEOUT_MS });
    } catch (error) {
        throw new SourceFetchError(`${what} download failed: ${error instanceof Error ? error.message : String(error)}`, 'ofac');
    }
}

export const ofacConnector: Connector<OfacOptions> = {
    id: 'ofac',
    engine: 'global-regtech-compliance-feed',
    legacyActor: 'actor-19-maritime-sanctions-monitor',
    description:
        'US Treasury OFAC SDN list, sdnType=Vessel entries (also absorbs delta-registry-ofac-sanctions-stub), optionally cross-referenced by IMO number against the UN Security Council Consolidated List. Open, unauthenticated feeds; no credentials.',
    status: 'active',
    optionsSchema: ofacOptionsSchema,

    async fetch(ctx: ConnectorContext, options: OfacOptions, run: RunParams): Promise<SourceRecord[]> {
        const programFilter = resolveKeywordFilter(ctx, 'programFilter', options.programFilter);
        const nameFilter = resolveKeywordFilter(
            ctx,
            'vesselNameContains',
            // Wrapped in an array so a vessel name containing a comma is not split like a pasted list.
            typeof options.vesselNameContains === 'string' ? [options.vesselNameContains] : undefined,
        );

        const feed = parseSdnXml(await download(ctx, OFAC_SDN_XML_URL, 'OFAC SDN.XML'));
        assertCompleteSdnFeed(feed);

        // A failed UN download fails the source: silently reporting "not cross-referenced"
        // would be a false negative in a compliance feed. Disable the option to skip it.
        const unIndex = options.enrichWithUnConsolidatedList
            ? buildUnImoIndex(await download(ctx, UN_CONSOLIDATED_XML_URL, 'UN Consolidated List'))
            : new Map<string, UnConsolidatedListMatch[]>();

        const records: SourceRecord[] = [];
        for (const entry of feed.entries) {
            if (!matchesProgramFilter(entry.programs, programFilter)) continue;
            if (!matchesNameFilter(entry.vesselName, nameFilter)) continue;
            records.push(toSourceRecord(entry, lookupUnMatches(entry.imoNumber, unIndex)));
            if (records.length >= run.maxItemsPerSource) break;
        }

        ctx.log.info(
            `[ofac] ${feed.entries.length} vessel entr${feed.entries.length === 1 ? 'y' : 'ies'} of ${feed.totalEntryCount} SDN entries (list published ${feed.publishDateRaw || 'unknown'}); ${records.length} returned.`,
        );
        return records;
    },
};
