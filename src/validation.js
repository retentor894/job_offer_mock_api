"use strict";

/**
 * Request-body validation and completeness rules.
 *
 * Two distinct concepts (kept separate on purpose):
 *
 *  - validateOfferBody(): structural validation of the payload. Failures map to
 *    HTTP 422 (ValidationError with fieldErrors). Examples: missing title,
 *    CUSTOM location without an address, negative salary amount.
 *
 *  - isComplete() / missingForCompleteness(): whether an offer has everything
 *    required to be *published*. Used by the state machine (submit/finalize) to
 *    decide between TO_FINALIZE and forward progression / INCOMPLETE_OFFER.
 */

// Accept any well-formed UUID (8-4-4-4-12 hex). We intentionally do NOT enforce
// the RFC-4122 version/variant nibbles: the spec only says `format: uuid`, and
// being stricter than the contract caused valid IDs to be rejected.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COUNTRY_RE = /^[A-Z]{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const LOCATION_TYPES = ["COMPANY_ADDRESS", "CUSTOM"];
const SALARY_TYPES = ["HOURLY", "DAILY", "MONTHLY", "YEARLY"];
const BONUS_TYPES = ["SIGNING", "PERFORMANCE", "ANNUAL", "OTHER"];

function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Validate an optional string field's type and max length.
 * Absent (`undefined`) is allowed; an explicit `null` is rejected because none
 * of these fields are declared `nullable` in the contract.
 */
function strField(value, field, maxLength, errors) {
  if (value === undefined) return;
  if (typeof value !== "string") {
    errors.push({ field, message: "must be a string", rejectedValue: value });
  } else if (maxLength && value.length > maxLength) {
    errors.push({ field, message: `size must be <= ${maxLength}`, rejectedValue: value });
  }
}

/**
 * Structural validation of a create/update payload against the OpenAPI contract.
 * Returns a list of field errors (empty = valid); a non-empty list maps to 422.
 *
 * @param {object} body
 * @param {{ isCreate: boolean }} opts
 */
function validateOfferBody(body, { isCreate }) {
  const errors = [];
  if (!isPlainObject(body)) {
    return [{ field: "(root)", message: "must be an object", rejectedValue: body }];
  }

  // --- title ---------------------------------------------------------------
  // `undefined` = absent (required only on create); any present value, including
  // an explicit `null`, must be a non-blank string within bounds.
  if (body.title === undefined) {
    if (isCreate) errors.push({ field: "title", message: "must not be blank" });
  } else if (typeof body.title !== "string" || body.title.trim().length === 0) {
    errors.push({ field: "title", message: "must not be blank", rejectedValue: body.title });
  } else if (body.title.length > 200) {
    errors.push({ field: "title", message: "size must be between 1 and 200", rejectedValue: body.title });
  }

  // --- location ------------------------------------------------------------
  if (body.location === undefined) {
    if (isCreate) errors.push({ field: "location", message: "must not be null" });
  } else {
    validateLocation(body.location, errors); // handles null / non-object
  }

  // --- compensation --------------------------------------------------------
  if (body.compensation !== undefined) {
    validateCompensation(body.compensation, errors); // handles null / non-object
  }

  return errors;
}

function validateLocation(loc, errors) {
  if (!isPlainObject(loc)) {
    errors.push({ field: "location", message: "must be an object", rejectedValue: loc });
    return;
  }
  if (!LOCATION_TYPES.includes(loc.type)) {
    errors.push({
      field: "location.type",
      message: "must be one of [COMPANY_ADDRESS, CUSTOM]",
      rejectedValue: loc.type,
    });
  }
  const custom = loc.type === "CUSTOM";
  if (custom && (loc.address === undefined || loc.address === null)) {
    errors.push({ field: "location.address", message: "must not be null when location type is CUSTOM" });
  } else if (loc.address !== undefined && loc.address !== null) {
    validateAddress(loc.address, errors, custom);
  }
}

