
// index.js (Appwrite Function) - validateResult (ESM compatible)

// --- Imports ---
import fs from "fs";
import { Client, Databases, ID, Query } from "node-appwrite";
import Ajv from "ajv";
import addFormats from "ajv-formats";

// Local helper
import { normalizeUnit, convertIfNeeded } from "./validateResult/ucum-utils.js";

// --- Config ---
const APPWRITE_ENDPOINT = process.env.APPWRITE_ENDPOINT || process.env.APPWRITE_FUNCTION_ENDPOINT;
const APPWRITE_PROJECT = process.env.APPWRITE_PROJECT || process.env.APPWRITE_FUNCTION_PROJECT;
const APPWRITE_KEY = process.env.APPWRITE_API_KEY || process.env.APPWRITE_FUNCTION_KEY;
const DB_ID = process.env.DB_ID || "67a081e10018a7e7ec5a";

const COLS = {
    INCOMING: "67efb45500302fe3bd98",
    MAPPINGS: "68b6ee5b000a7a6dc1ce",
    REFS: "reference_ranges",
    OBS: "observations",
    REPORTS: "diagnostic_reports",
    AUDIT: "audit_logs",
};

// --- Appwrite SDK ---
const client = new Client()
    .setEndpoint(APPWRITE_ENDPOINT)
    .setProject(APPWRITE_PROJECT)
    .setKey(APPWRITE_KEY);
const databases = new Databases(client);

