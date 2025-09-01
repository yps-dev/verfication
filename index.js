// validateResult/index.js
const fs = require('fs');
const sdk = require("node-appwrite");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const dayjs = require("dayjs");
const { normalizeUnit, convertIfNeeded } = require("./ucum-utils");

// --- Config: read from env (set these in Appwrite function settings) ---
const APPWRITE_ENDPOINT = process.env.APPWRITE_ENDPOINT || process.env.APPWRITE_FUNCTION_ENDPOINT;
const APPWRITE_PROJECT = process.env.APPWRITE_PROJECT || process.env.APPWRITE_FUNCTION_PROJECT;
const APPWRITE_KEY = process.env.APPWRITE_API_KEY || process.env.APPWRITE_FUNCTION_KEY;
const DB_ID = process.env.DB_ID || "67a081e10018a7e7ec5a"; // replace if needed

const COLS = {
    INCOMING: process.env.COL_INCOMING || "results_incoming",
    MAPPINGS: process.env.COL_MAPPINGS || "loinc_mappings",
    REFS: process.env.COL_REFS || "reference_ranges",
    OBS: process.env.COL_OBS || "observations",
    REPORTS: process.env.COL_REPORTS || "diagnostic_reports",
    AUDIT: process.env.COL_AUDIT || "audit_logs",
};

// --- Init Appwrite SDK ---
const client = new sdk.Client()
    .setEndpoint(APPWRITE_ENDPOINT)
    .setProject(APPWRITE_PROJECT)
    .setKey(APPWRITE_KEY);
const databases = new sdk.Databases(client);

// --- AJV schema --- (validate required top-level fields)
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const incomingSchema = {
    type: "object",
    required: ["p_name", "P_age", "P_id", "result", "submittedBy", "submittedAt", "healthsecterid"],
    properties: {
        p_name: { type: "string" },
        P_age: { type: ["number", "string"] },
        P_phone: { type: "string" },
        doc_id: { type: "string" },
        doc_name: { type: "string" },
        doc_profile: { type: "string" },
        result: {
            type: "array",
            minItems: 1,
            items: {
                type: "object",
                required: ["localTestId", "value", "unit", "timestamp"],
                properties: {
                    localTestId: { type: "string" },
                    value: {},
                    unit: { type: "string" },
                    timestamp: { type: "string", format: "date-time" },
                    notes: { type: "string" },
                },
            },
        },
        status: { type: "string" },
        seen_by_stuff: { type: "boolean" },
        healthsecterid: { type: "string" },
        staff_id: { type: "string" },
        staff_name: { type: "string" },
        doc_catagory: { type: "string" },
        result_file: { type: "array" },
        result_image: { type: "array" },
        P_id: { type: "string" },
        type: { type: "string" },
        availablity: { type: "array" },
        request: { type: "array" },
        submittedBy: { type: "string" },
        submittedAt: { type: "string", format: "date-time" },
        incomingDocId: { type: "string" } // optional: update original doc
    }
};

const validateIncoming = ajv.compile(incomingSchema);

// Helper: read payload (Appwrite functions provide APPWRITE_FUNCTION_EVENT_DATA or stdin)
function readPayload() {
    try {
        if (process.env.APPWRITE_FUNCTION_EVENT_DATA) {
            return JSON.parse(process.env.APPWRITE_FUNCTION_EVENT_DATA);
        }
        // attempt to read STDIN
        const stdin = fs.readFileSync(0, "utf8");
        if (stdin && stdin.trim()) return JSON.parse(stdin);
    } catch (err) {
        console.error("Failed to parse payload:", err);
    }
    return {};
}