function validateAddress(addr, errors, custom) {
  if (!isPlainObject(addr)) {
    errors.push({ field: "location.address", message: "must be an object", rejectedValue: addr });
    return;
  }

  // lines: array (max 3) of strings (max 100 chars each)
  if (addr.lines !== undefined) {
    if (!Array.isArray(addr.lines)) {
      errors.push({ field: "location.address.lines", message: "must be an array", rejectedValue: addr.lines });
    } else {
      if (addr.lines.length > 3) {
        errors.push({ field: "location.address.lines", message: "size must be between 0 and 3" });
      }
      addr.lines.forEach((line, i) => strField(line, `location.address.lines[${i}]`, 100, errors));
    }
  }

  strField(addr.postalCode, "location.address.postalCode", 20, errors);
  strField(addr.region, "location.address.region", 100, errors);
  strField(addr.city, "location.address.city", 100, errors);

  if (addr.countryCode !== undefined && addr.countryCode !== null) {
    if (typeof addr.countryCode !== "string" || !COUNTRY_RE.test(addr.countryCode)) {
      errors.push({
        field: "location.address.countryCode",
        message: "must match pattern '^[A-Z]{2}$'",
        rejectedValue: addr.countryCode,
      });
    }
  }

  // CUSTOM completeness: city & countryCode must be present and non-blank.
  if (custom) {
    if (addr.city === undefined || addr.city === null || (typeof addr.city === "string" && addr.city.trim() === "")) {
      errors.push({ field: "location.address.city", message: "must not be blank", rejectedValue: addr.city });
    }
    if (addr.countryCode === undefined || addr.countryCode === null || addr.countryCode === "") {
      errors.push({ field: "location.address.countryCode", message: "must not be blank", rejectedValue: addr.countryCode });
    }
  }
}

function validateCompensation(comp, errors) {
  if (!isPlainObject(comp)) {
    errors.push({ field: "compensation", message: "must be an object", rejectedValue: comp });
    return;
  }
  validateEntries(comp.salaryEntries, "salaryEntries", SALARY_TYPES, errors);
  validateEntries(comp.bonusEntries, "bonusEntries", BONUS_TYPES, errors);
}

function validateEntries(entries, key, types, errors) {
  if (entries === undefined) return;
  if (!Array.isArray(entries)) {
    errors.push({ field: `compensation.${key}`, message: "must be an array", rejectedValue: entries });
    return;
  }
  entries.forEach((entry, i) => {
    const base = `compensation.${key}[${i}]`;
    if (!isPlainObject(entry)) {
      errors.push({ field: base, message: "must be an object", rejectedValue: entry });
      return;
    }
    if (!types.includes(entry.type)) {
      errors.push({ field: `${base}.type`, message: `must be one of [${types.join(", ")}]`, rejectedValue: entry.type });
    }
    if (typeof entry.amount !== "number") {
      errors.push({ field: `${base}.amount`, message: "must be a number", rejectedValue: entry.amount });
    } else if (entry.amount < 0) {
      errors.push({ field: `${base}.amount`, message: "must be greater than or equal to 0", rejectedValue: entry.amount });
    }
    if (typeof entry.currency !== "string" || !CURRENCY_RE.test(entry.currency)) {
      errors.push({ field: `${base}.currency`, message: "must match pattern '^[A-Z]{3}$'", rejectedValue: entry.currency });
    }
    if (key === "bonusEntries") {
      strField(entry.description, `${base}.description`, 200, errors);
    }
  });
}

/** Fields still missing for the offer to be publishable. */
function missingForCompleteness(offer) {
  const missing = [];
  if (!offer.title || offer.title.trim().length === 0) missing.push("title");
  if (!offer.location || !offer.location.type) {
    missing.push("location");
  } else if (offer.location.type === "CUSTOM") {
    const a = offer.location.address;
    if (!a || !a.city || !a.countryCode) missing.push("location");
  }
  const salary = offer.compensation?.salaryEntries;
  if (!Array.isArray(salary) || salary.length === 0) {
    missing.push("compensation");
  }
  return missing;
}

function isComplete(offer) {
  return missingForCompleteness(offer).length === 0;
}

module.exports = {
  isUuid,
  validateOfferBody,
  isComplete,
  missingForCompleteness,
};