// --- AJV validation ---
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const incomingSchema = {
    type: "object",
    required: ["P_name", "P_age", "P_id", "submittedBy", "submittedAt", "healthsecterid"],
    properties: {
        P_name: { type: "string" },
        P_age: { type: ["number", "string"] },
        P_phone: { type: "string" },
        doc_id: { type: "string" },
        doc_name: { type: "string" },
        doc_profile: { type: "string" },
        result: {
            type: "array",
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
        $createdAt: { type: "string", format: "date-time" },
    },
};

const validateIncoming = ajv.compile(incomingSchema);

// --- Helpers ---
function readPayload() {
    try {
        if (process.env.APPWRITE_FUNCTION_EVENT_DATA) {
            const eventData = JSON.parse(process.env.APPWRITE_FUNCTION_EVENT_DATA);
            console.log("Raw event payload:", JSON.stringify(eventData, null, 2));
            console.log("Event name:", process.env.APPWRITE_FUNCTION_EVENT);
            return eventData;
        }
        const stdin = fs.readFileSync(0, "utf8");
        if (stdin && stdin.trim()) {
            const stdinData = JSON.parse(stdin);
            console.log("Raw stdin payload:", JSON.stringify(stdinData, null, 2));
            return stdinData;
        }
        console.log("No event data or stdin provided");
    } catch (err) {
        console.error("Failed to parse payload:", err.message);
    }
    return {};
}

function preprocessPayload(data) {
    console.log("Original payload:", JSON.stringify(data, null, 2));
    const normalizedData = {
        P_name: data.P_name || data.p_name || data.patientName || "Unknown Patient",
        P_age: data.P_age || data.p_age || data.patientAge || 0,
        P_id: data.P_id || data.p_id || data.patientId || ID.unique(),
        result: Array.isArray(data.result) ? data.result : [],
        doc_name: data.doc_name || data.submittedBy || data.staff_name || "Unknown Doctor",
        $createdAt: data.$createdAt || data.submittedAt || new Date().toISOString(),
        healthsecterid: data.healthsecterid || data.healthSectorId || "unknown",
        ...data,
        submittedBy: data.doc_name || data.submittedBy || data.staff_name || "Unknown Doctor",
        submittedAt: data.$createdAt || data.submittedAt || new Date().toISOString(),
        incomingDocId: data.$id || data.incomingDocId || ID.unique(),
    };
    console.log("Preprocessed payload:", JSON.stringify(normalizedData, null, 2));
    return normalizedData;
}

function getLoincFromMapping(mapDoc) {
    return mapDoc?.loinc || mapDoc?.loincCode || mapDoc?.loinc_code || null;
}
function getDefaultUnitFromMapping(mapDoc) {
    return mapDoc?.defaultUnitUCUM || mapDoc?.unit || mapDoc?.unit_ucum || null;
}
function extractRefRange(refDoc) {
    const low = refDoc?.low ?? refDoc?.minValue ?? undefined;
    const high = refDoc?.high ?? refDoc?.maxValue ?? undefined;
    const critLow = refDoc?.criticalLow ?? undefined;
    const critHigh = refDoc?.criticalHigh ?? undefined;
    const sex = (refDoc?.sex || refDoc?.gender || "U").toUpperCase();
    const ageMin = refDoc?.ageMin ?? undefined;
    const ageMax = refDoc?.ageMax ?? undefined;
    const unit = refDoc?.unit ?? refDoc?.unitUCUM ?? null;
    return { low, high, critLow, critHigh, sex, ageMin, ageMax, unit };
}

// --- Heavy Processor (runs async in background) ---
async function processLabResults(data) {
    const patientAge = typeof data.P_age === "string" ? parseFloat(data.P_age) : data.P_age;
    const sex = (data.sex || data.P_sex || data.P_gender || "U").toUpperCase();
    const submittedBy = data.submittedBy || data.staff_id || "unknown";

    // If result is empty or missing, mark document as validated but skip processing
    if (!Array.isArray(data.result) || data.result.length === 0) {
        if (data.incomingDocId) {
            try {
                await databases.updateDocument(DB_ID, COLS.INCOMING, data.incomingDocId, {
                    status: "validated",
                    validatedAt: new Date().toISOString(),
                });
                console.log("No results to process, marked document as validated");
            } catch (e) {
                console.error("Failed to update INCOMING doc with no results:", e.message);
            }
        }
        return;
    }

    const processedTests = [];
    const errors = [];
    const mappingCache = {};
    const refCache = {};

    for (const t of data.result) {
        try {
            const localTestId = t.localTestId;

            // Load mapping
            let mapping = mappingCache[localTestId];
            if (!mapping) {
                const mapResp = await databases.listDocuments(DB_ID, COLS.MAPPINGS, [
                    Query.equal("localTestId", localTestId),
                    Query.limit(1),
                ]);
                mapping = (mapResp.documents && mapResp.documents[0]) || null;
                mappingCache[localTestId] = mapping;
            }
            if (!mapping) {
                errors.push({ localTestId, reason: "Missing mapping document" });
                continue;
            }

            const loinc = getLoincFromMapping(mapping);
            const canonicalUnitFromMapping = getDefaultUnitFromMapping(mapping);

            const unitRaw = t.unit || "";
            const normalizedUnit = normalizeUnit(unitRaw);
            if (!normalizedUnit) {
                errors.push({ localTestId, reason: `Unknown unit: ${unitRaw} ` });
                continue;
            }

            const numericValue = typeof t.value === "number" ? t.value : Number(t.value);
            let finalValue = isNaN(numericValue) ? t.value : numericValue;
            let finalUnit = normalizedUnit;

            if (!isNaN(numericValue) && canonicalUnitFromMapping && normalizedUnit !== canonicalUnitFromMapping) {
                try {
                    const converted = convertIfNeeded(numericValue, normalizedUnit, canonicalUnitFromMapping);
                    finalValue = converted.value;
                    finalUnit = canonicalUnitFromMapping;
                } catch (err) {
                    errors.push({ localTestId, reason: `Conversion failed: ${err.message} ` });
                    continue;
                }
            }

            let refs = refCache[loinc];
            if (!refs) {
                const refResp = await databases.listDocuments(DB_ID, COLS.REFS, [Query.equal("loinc", loinc)]);
                refs = refResp.documents || [];
                refCache[loinc] = refs;
            }

            const matchedRef = refs.find((r) => {
                const { sex: rSex, ageMin, ageMax } = extractRefRange(r);
                return (
                    (rSex === "U" || rSex === sex) &&
                    (ageMin === undefined || patientAge >= Number(ageMin)) &&
                    (ageMax === undefined || patientAge <= Number(ageMax))
                );
            });

            let interpretation = "N";
            if (matchedRef && typeof finalValue === "number") {
                const { low, high, critLow, critHigh } = extractRefRange(matchedRef);
                if (critLow !== undefined && finalValue < Number(critLow)) interpretation = "CRIT_LOW";
                else if (critHigh !== undefined && finalValue > Number(critHigh)) interpretation = "CRIT_HIGH";
                else if (low !== undefined && finalValue < Number(low)) interpretation = "L";
                else if (high !== undefined && finalValue > Number(high)) interpretation = "H";
            } else {
                interpretation = "NO_REF";
            }

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
            errors.push({ localTestId: t.localTestId || "_unknown", reason: err.message });
        }
    }

    // Update DB
    if (errors.length) {
        if (data.incomingDocId) {
            try {
                await databases.updateDocument(DB_ID, COLS.INCOMING, data.incomingDocId, {
                    status: "rejected",
                    errors,
                });
            } catch (e) {
                console.error("Failed to update rejected INCOMING doc", e.message);
            }
        }
        return;
    }

    try {
        const obsIds = [];
        for (const obs of processedTests) {
            const obsDoc = {
                loincCode: obs.loinc,
                patientId: data.P_id,
                patientName: data.P_name,
                value: obs.value,
                unit: obs.unit,
                abnormalFlag: obs.interpretation,
                status: "final",
                recordedAt: obs.timestamp,
                performer: submittedBy,
                rawTest: obs,
            };
            const obsResp = await databases.createDocument(DB_ID, COLS.OBS, ID.unique(), obsDoc);
            obsIds.push(obsResp.$id);
        }

        const reportDoc = {
            patientId: data.P_id,
            patientName: data.P_name,
            reportDate: new Date().toISOString(),
            observationIds: obsIds,
            status: "final",
            performedBy: submittedBy,
            issuedAt: new Date().toISOString(),
        };
        const reportResp = await databases.createDocument(DB_ID, COLS.REPORTS, ID.unique(), reportDoc);

        await databases.createDocument(DB_ID, COLS.AUDIT, ID.unique(), {
            userId: submittedBy,
            action: "create_diagnostic_report",
            targetCollection: COLS.REPORTS,
            targetId: reportResp.$id,
            timestamp: new Date().toISOString(),
        });

        if (data.incomingDocId) {
            try {
                await databases.updateDocument(DB_ID, COLS.INCOMING, data.incomingDocId, {
                    status: "validated",
                    reportId: reportResp.$id,
                    validatedAt: new Date().toISOString(),
                });
            } catch (e) {
                console.error("Failed to update validated INCOMING doc", e.message);
            }
        }
    } catch (err) {
        console.error("Create observations/report failed:", err.message);
        if (data.incomingDocId) {
            try {
                await databases.updateDocument(DB_ID, COLS.INCOMING, data.incomingDocId, {
                    status: "error",
                    error: err.message,
                });
            } catch (e) {
                console.error("Failed to update error INCOMING doc", e.message);
            }
        }
    }
}

// --- Main Function Entry ---
export default async function main() {
    const payload = readPayload();
    if (!payload) {
        console.error("Empty payload received, expected document from INCOMING collection");
        return JSON.stringify({ ok: false, reason: "Empty payload" });
    }
    if (!payload.$collectionId) {
        console.error("Payload missing $collectionId, received:", JSON.stringify(payload, null, 2));
        return JSON.stringify({ ok: false, reason: "Missing $collectionId" });
    }
    if (payload.$collectionId !== COLS.INCOMING) {
        console.error(
            `Payload from wrong collection: ${payload.$collectionId}, expected: ${COLS.INCOMING} `
        );
        return JSON.stringify({ ok: false, reason: "Wrong collection", receivedCollection: payload.$collectionId });
    }
    const data = preprocessPayload(payload);
    const ok = validateIncoming(data);
    if (!ok) {
        const errors = validateIncoming.errors || [];
        console.error("Schema validation failed:", JSON.stringify(errors, null, 2));
        return JSON.stringify({ ok: false, reason: "schema", errors });
    }
    // ✅ Respond immediately to avoid timeout
    const response = {
        ok: true,
        status: "processing",
        incomingDocId: data.incomingDocId || null,
    };
    // 🚀 Process heavy work in background
    process.nextTick(() => {
        processLabResults(data).catch((err) => {
            console.error("Background processing failed:", err.message);
        });
    });
    return JSON.stringify(response);
}
