// index.js (Appwrite Function) - validateResult
const fs = require("fs");
const sdk = require("node-appwrite");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const dayjs = require("dayjs");

// local helper module — ensure this file exists in your function bundle
const { normalizeUnit, convertIfNeeded } = require("./validateResult/ucum-utils");

// --- Config (read from Appwrite function environment variables if present) ---
const APPWRITE_ENDPOINT =
    process.env.APPWRITE_ENDPOINT || process.env.APPWRITE_FUNCTION_ENDPOINT;
const APPWRITE_PROJECT =
    process.env.APPWRITE_PROJECT || process.env.APPWRITE_FUNCTION_PROJECT;
const APPWRITE_KEY =
    process.env.APPWRITE_API_KEY || process.env.APPWRITE_FUNCTION_KEY;
const DB_ID = process.env.DB_ID || "67a081e10018a7e7ec5a"; // default DB id (replace if needed)

// Collections: prefer environment variables, fallback to fixed ids/names you provided earlier
const COLS = {
    INCOMING: "67efb45500302fe3bd98",
    MAPPINGS: "68b6ee5b000a7a6dc1ce",
    REFS: "reference_ranges",
    OBS: "observations",
    REPORTS: "diagnostic_reports",
    AUDIT: "audit_logs",
};


// --- Initialize Appwrite SDK ---
const client = new sdk.Client()
    .setEndpoint(APPWRITE_ENDPOINT)
    .setProject(APPWRITE_PROJECT)
    .setKey(APPWRITE_KEY);
const databases = new sdk.Databases(client);

// --- AJV schema for incoming payload validation (defensive) ---
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
        // result is an array of tests (localTestId, value, unit, timestamp)
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
        request: { type: ["array", "string"] },
        submittedBy: { type: "string" },
        submittedAt: { type: "string", format: "date-time" },
        incomingDocId: { type: "string" },
    },
};

const validateIncoming = ajv.compile(incomingSchema);

// Helper: read payload from Appwrite function env or STDIN (works for both DB triggers and direct exec)
function readPayload() {
    try {
        if (process.env.APPWRITE_FUNCTION_EVENT_DATA) {
            return JSON.parse(process.env.APPWRITE_FUNCTION_EVENT_DATA);
        }
        const stdin = fs.readFileSync(0, "utf8");
        if (stdin && stdin.trim()) return JSON.parse(stdin);
    } catch (err) {
        console.error("Failed to parse payload:", err);
    }
    return {};
}

/**
 * Small helpers to read mapping/ref fields defensively
 */
function getLoincFromMapping(mapDoc) {
    return mapDoc?.loinc || mapDoc?.loincCode || mapDoc?.loinc_code || null;
}
function getDefaultUnitFromMapping(mapDoc) {
    return mapDoc?.defaultUnitUCUM || mapDoc?.unit || mapDoc?.unit_ucum || null;
}
function extractRefRange(refDoc) {
    // possible field names: low/high, minValue/maxValue
    const low = refDoc?.low ?? refDoc?.minValue ?? refDoc?.min ?? undefined;
    const high = refDoc?.high ?? refDoc?.maxValue ?? refDoc?.max ?? undefined;
    const critLow = refDoc?.criticalLow ?? refDoc?.critLow ?? undefined;
    const critHigh = refDoc?.criticalHigh ?? refDoc?.critHigh ?? undefined;
    const sex = (refDoc?.sex || refDoc?.gender || "U").toUpperCase();
    const ageMin = refDoc?.ageMin ?? refDoc?.minAge ?? undefined;
    const ageMax = refDoc?.ageMax ?? refDoc?.maxAge ?? undefined;
    const unit = refDoc?.unit ?? refDoc?.unitUCUM ?? refDoc?.unit_ucum ?? null;
    return { low, high, critLow, critHigh, sex, ageMin, ageMax, unit };
}

/**
 * Main processing function
 */
