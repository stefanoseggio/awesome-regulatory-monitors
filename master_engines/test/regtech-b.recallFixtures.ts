/**
 * Realistic upstream fixtures for the fda_ema_recalls tests. Nothing here is hand-written.
 *
 *  - LEGACY_FDA_SAMPLE / LEGACY_EMA_SAMPLE: copied verbatim (minus the `_fixtureProvenance` note) from the legacy
 *    actor's own test fixtures, actor-22-drug-safety-recalls-monitor/test/fixtures/*.json, which its author captured
 *    from the live regulators on 2026-09-07.
 *  - LIVE_FDA_2026_10_21: the first two records of a live openFDA response fetched in this session
 *    (`sort=report_date:desc&limit=3`, 2026-10-21), with its real `meta`.
 *  - LIVE_EMA_2026_10_21: the first and the last record of the live EMA DHPC export fetched in this session. The last
 *    one (Ecalta) is the real example of a record with a BLANK `dissemination_date`.
 */

export const LEGACY_FDA_SAMPLE = {
    "meta": {
        "disclaimer": "Do not rely on openFDA to make decisions regarding medical care. While we make every effort to ensure that data is accurate, you should assume all results are unvalidated. We may limit or otherwise restrict your access to the API in line with our Terms of Service.",
        "terms": "https://open.fda.gov/terms/",
        "license": "https://open.fda.gov/license/",
        "last_updated": "2026-08-19",
        "results": {
            "skip": 0,
            "limit": 3,
            "total": 17899
        }
    },
    "results": [
        {
            "status": "Terminated",
            "city": "Peoria",
            "state": "IL",
            "country": "United States",
            "classification": "Class II",
            "openfda": {},
            "product_type": "Drugs",
            "event_id": "72241",
            "recalling_firm": "Kalman Health & Wellness, Inc. dba Essential Wellness Pharma",
            "address_1": "4625 N University St",
            "address_2": "N/A",
            "postal_code": "61614-5828",
            "voluntary_mandated": "Voluntary: Firm initiated",
            "initial_firm_notification": "Letter",
            "distribution_pattern": "Nationwide",
            "recall_number": "D-321-2016",
            "product_description": "Progesterone 100 mg/mL in Corn Oil Injection, 2 mL vials, Rx only, Essential Wellness PHARMACY, 4625 N. University, Peoria, IL 61614.",
            "product_quantity": "1 vial",
            "reason_for_recall": "Lack of Assurance of Sterility:  A recall of all compounded sterile preparations within expiry is being initiated due to observations associated with poor sterile production practices resulting in a lack of sterility assurance for their finished drugs.",
            "recall_initiation_date": "20150903",
            "center_classification_date": "20151117",
            "termination_date": "20171229",
            "report_date": "20151125",
            "code_info": "Lot #: 072915, Exp 10/29/2015"
        },
        {
            "status": "Ongoing",
            "city": "Flushing",
            "state": "NY",
            "country": "United States",
            "classification": "Class I",
            "openfda": {},
            "product_type": "Drugs",
            "event_id": "98650",
            "recalling_firm": "Buy-Herbal",
            "address_1": "13661 41st Ave",
            "address_2": "Box 239",
            "postal_code": "11355-2464",
            "voluntary_mandated": "Voluntary: Firm initiated",
            "initial_firm_notification": "E-Mail",
            "distribution_pattern": "Product was sold to individual consumers via ebay third party seller.",
            "recall_number": "D-0769-2026",
            "product_description": "Kian Pee Wan Capsules, 30-count bottles",
            "product_quantity": "71 bottles",
            "reason_for_recall": "Marketed Without an Approved NDA/ANDA: Product contains undeclared drug ingredients dexamethasone and cyproheptadine.",
            "recall_initiation_date": "20260321",
            "center_classification_date": "20260817",
            "report_date": "20260819",
            "code_info": "All lots within expiry.",
            "more_code_info": ""
        },
        {
            "status": "Ongoing",
            "city": "Kadi",
            "state": "",
            "country": "India",
            "classification": "Class II",
            "openfda": {},
            "product_type": "Drugs",
            "event_id": "99547",
            "recalling_firm": "Shoolin Pharma Chem LLP",
            "address_1": "408 B/H Ratnamani Tubes",
            "address_2": "Block/Survey No; Nr Maruti Inox",
            "postal_code": "N/A",
            "voluntary_mandated": "Voluntary: Firm initiated",
            "initial_firm_notification": "",
            "distribution_pattern": "Distributed Nationwide in the USA",
            "recall_number": "D-0759-2026",
            "product_description": "SILDENAFIL CITRATE USP, 0.100 KG, 100 gm-bag Net Wt, RX ONLY \"FOR Prescription Compounding Only\", Shoolin Pharma Chem LLP, Block/Survey no 408, B/H Ratnamani Tubes, Near Maruti Inox, Indrad, Kadi, Mahesana, Gujarat, 382715, India, (CAS NO. 171599-83-0) NDC 85702-001-05",
            "product_quantity": "25KG, 250-1gm bags",
            "reason_for_recall": "CGMP Deviations:Noted during FDA inspection",
            "recall_initiation_date": "20260803",
            "center_classification_date": "20260813",
            "report_date": "20260819",
            "code_info": "Batch SDC2505001, Date of Expiry: April 30, 2030.",
            "more_code_info": ""
        }
    ]
} as const;

