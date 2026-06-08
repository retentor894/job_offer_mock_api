"use strict";

/**
 * Job offer state machine.
 *
 * The pipeline is linear; optional states are skipped when their company-config
 * flag is disabled:
 *
 *   DRAFT → [TO_FINALIZE] → [TO_APPROVE] → [TO_POST] → PUBLISHED → CLOSED
 *            partialSave      approval       manualPosting
 *
 * Each offer carries a *snapshot* of the company configuration taken at creation
 * time (offer.workflowConfig), so config changes never affect existing offers.
 */

const STATUS = {
  DRAFT: "DRAFT",
  TO_FINALIZE: "TO_FINALIZE",
  TO_APPROVE: "TO_APPROVE",
  TO_POST: "TO_POST",
  PUBLISHED: "PUBLISHED",
  CLOSED: "CLOSED",
};

const ACTIONS = [
  "submit",
  "finalize",
  "approve",
  "reject",
  "post",
  "close",
  "reopen",
  "withdraw",
];

// Forward pipeline used to compute the next concrete state.
const PIPELINE = [
  STATUS.DRAFT,
  STATUS.TO_FINALIZE,
  STATUS.TO_APPROVE,
  STATUS.TO_POST,
  STATUS.PUBLISHED,
];

// Optional states gated by a config flag.
const OPTIONAL_FLAG = {
  [STATUS.TO_FINALIZE]: "partialSaveEnabled",
  [STATUS.TO_APPROVE]: "approvalRequired",
  [STATUS.TO_POST]: "manualPostingRequired",
};

// Which actions are valid from each state (before config is considered).
const ALLOWED_ACTIONS = {
  [STATUS.DRAFT]: ["submit"],
  [STATUS.TO_FINALIZE]: ["finalize", "withdraw"],
  [STATUS.TO_APPROVE]: ["approve", "reject", "withdraw"],
  [STATUS.TO_POST]: ["post", "withdraw"],
  [STATUS.PUBLISHED]: ["close"],
  [STATUS.CLOSED]: ["reopen"],
};

/**
 * Given a state, return the next reachable state in the forward pipeline,
 * skipping disabled optional states. PUBLISHED has no flag, so it always stops
 * the search.
 */
function nextForwardState(from, config) {
  let i = PIPELINE.indexOf(from) + 1;
  while (i < PIPELINE.length) {
    const candidate = PIPELINE[i];
    const flag = OPTIONAL_FLAG[candidate];
    if (!flag || config[flag]) return candidate;
    i++;
  }
  return STATUS.PUBLISHED;
}

/** Resolve the target state for a forward/lifecycle action. */
function targetStatusFor(action, currentStatus, config) {
  switch (action) {
    case "submit": // from DRAFT
    case "finalize": // from TO_FINALIZE
    case "approve": // from TO_APPROVE
      return nextForwardState(currentStatus, config);
    case "post":
      return STATUS.PUBLISHED;
    case "reject":
    case "withdraw":
      return STATUS.DRAFT;
    case "close":
      return STATUS.CLOSED;
    case "reopen":
      return STATUS.PUBLISHED;
    default:
      return null;
  }
}

/** Is `action` valid from `currentStatus`? (ignores body requirements) */
function isActionAllowed(action, currentStatus) {
  return (ALLOWED_ACTIONS[currentStatus] || []).includes(action);
}

/** The list of actions valid from the current state. */
function validActionsFrom(currentStatus) {
  return ALLOWED_ACTIONS[currentStatus] || [];
}

/**
 * Build the AvailableTransitions payload (action + resolved targetStatus +
 * requiresReason) for the GET /transitions endpoint and the embedded
 * `availableTransitions` field.
 */
function availableTransitions(currentStatus, config) {
  return validActionsFrom(currentStatus).map((action) => ({
    action,
    targetStatus: targetStatusFor(action, currentStatus, config),
    requiresReason: action === "reject",
  }));
}

module.exports = {
  STATUS,
  ACTIONS,
  ALLOWED_ACTIONS,
  nextForwardState,
  targetStatusFor,
  isActionAllowed,
  validActionsFrom,
  availableTransitions,
};