async function main() {
    const payload = readPayload();
    // If Appwrite DB trigger sends wrapped payload { event, payload: {...} }
    const data = payload.payload || payload || {};

    // Validate payload shape
    const ok = validateIncoming(data);
    if (!ok) {
        const errors = validateIncoming.errors || [];
        console.error("Schema validation failed:", errors);
        // return failure info for frontend or logs
        return console.log(JSON.stringify({ ok: false, reason: "schema", errors }));
    }

    // Normalize patient age, sex, submittedBy
    const patientAge =
        typeof data.P_age === "string" ? parseFloat(data.P_age) : data.P_age;
    const sex =
        (data.sex || data.P_sex || data.P_gender || "U").toString().toUpperCase() || "U";
    const submittedBy = data.submittedBy || data.staff_id || "unknown";

    const processedTests = [];
    const errors = [];

    // Lightweight in-memory caches for this run
    const mappingCache = {};
    const refCache = {};

    // iterate tests
    for (const t of data.result) {
        try {
            const localTestId = t.localTestId;

            // 1) Load mapping (map localTestId -> LOINC)
            let mapping = mappingCache[localTestId];
            if (!mapping) {
                const mapResp = await databases.listDocuments(DB_ID, COLS.MAPPINGS, [
                    sdk.Query.equal("localTestId", localTestId),
                    sdk.Query.limit(1),
                ]);
                mapping = (mapResp.documents && mapResp.documents[0]) || null;
                mappingCache[localTestId] = mapping;
            }
            if (!mapping) {
                errors.push({ localTestId, reason: "Missing mapping document for localTestId" });
                continue;
            }

            const loinc = getLoincFromMapping(mapping);
            if (!loinc) {
                errors.push({ localTestId, reason: "Mapping exists but no LOINC code found" });
                continue;
            }

            const canonicalUnitFromMapping = getDefaultUnitFromMapping(mapping); // may be null

            // 2) Normalize unit
            const unitRaw = t.unit || "";
            const normalizedUnit = normalizeUnit(unitRaw);
            if (!normalizedUnit) {
                errors.push({ localTestId, reason: `Unknown/unsupported unit: "${unitRaw}"` });
                continue;
            }

            // parse numeric value when possible
            const numericValue =
                typeof t.value === "number" ? t.value : (isFinite(Number(t.value)) ? Number(t.value) : null);

            let finalValue = t.value;
            let finalUnit = normalizedUnit;
            if (numericValue !== null && canonicalUnitFromMapping && normalizedUnit !== canonicalUnitFromMapping) {
                // attempt conversion
                try {
                    const converted = convertIfNeeded(numericValue, normalizedUnit, canonicalUnitFromMapping);
                    finalValue = converted.value;
                    finalUnit = canonicalUnitFromMapping;
                } catch (err) {
                    errors.push({
                        localTestId,
                        reason: `Conversion failed from ${normalizedUnit} -> ${canonicalUnitFromMapping}: ${err?.message || err}`,
                    });
                    continue;
                }
            } else {
                // if numericValue parsed use it
                if (numericValue !== null) finalValue = numericValue;
            }

            // 3) Load reference ranges for that LOINC
            let refs = refCache[loinc];
            if (!refs) {
                const refResp = await databases.listDocuments(DB_ID, COLS.REFS, [sdk.Query.equal("loinc", loinc)]);
                refs = refResp.documents || [];
                refCache[loinc] = refs;
            }

            // Choose best reference based on sex/age
            const matchedRef = refs.find((r) => {
                const { sex: rSex, ageMin, ageMax } = extractRefRange(r);
                const sexMatches = rSex === "U" || rSex === sex;
                const ageMinOk = ageMin === undefined || ageMin === null || (patientAge >= Number(ageMin));
                const ageMaxOk = ageMax === undefined || ageMax === null || (patientAge <= Number(ageMax));
                return sexMatches && ageMinOk && ageMaxOk;
            });

            // 4) Interpret value
            let interpretation = "N"; // Normal by default
            if (matchedRef && typeof finalValue === "number") {
                const { low, high, critLow, critHigh } = extractRefRange(matchedRef);
                const nLow = low === undefined ? undefined : Number(low);
                const nHigh = high === undefined ? undefined : Number(high);
                const nCritLow = critLow === undefined ? undefined : Number(critLow);
                const nCritHigh = critHigh === undefined ? undefined : Number(critHigh);

                if (nCritLow !== undefined && finalValue < nCritLow) interpretation = "CRIT_LOW";
                else if (nCritHigh !== undefined && finalValue > nCritHigh) interpretation = "CRIT_HIGH";
                else if (nLow !== undefined && finalValue < nLow) interpretation = "L";
                else if (nHigh !== undefined && finalValue > nHigh) interpretation = "H";
                else interpretation = "N";
            } else {
                interpretation = "NO_REF";
            }

            // push processed
            processedTests.push({
                localTestId,
                loinc,
                display: mapping.displayName || mapping.localName || localTestId,
                value: finalValue,
                unit: finalUnit,
                interpretation,
                timestamp: t.timestamp || data.submittedAt,
                notes: t.notes || null,
            });
        } catch (err) {
            console.error("Error processing test item", t, err);
            errors.push({ localTestId: t.localTestId || "_unknown", reason: err?.message || String(err) });
        }
    } // end for each test

    // If any errors, optionally update incoming document and return rejected
    if (errors.length) {
        if (data.incomingDocId) {
            try {
                await databases.updateDocument(DB_ID, COLS.INCOMING, data.incomingDocId, { status: "rejected", errors });
            } catch (errUpdate) {
                console.warn("Failed to update incoming doc status to rejected:", errUpdate);
            }
        }
        return console.log(JSON.stringify({ ok: false, status: "rejected", errors }));
    }

    // No errors -> create observation docs, diagnostic report, audit log
    try {
        const obsIds = [];
        for (const obs of processedTests) {
            // observation doc shape (match your observations collection fields)
            const obsDoc = {
                loincCode: obs.loinc,
                patientId: data.P_id || data.P_id,
                patientName: data.p_name,
                value: obs.value,
                unit: obs.unit,
                abnormalFlag: obs.interpretation, // N, H, L, CRIT_*
                status: "final",
                recordedAt: obs.timestamp,
                performer: submittedBy,
                rawTest: obs,
            };
            const obsResp = await databases.createDocument(DB_ID, COLS.OBS, sdk.ID.unique(), obsDoc);
            obsIds.push(obsResp.$id);
        }

        const reportDoc = {
            patientId: data.P_id,
            patientName: data.p_name,
            reportDate: new Date().toISOString(),
            summary: "", // optional
            observationIds: obsIds,
            status: "final",
            performedBy: submittedBy,
            healthsecterid: data.healthsecterid || null,
            issuedAt: new Date().toISOString(),
        };
        const reportResp = await databases.createDocument(DB_ID, COLS.REPORTS, sdk.ID.unique(), reportDoc);

        // Audit
        await databases.createDocument(DB_ID, COLS.AUDIT, sdk.ID.unique(), {
            userId: submittedBy,
            action: "create_diagnostic_report",
            targetCollection: COLS.REPORTS,
            targetId: reportResp.$id,
            timestamp: new Date().toISOString(),
            details: { observationIds: obsIds, loincs: processedTests.map((p) => p.loinc) },
        });

        // Update incoming doc status -> validated + link
        if (data.incomingDocId) {
            try {
                await databases.updateDocument(DB_ID, COLS.INCOMING, data.incomingDocId, {
                    status: "validated",
                    reportId: reportResp.$id,
                    validatedAt: new Date().toISOString(),
                });
            } catch (errUpdate) {
                console.warn("Failed to update incoming doc to validated:", errUpdate);
            }
        }

        // Return processed results and observation ids for the frontend
        return console.log(
            JSON.stringify({
                ok: true,
                reportId: reportResp.$id,
                observations: obsIds,
                results: processedTests,
            })
        );
    } catch (err) {
        console.error("Create observations/report failed:", err);
        // Try to flag incoming as error
        if (data.incomingDocId) {
            try {
                await databases.updateDocument(DB_ID, COLS.INCOMING, data.incomingDocId, { status: "error", error: String(err) });
            } catch (ignore) { }
        }
        return console.log(JSON.stringify({ ok: false, reason: "create_failed", error: err?.message || String(err) }));
    }
}

main().catch((err) => {
    console.error("Fatal error:", err);
    console.log(JSON.stringify({ ok: false, error: err?.message || String(err) }));
});