export const LEGACY_EMA_SAMPLE = {
    "meta": {
        "total_records": 174,
        "timestamp": "2026-09-07T06:05:31Z"
    },
    "data": [
        {
            "category": "Human",
            "name_of_medicine": "Jentadueto",
            "procedure_number": "",
            "active_substances": "linagliptin;metformin hydrochloride",
            "dhpc_type": "Quality defect",
            "regulatory_outcome": "",
            "referral_name": "",
            "atc_code_human": "A10BD11",
            "atcvet_code_veterinary": "",
            "therapeutic_area_mesh": "Diabetes Mellitus, Type 2",
            "species": "",
            "other_related_medicines_nationally_authorised": "",
            "dissemination_date": "20/08/2026",
            "first_published_date": "20/08/2026",
            "last_updated_date": "",
            "dhpc_url": "https://www.ema.europa.eu/en/medicines/dhpc/jentadueto"
        },
        {
            "category": "Human",
            "name_of_medicine": "Tavneos",
            "procedure_number": "EMA/REF/0000325221",
            "active_substances": "avacopan",
            "dhpc_type": "Referral - Article 20 procedure",
            "regulatory_outcome": "Revocation",
            "referral_name": "Tavneos",
            "atc_code_human": "L04",
            "atcvet_code_veterinary": "",
            "therapeutic_area_mesh": "Microscopic Polyangiitis;Wegener Granulomatosis",
            "species": "",
            "other_related_medicines_nationally_authorised": "",
            "dissemination_date": "16/07/2026",
            "first_published_date": "17/07/2026",
            "last_updated_date": "",
            "dhpc_url": "https://www.ema.europa.eu/en/medicines/dhpc/tavneos"
        }
    ]
} as const;