async function main() {
    const payload = readPayload();
    // If the event is Appwrite DB event object, it might be wrapped. Normalize:
    const data = payload.payload || payload || {};

    // Validate shape
    const ok = validateIncoming(data);
    if (!ok) {
        const errors = validateIncoming.errors || [];
        console.error("Schema validation failed:", errors);
        return console.log(JSON.stringify({ ok: false, reason: "schema", errors }));
    }

    // Prepare context values
    const patientAge = typeof data.P_age === "string" ? parseFloat(data.P_age) : data.P_age;
    const sex = (data.sex || data.P_sex || "U").toUpperCase?.() || "U"; // allow different naming if needed
    const submittedBy = data.submittedBy || data.staff_id || "unknown";

    const testsOut = [];
    const errors = [];

    // Cache mappings + refs in function memory for this execution (reduces DB calls)
    const mappingCache = {};
    const refCache = {};

    for (const t of data.result) {
        try {
            const localTestId = t.localTestId;

            // 1) mapping: try cache first
            let mapping = mappingCache[localTestId];
            if (!mapping) {
                const mapResp = await databases.listDocuments(DB_ID, COLS.MAPPINGS, [sdk.Query.equal("localTestId", localTestId), sdk.Query.limit(1)]);
                mapping = mapResp.documents?.[0] || null;
                mappingCache[localTestId] = mapping;
            }
            if (!mapping || !mapping.loinc) {
                errors.push({ localTestId, reason: "Missing LOINC mapping" });
                continue;
            }
            const loinc = mapping.loinc;
            const canonicalUnit = mapping.defaultUnitUCUM || null;

            // 2) normalize unit
            const unitRaw = t.unit || "";
            const normalized = normalizeUnit(unitRaw);
            if (!normalized) {
                errors.push({ localTestId, reason: `Unknown unit "${unitRaw}"` });
                continue;
            }
            let value = t.value;
            // ensure numeric if possible
            const numericValue = typeof value === "number" ? value : (isFinite(Number(value)) ? Number(value) : null);

            if (numericValue !== null && canonicalUnit && normalized !== canonicalUnit) {
                try {
                    const cv = convertIfNeeded(numericValue, normalized, canonicalUnit);
                    value = cv.value;
                    // store canonical unit
                } catch (err) {
                    // conversion failed: mark as not convertible, but keep raw if needed
                    errors.push({ localTestId, reason: `Unit conversion failed from ${normalized} -> ${canonicalUnit}: ${err?.message || err}` });
                    continue;
                }
            } else {
                // keep numericValue if parsed
                if (numericValue !== null) value = numericValue;
            }

            // 3) load reference ranges for loinc (cache by loinc)
            let refs = refCache[loinc];
            if (!refs) {
                const refResp = await databases.listDocuments(DB_ID, COLS.REFS, [sdk.Query.equal("loinc", loinc)]);
                refs = refResp.documents || [];
                refCache[loinc] = refs;
            }

            // select best matching ref by sex + age
            const matchedRef = refs.find(r => {
                const rSex = (r.sex || "U").toUpperCase();
                const sexMatches = rSex === "U" || rSex === sex;
                const ageMinOk = (r.ageMin === undefined || r.ageMin === null) || (patientAge >= Number(r.ageMin));
                const ageMaxOk = (r.ageMax === undefined || r.ageMax === null) || (patientAge <= Number(r.ageMax));
                return sexMatches && ageMinOk && ageMaxOk;
            });

            // 4) interpretation
            let interpretation = "N"; // normal default
            if (matchedRef && typeof value === "number") {
                const low = matchedRef.low !== undefined ? Number(matchedRef.low) : undefined;
                const high = matchedRef.high !== undefined ? Number(matchedRef.high) : undefined;
                const critLow = matchedRef.criticalLow !== undefined ? Number(matchedRef.criticalLow) : undefined;
                const critHigh = matchedRef.criticalHigh !== undefined ? Number(matchedRef.criticalHigh) : undefined;

                if (critLow !== undefined && value < critLow) interpretation = "CRIT_LOW";
                else if (critHigh !== undefined && value > critHigh) interpretation = "CRIT_HIGH";
                else if (low !== undefined && value < low) interpretation = "L";
                else if (high !== undefined && value > high) interpretation = "H";
                else interpretation = "N";
            } else {
                interpretation = "NO_REF";
            }

            testsOut.push({
                localTestId,
                loinc,
                display: mapping.displayName || localTestId,
                value,
                unit: canonicalUnit || normalized,
                interpretation,
                timestamp: t.timestamp || data.submittedAt,
                notes: t.notes || null
            });
        } catch (err) {
            console.error("Error processing test", t, err);
            errors.push({ localTestId: t.localTestId, reason: err?.message || String(err) });
        }
    } // end for tests

    if (errors.length) {
        // Optionally update incoming doc to status "rejected"
        if (data.incomingDocId) {
            try {
                await databases.updateDocument(DB_ID, COLS.INCOMING, data.incomingDocId, { status: "rejected", errors });
            } catch (e) {
                console.error("Failed to update incoming doc status:", e);
            }
        }
        return console.log(JSON.stringify({ ok: false, status: "rejected", errors }));
    }

    // Create observations and then diagnostic report
    try {
        const obsIds = [];
        for (const o of testsOut) {
            const obsDoc = {
                loinc: o.loinc,
                patientId: data.P_id || data.P_id || data.P_id,
                patientName: data.p_name,
                value: o.value,
                unitUCUM: o.unit,
                interpretation: o.interpretation,
                status: "final",
                timestamp: o.timestamp,
                performer: submittedBy,
                rawTest: o
            };
            const obsResp = await databases.createDocument(DB_ID, COLS.OBS, sdk.ID.unique(), obsDoc);
            obsIds.push(obsResp.$id);
        }

        const reportDoc = {
            patientId: data.P_id,
            patientName: data.p_name,
            orderId: data.request?.[0] || null,
            observations: obsIds,
            status: "final",
            conclusion: "", // optionally filled by tech
            issuedAt: new Date().toISOString(),
            performedBy: submittedBy,
            healthsecterid: data.healthsecterid || null
        };

        const reportResp = await databases.createDocument(DB_ID, COLS.REPORTS, sdk.ID.unique(), reportDoc);

        // Audit log
        await databases.createDocument(DB_ID, COLS.AUDIT, sdk.ID.unique(), {
            resourceId: reportResp.$id,
            resourceType: "DiagnosticReport",
            action: "create",
            userId: submittedBy,
            timestamp: new Date().toISOString(),
            details: { tests: testsOut.map(x => x.loinc), patientId: data.P_id }
        });

        // Update incoming doc if provided
        if (data.incomingDocId) {
            try {
                await databases.updateDocument(DB_ID, COLS.INCOMING, data.incomingDocId, { status: "validated", reportId: reportResp.$id });
            } catch (e) {
                console.warn("Failed to update incoming doc validated state:", e);
            }
        }

        return console.log(JSON.stringify({ ok: true, reportId: reportResp.$id, observations: obsIds }));
    } catch (err) {
        console.error("Create observations/report failed:", err);
        return console.log(JSON.stringify({ ok: false, reason: "create_failed", error: err?.message || String(err) }));
    }
}

// Run
main().catch(err => {
    console.error("Fatal error:", err);
    console.log(JSON.stringify({ ok: false, error: err?.message || String(err) }));
});
