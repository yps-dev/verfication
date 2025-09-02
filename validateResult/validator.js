// validateResult/validateResult.js
import { normalizeUnit, convertIfNeeded } from "./ucum-utils.js";

const TEST_CATALOG = {
    "glucose": { loinc: "2345-7", unit: "mg/dL", refLow: 70, refHigh: 110 },
    "hemoglobin": { loinc: "718-7", unit: "g/dL", refLow: 12, refHigh: 16 },
    "cholesterol": { loinc: "2093-3", unit: "mg/dL", refLow: 125, refHigh: 200 }
};

export function validateResult(testCode, inputValue, inputUnitRaw) {
    if (!TEST_CATALOG[testCode]) {
        throw new Error(`Unknown test code: ${testCode}`);
    }

    const testMeta = TEST_CATALOG[testCode];
    const normalizedUnit = normalizeUnit(inputUnitRaw);

    if (!normalizedUnit) {
        throw new Error(`Unrecognized unit: ${inputUnitRaw}`);
    }

    let converted;
    try {
        converted = convertIfNeeded(inputValue, normalizedUnit, testMeta.unit);
    } catch (err) {
        throw new Error(`Conversion failed: ${err.message}`);
    }

    const finalValue = converted.value;
    const unit = testMeta.unit;
    const isAbnormal = finalValue < testMeta.refLow || finalValue > testMeta.refHigh;

    return {
        testCode,
        loinc: testMeta.loinc,
        value: finalValue,
        unit,
        refRange: `${testMeta.refLow} – ${testMeta.refHigh} ${unit}`,
        abnormalFlag: isAbnormal ? "H/L" : "N",
        conversionNote: converted.note
    };
}