export const LIVE_FDA_2026_10_21 = {
    "meta": {
        "disclaimer": "Do not rely on openFDA to make decisions regarding medical care. While we make every effort to ensure that data is accurate, you should assume all results are unvalidated. We may limit or otherwise restrict your access to the API in line with our Terms of Service.",
        "terms": "https://open.fda.gov/terms/",
        "license": "https://open.fda.gov/license/",
        "last_updated": "2026-10-14",
        "results": {
            "skip": 0,
            "limit": 3,
            "total": 18043
        }
    },
    "results": [
        {
            "status": "Ongoing",
            "city": "Pomona",
            "state": "CA",
            "country": "United States",
            "classification": "Class II",
            "openfda": {
                "application_number": [
                    "M018"
                ],
                "brand_name": [
                    "LEADER DRY EYE RELIEF EYE DROPS",
                    "ARTIFICIAL TEARS",
                    "FOSTER AND THRIVE DRY EYE RELIEF"
                ],
                "generic_name": [
                    "GLYCERIN, HYPROMELLOSE, POLYETHYLENE GLYCOL 400",
                    "GLYCERIN",
                    "POLYETHYLENE GLYCOL 400"
                ],
                "manufacturer_name": [
                    "CARDINAL HEALTH 110, LLC. DBA LEADER",
                    "Geri-Care Pharmaceuticals, Corp",
                    "Strategic Sourcing Services LLC"
                ],
                "product_ndc": [
                    "70000-0502",
                    "57896-181",
                    "70677-1157"
                ],
                "product_type": [
                    "HUMAN OTC DRUG"
                ],
                "route": [
                    "OPHTHALMIC"
                ],
                "substance_name": [
                    "GLYCERIN",
                    "HYPROMELLOSE, UNSPECIFIED",
                    "POLYETHYLENE GLYCOL 400",
                    "HYPROMELLOSES"
                ],
                "rxcui": [
                    "259581",
                    "2360899"
                ],
                "spl_id": [
                    "5944f7bf-c84b-497f-e063-6394a90aed1f",
                    "472b069b-4e80-8cb8-e063-6294a90a302b",
                    "4749275b-6982-4eaf-e063-6394a90aaee9"
                ],
                "spl_set_id": [
                    "2ded4bda-b3c3-4521-8701-5c8446fd148b",
                    "7cc437e3-bad9-59be-e053-2991aa0a1da3",
                    "0018ade9-5856-db6c-e063-6394a90a2ccf"
                ],
                "package_ndc": [
                    "70000-0502-1",
                    "70000-0502-2",
                    "57896-181-05",
                    "70677-1157-1"
                ],
                "is_original_packager": [
                    true
                ],
                "upc": [
                    "0096295137064",
                    "0096295137071",
                    "0357896184056",
                    "0010939958266",
                    "867166000004",
                    "093351011566",
                    "614299056206",
                    "041220437412",
                    "072036713032",
                    "036800361003"
                ],
                "nui": [
                    "N0000185370",
                    "N0000175629",
                    "N0000184306",
                    "N0000185001",
                    "M0000728",
                    "M0009417"
                ],
                "pharm_class_epc": [
                    "Non-Standardized Chemical Allergen [EPC]"
                ],
                "pharm_class_pe": [
                    "Increased Histamine Release [PE]",
                    "Cell-mediated Immunity [PE]",
                    "Increased IgG Production [PE]"
                ],
                "pharm_class_cs": [
                    "Allergens [CS]",
                    "Glycerol [CS]"
                ],
                "unii": [
                    "PDC6A3C0OX",
                    "3NXW29V3WO",
                    "B697894SGQ"
                ]
            },
            "product_type": "Drugs",
            "event_id": "99880",
            "recalling_firm": "K.C. Pharmaceuticals, Inc.",
            "address_1": "3420 Pomona Blvd",
            "address_2": "N/A",
            "postal_code": "91768-3236",
            "voluntary_mandated": "Voluntary: Firm initiated",
            "initial_firm_notification": "E-Mail",
            "distribution_pattern": "US Nationwide",
            "recall_number": "D-0006-2027",
            "product_description": "Sterile Lubricant Dry Eye Relief Eye Drops, 0.5 FL OZ (15 mL); a) LEADER, DISTRIBUTED BY CARDINAL HEALTH, DUBLIN, OHIO 43017, www.myleader.com, NDC 70000-0502-1; b) Crocodile Tears, Distributed by: Crocodile Tears, Palm Beach Gardens, FL 33410, UPC: 8 67166 00000 4; c) Discount drug mart, Discount Drug Mart Food Fair, Medina, OH 44256, UPC: 0 93351 01156 6; d) exchange select, Manufactured for your Military Exchange By: K.C Pharmaceuticals, Inc., Pomona, CA 9176, UPC: 6 14299 05620 6; e) GERI CARE, Distributed by: Gericare Pharmaceuticals Corp., 1295 Towbin Ave., Lakewood, NJ 08701, NDC 57896-181-05; f) H.E.B Dry Eye,  Eye Drops, MADE WITH PRIDE & CARE FOR H-E-B, SAN ANTONIO, TX 78204, UPC 0 41220 43741 2; g) Harris Teeter, PROUDLY DISTRIBUTED BY: HARRIS TEETER, LLC, MATTHEWS, NC 28105, UPC: 0 72036 71303 2; h) Foster & Thrive, Distributed by: McKesson Corp. Via Strategic Sourcing Servies LLC., Memphis, TN 38141, NDC 70677-1157-1; I) TopCare health, DISTRIBUTED BY TOPCO ASSOCIATES LLC, ELKGROVE VILLAGE, IL 60007, UPC 0 36800 36100 3.",
            "product_quantity": "1,327,248 cartons",
            "reason_for_recall": "Lack of Assurance of Sterility",
            "recall_initiation_date": "20260911",
            "center_classification_date": "20261005",
            "report_date": "20261014",
            "code_info": "Lot: a) LT25B01, Exp.: 02/28/2027; b) LT25D02, Exp.: 04/30/2027; LT25K01, Exp.: 09/30/2027; c) LT25D02, Exp.: 04/30/2027; LT25K01, Exp.: 09/30/2027; d) LT25D02, Exp.: 04/30/2027; LT25M02, Exp.: 10/31/2027; e) LT25B01, Exp.: 02/28/2027; LT25D01, Exp.: 04/30/2027; LT25D02, Exp.: 04/30/2027; LT25K01, Exp.: 09/30/2027; LT25M01, Exp.: 10/31/2027; LT25M02, Exp.: 10/31/2027; LT25N01, Exp.: 11/30/2027; LT25N02, Exp.: 11/30/2027; f) LT25B01, Exp.: 02/28/2027; g) LT25M02, Exp.: 10/31/2027; h) LT25B01, Exp.: 02/28/2027; I) LT25B01, Exp.: 02/28/2027; LT25D02, Exp.: 04/30/2027; LT25M02, Exp.: 10/31/2027."
        },
        {
            "status": "Ongoing",
            "city": "Ridgeland",
            "state": "SC",
            "country": "United States",
            "classification": "Class II",
            "openfda": {},
            "product_type": "Drugs",
            "event_id": "99867",
            "recalling_firm": "Carolina Infusion, LLC",
            "address_1": "95 Bees Creek Rd",
            "address_2": "N/A",
            "postal_code": "29936-7540",
            "voluntary_mandated": "Voluntary: Firm initiated",
            "initial_firm_notification": "E-Mail",
            "distribution_pattern": "Nationwide within the U.S",
            "recall_number": "D-0021-2027",
            "product_description": "QUAD-MIX( PAPAV/PHENTO/ALPROS/TROP) INJECTABLE, Packaged in single-use dosage syringes, total mL dispensed based on dosage per specific patient prescription, Carolina Infusion LLC, 95 Bees Creek Road, Ridgeland, SC 29936",
            "product_quantity": "5 mls in patient specific syringe doses",
            "reason_for_recall": "Lack of Assurance of Sterility:   Related to processing equipment used in compounded product.",
            "recall_initiation_date": "20260910",
            "center_classification_date": "20261008",
            "report_date": "20261014",
            "code_info": "LOT: 08032026@24, BUD: 09/17/2026."
        }
    ]
} as const;

