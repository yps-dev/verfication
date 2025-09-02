// validateResult/ucum-utils.js
// Lightweight UCUM normalization + a few conversions (extend this list as needed)

const canonical = {
    "g/dl": "g/dL",
    "gdL": "g/dL",
    "g/L": "g/L",
    "gl": "g/L",
    "mg/dl": "mg/dL",
    "mg/dL": "mg/dL",
    "mmol/l": "mmol/L",
    "mmol/L": "mmol/L",
    "iu/l": "IU/L",
    "%": "%",
    "percent": "%"
};

export function normalizeUnit(u) {
    if (!u) return null;
    const key = String(u).trim().toLowerCase();
    return canonical[key] || null;
}

// convertIfNeeded(value, fromUnitCanonical, toUnitCanonical)
export function convertIfNeeded(value, fromUnit, toUnit) {
    if (fromUnit === toUnit) return { value, note: null };

    // g/dL <-> g/L
    if (fromUnit === "g/dL" && toUnit === "g/L") return { value: value * 10, note: "g/dL->g/L" };
    if (fromUnit === "g/L" && toUnit === "g/dL") return { value: value / 10, note: "g/L->g/dL" };

    // mg/dL <-> g/L  (1 mg/dL = 0.01 g/L)
    if (fromUnit === "mg/dL" && toUnit === "g/L") return { value: value * 0.01, note: "mg/dL->g/L" };
    if (fromUnit === "g/L" && toUnit === "mg/dL") return { value: value / 0.01, note: "g/L->mg/dL" };

    // mg/dL <-> mmol/L (glucose factor)
    const GLUCOSE_FACTOR = 18.0182;
    if (fromUnit === "mg/dL" && toUnit === "mmol/L") return { value: value / GLUCOSE_FACTOR, note: "mg/dL->mmol/L (glucose factor 18.0182)" };
    if (fromUnit === "mmol/L" && toUnit === "mg/dL") return { value: value * GLUCOSE_FACTOR, note: "mmol/L->mg/dL (glucose factor 18.0182)" };

    // IU/L or percent conversions: no conversion
    if (fromUnit === "IU/L" && toUnit === "IU/L") return { value, note: null };

    throw new Error(`Unsupported conversion ${fromUnit} -> ${toUnit}`);
}
