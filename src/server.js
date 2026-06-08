"use strict";

const crypto = require("crypto");
const express = require("express");

const store = require("./store");
const sm = require("./stateMachine");
const {
  isUuid,
  validateOfferBody,
  isComplete,
  missingForCompleteness,
} = require("./validation");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const BASE = "/api/v1";

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function error(res, status, code, message, details) {
  const body = { code, message, traceId: crypto.randomUUID() };
  if (details) body.details = details;
  return res.status(status).json(body);
}

function validationError(res, fieldErrors, message = "Request validation failed") {
  return res.status(422).json({
    code: "VALIDATION_ERROR",
    message,
    fieldErrors,
  });
}

const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

function toJobOffer(offer) {
  const config = offer.workflowConfig;
  return {
    id: offer.id,
    companyId: offer.companyId,
    title: offer.title,
    status: offer.status,
    location: offer.location,
    compensation: offer.compensation,
    createdAt: offer.createdAt,
    updatedAt: offer.updatedAt,
    publishedAt: offer.publishedAt ?? null,
    closedAt: offer.closedAt ?? null,
    availableTransitions: sm
      .availableTransitions(offer.status, config)
      .map((t) => t.action),
    isComplete: isComplete(offer),
  };
}

function toSummary(offer) {
  return {
    id: offer.id,
    companyId: offer.companyId,
    title: offer.title,
    status: offer.status,
    locationCity: offer.location?.address?.city ?? null,
    createdAt: offer.createdAt,
    publishedAt: offer.publishedAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Multi-tenancy middleware: validate X-Company-Id on every API request.
//   missing  -> 401   |   present but not a UUID -> 400   |   valid -> req.companyId
// ---------------------------------------------------------------------------

const router = express.Router();

router.use((req, res, next) => {
  const header = req.get("X-Company-Id");
  if (!header) {
    return error(res, 401, "UNAUTHORIZED", "Missing required header: X-Company-Id");
  }
  if (!isUuid(header)) {
    return error(
      res,
      400,
      "BAD_REQUEST",
      "Invalid X-Company-Id header: must be a UUID",
      { rejectedValue: header }
    );
  }
  req.companyId = header;
  next();
});

/** Fetch an offer scoped to the caller's company. Returns null if not visible. */
function findOwnedOffer(req) {
  const offer = store.offers.get(req.params.jobOfferId);
  if (!offer || offer.companyId !== req.companyId) return null;
  return offer;
}

function notFound(res, id) {
  return error(res, 404, "NOT_FOUND", `Job offer not found: ${id}`);
}

// ===========================================================================
// /job-offers  — list & create
// ===========================================================================

const SORT_FIELDS = {
  createdAt: "createdAt",
  updatedAt: "updatedAt",
  title: "title",
  publishedAt: "publishedAt",
};
const ALLOWED_SORT = [
  "createdAt", "-createdAt",
  "updatedAt", "-updatedAt",
  "title", "-title",
  "publishedAt", "-publishedAt",
];

router.get("/job-offers", (req, res) => {
  // --- pagination params (400 on invalid) ---
  const page = parseIntParam(req.query.page, 0);
  const size = parseIntParam(req.query.size, 20);
  if (page === null || page < 0) {
    return error(res, 400, "BAD_REQUEST", `Invalid page parameter: '${req.query.page}'`);
  }
  if (size === null || size < 1 || size > 100) {
    return error(res, 400, "BAD_REQUEST", `Invalid size parameter: '${req.query.size}' (allowed 1-100)`);
  }

  // --- sort param (400 on invalid) ---
  const sortParam = req.query.sort || "-createdAt";
  if (!ALLOWED_SORT.includes(sortParam)) {
    return error(res, 400, "BAD_REQUEST", `Invalid sort parameter: '${sortParam}'`);
  }
  const desc = sortParam.startsWith("-");
  const sortField = SORT_FIELDS[desc ? sortParam.slice(1) : sortParam];

  // --- filters ---
  const statuses = normalizeArray(req.query.status);
  const titleContains = req.query.titleContains?.toLowerCase();
  const locationCity = req.query.locationCity?.toLowerCase();

  let items = [...store.offers.values()].filter((o) => o.companyId === req.companyId);

  if (statuses.length) items = items.filter((o) => statuses.includes(o.status));
  if (titleContains) {
    items = items.filter(
      (o) => typeof o.title === "string" && o.title.toLowerCase().includes(titleContains)
    );
  }
  if (locationCity) {
    items = items.filter((o) => {
      const city = o.location?.address?.city;
      return typeof city === "string" && city.toLowerCase().includes(locationCity);
    });
  }

  // createdAfter (inclusive) / createdBefore (exclusive) — per the contract.
  const after = Date.parse(req.query.createdAfter ?? "");
  if (!Number.isNaN(after)) {
    items = items.filter((o) => new Date(o.createdAt).getTime() >= after);
  }
  const before = Date.parse(req.query.createdBefore ?? "");
  if (!Number.isNaN(before)) {
    items = items.filter((o) => new Date(o.createdAt).getTime() < before);
  }

  // --- sort (with deterministic _seq tie-breaker) ---
  items.sort((a, b) => compareBy(a, b, sortField, desc));

  // --- paginate ---
  const totalElements = items.length;
  const totalPages = size > 0 ? Math.ceil(totalElements / size) : 0;
  const start = page * size;
  const content = items.slice(start, start + size).map(toSummary);

  res.json({ content, page, size, totalElements, totalPages });
});

router.post("/job-offers", (req, res) => {
  const body = req.body || {};

  const fieldErrors = validateOfferBody(body, { isCreate: true });
  if (fieldErrors.length) return validationError(res, fieldErrors);

  const config = store.getConfig(req.companyId);
  const id = crypto.randomUUID();
  const ts = now();

  const offer = {
    id,
    companyId: req.companyId,
    title: body.title,
    status: sm.STATUS.DRAFT,
    location: body.location,
    compensation: body.compensation,
    createdAt: ts,
    updatedAt: ts,
    publishedAt: null,
    closedAt: null,
    // Snapshot the workflow so later config changes don't affect this offer.
    workflowConfig: {
      approvalRequired: config.approvalRequired,
      partialSaveEnabled: config.partialSaveEnabled,
      manualPostingRequired: config.manualPostingRequired,
    },
    history: [],
    _seq: store.nextSeq(),
  };

  store.offers.set(id, offer);
  res.status(201)
    .location(`${req.protocol}://${req.get("host")}${BASE}/job-offers/${id}`)
    .json(toJobOffer(offer));
});

// ===========================================================================
// /job-offers/{jobOfferId}  — get, update, delete
// ===========================================================================

router.get("/job-offers/:jobOfferId", (req, res) => {
  const offer = findOwnedOffer(req);
  if (!offer) return notFound(res, req.params.jobOfferId);
  res.json(toJobOffer(offer));
});

const EDITABLE_STATES = [sm.STATUS.DRAFT, sm.STATUS.TO_FINALIZE];

router.put("/job-offers/:jobOfferId", (req, res) => {
  const offer = findOwnedOffer(req);
  if (!offer) return notFound(res, req.params.jobOfferId);

  if (!EDITABLE_STATES.includes(offer.status)) {
    return error(
      res,
      409,
      "INVALID_STATE",
      `Cannot update job offer in ${offer.status} status`,
      { currentStatus: offer.status, allowedStatuses: EDITABLE_STATES }
    );
  }

  const body = req.body || {};
  const fieldErrors = validateOfferBody(body, { isCreate: false });
  if (fieldErrors.length) return validationError(res, fieldErrors);

  if (body.title !== undefined) offer.title = body.title;
  if (body.location !== undefined) offer.location = body.location;
  if (body.compensation !== undefined) offer.compensation = body.compensation;
  offer.updatedAt = now();

  res.json(toJobOffer(offer));
});

router.delete("/job-offers/:jobOfferId", (req, res) => {
  const offer = findOwnedOffer(req);
  if (!offer) return notFound(res, req.params.jobOfferId);

  if (offer.status !== sm.STATUS.DRAFT) {
    return error(
      res,
      409,
      "INVALID_STATE",
      `Cannot delete job offer in ${offer.status} status`,
      { currentStatus: offer.status, allowedStatuses: [sm.STATUS.DRAFT] }
    );
  }

  store.offers.delete(offer.id);
  res.status(204).end();
});

// ===========================================================================
// /job-offers/{jobOfferId}/transitions  — list available transitions
// ===========================================================================

router.get("/job-offers/:jobOfferId/transitions", (req, res) => {
  const offer = findOwnedOffer(req);
  if (!offer) return notFound(res, req.params.jobOfferId);

  res.json({
    currentStatus: offer.status,
    transitions: sm.availableTransitions(offer.status, offer.workflowConfig),
  });
});

// ===========================================================================
// /job-offers/{jobOfferId}/transitions/{action}  — perform a transition
// ===========================================================================

router.post("/job-offers/:jobOfferId/transitions/:action", (req, res) => {
  const offer = findOwnedOffer(req);
  if (!offer) return notFound(res, req.params.jobOfferId);

  const action = req.params.action;
  const body = req.body || {};
  const config = offer.workflowConfig;

  if (!sm.ACTIONS.includes(action)) {
    return error(res, 400, "BAD_REQUEST", `Unknown transition action: '${action}'`);
  }

  // Is this action valid from the current state?
  if (!sm.isActionAllowed(action, offer.status)) {
    return error(
      res,
      400,
      "INVALID_TRANSITION",
      `Cannot perform '${action}' from ${offer.status} status`,
      {
        currentStatus: offer.status,
        requestedAction: action,
        validActions: sm.validActionsFrom(offer.status),
      }
    );
  }

  // reject requires a reason.
  if (action === "reject" && (!body.reason || String(body.reason).trim() === "")) {
    return validationError(
      res,
      [{ field: "reason", message: "must not be blank for reject" }],
      "Transition requirements not met"
    );
  }

  // Completeness gate for submit / finalize.
  if (action === "submit" || action === "finalize") {
    const partialAllowed = config.partialSaveEnabled && action === "submit";
    if (!partialAllowed && !isComplete(offer)) {
      return error(
        res,
        422,
        "INCOMPLETE_OFFER",
        `Cannot ${action} incomplete job offer`,
        { missingFields: missingForCompleteness(offer) }
      );
    }
  }

  const fromStatus = offer.status;
  const toStatus = sm.targetStatusFor(action, offer.status, config);

  offer.status = toStatus;
  offer.updatedAt = now();
  if (toStatus === sm.STATUS.PUBLISHED && !offer.publishedAt) {
    offer.publishedAt = offer.updatedAt;
  }
  if (toStatus === sm.STATUS.CLOSED) {
    offer.closedAt = offer.updatedAt;
  }

  offer.history.push({
    id: crypto.randomUUID(),
    fromStatus,
    toStatus,
    action,
    performedAt: offer.updatedAt,
    performedBy: req.companyId,
    reason: body.reason ?? null,
    comment: body.comment ?? null,
  });

  res.json(toJobOffer(offer));
});

// ===========================================================================
// /job-offers/{jobOfferId}/history
// ===========================================================================

router.get("/job-offers/:jobOfferId/history", (req, res) => {
  const offer = findOwnedOffer(req);
  if (!offer) return notFound(res, req.params.jobOfferId);

  const history = [...offer.history].sort(
    (a, b) => new Date(a.performedAt) - new Date(b.performedAt)
  );
  res.json(history);
});

// ===========================================================================
// /companies/{companyId}/configuration
// ===========================================================================

router.get("/companies/:companyId/configuration", (req, res) => {
  const { companyId } = req.params;
  // Cross-company access is forbidden (config is not multi-tenant-hidden -> 403).
  if (companyId !== req.companyId) {
    return error(res, 403, "FORBIDDEN", "Not authorized to access this company's configuration");
  }
  res.json(store.getConfig(companyId));
});

router.put("/companies/:companyId/configuration", (req, res) => {
  const { companyId } = req.params;
  if (companyId !== req.companyId) {
    return error(res, 403, "FORBIDDEN", "Not authorized to modify this company's configuration");
  }

  const body = req.body || {};
  // The three flags are booleans in the contract. Reject non-booleans with 400
  // (documented for this op) so the stored/returned config always conforms.
  for (const flag of ["approvalRequired", "partialSaveEnabled", "manualPostingRequired"]) {
    if (body[flag] !== undefined && typeof body[flag] !== "boolean") {
      return error(res, 400, "BAD_REQUEST", `Invalid configuration: '${flag}' must be a boolean`, {
        field: flag,
        rejectedValue: body[flag],
      });
    }
  }

  const updated = store.setConfig(companyId, {
    approvalRequired: body.approvalRequired,
    partialSaveEnabled: body.partialSaveEnabled,
    manualPostingRequired: body.manualPostingRequired,
  });
  res.json(updated);
});

// ---------------------------------------------------------------------------
// Mount the API + test helpers
// ---------------------------------------------------------------------------

app.use(BASE, router);

// Test helper (NOT part of the OpenAPI spec): wipe all state between runs.
app.post("/__admin/reset", (req, res) => {
  store.reset();
  res.status(204).end();
});

app.get("/health", (req, res) => res.json({ status: "UP" }));

// JSON parse errors -> 400.
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    return error(res, 400, "BAD_REQUEST", "Malformed JSON request body");
  }
  next(err);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseIntParam(value, fallback) {
  if (value === undefined) return fallback;
  if (!/^-?\d+$/.test(String(value))) return null;
  return parseInt(value, 10);
}

function normalizeArray(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function compareBy(a, b, field, desc) {
  let result;
  if (field === "title") {
    result = (a.title || "").localeCompare(b.title || "");
  } else {
    const av = a[field] ? new Date(a[field]).getTime() : 0;
    const bv = b[field] ? new Date(b[field]).getTime() : 0;
    result = av - bv;
    if (result === 0) result = a._seq - b._seq; // deterministic tie-break
  }
  return desc ? -result : result;
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Job Offer mock API listening on http://localhost:${PORT}${BASE}`);
  });
}

module.exports = app;