export const LIVE_EMA_2026_10_21 = {
    "ocrevus_first_in_export": {
        "category": "Human",
        "name_of_medicine": "Ocrevus",
        "procedure_number": "EMA/VR/0000313041",
        "active_substances": "ocrelizumab",
        "dhpc_type": "Adverse event;Post-authorisation measure",
        "regulatory_outcome": "Variation",
        "referral_name": "",
        "atc_code_human": "L04AG08",
        "atcvet_code_veterinary": "",
        "therapeutic_area_mesh": "Multiple Sclerosis",
        "species": "",
        "other_related_medicines_nationally_authorised": "",
        "dissemination_date": "08/10/2026",
        "first_published_date": "09/10/2026",
        "last_updated_date": "",
        "dhpc_url": "https://www.ema.europa.eu/en/medicines/dhpc/ocrevus"
    },
    "ecalta_blank_dissemination_last_in_export": {
        "category": "Human",
        "name_of_medicine": "Ecalta",
        "procedure_number": "",
        "active_substances": "anidulafungin",
        "dhpc_type": "Quality defect",
        "regulatory_outcome": "Variation",
        "referral_name": "",
        "atc_code_human": "J02AX06",
        "atcvet_code_veterinary": "",
        "therapeutic_area_mesh": "Candidiasis",
        "species": "",
        "other_related_medicines_nationally_authorised": "",
        "dissemination_date": "",
        "first_published_date": "14/02/2020",
        "last_updated_date": "",
        "dhpc_url": "https://www.ema.europa.eu/en/medicines/dhpc/ecalta"
    }
} as const;
