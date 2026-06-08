"use strict";

/**
 * In-memory data store.
 *
 * Everything lives in plain Maps so the mock has zero external dependencies and
 * resets cleanly between test runs (see POST /__admin/reset in server.js).
 */

// jobOfferId -> internal offer object
//   { id, companyId, title, status, location, compensation,
//     createdAt, updatedAt, publishedAt, closedAt,
//     workflowConfig, history: [], _seq }
const offers = new Map();

// companyId -> { approvalRequired, partialSaveEnabled, manualPostingRequired, updatedAt }
const configs = new Map();

// Monotonic counter used as a deterministic tie-breaker for sorting by date.
let seq = 0;

const DEFAULT_CONFIG = {
  approvalRequired: false,
  partialSaveEnabled: false,
  manualPostingRequired: false,
};

function nextSeq() {
  return ++seq;
}

/**
 * Returns the configuration for a company. If none was ever set we return the
 * documented defaults (all flags false) so reads always succeed for a valid
 * company in its own context.
 */
function getConfig(companyId) {
  if (configs.has(companyId)) return configs.get(companyId);
  return { companyId, ...DEFAULT_CONFIG, updatedAt: new Date().toISOString() };
}

function setConfig(companyId, partial) {
  const current = getConfig(companyId);
  const updated = {
    companyId,
    approvalRequired:
      partial.approvalRequired ?? current.approvalRequired,
    partialSaveEnabled:
      partial.partialSaveEnabled ?? current.partialSaveEnabled,
    manualPostingRequired:
      partial.manualPostingRequired ?? current.manualPostingRequired,
    updatedAt: new Date().toISOString(),
  };
  configs.set(companyId, updated);
  return updated;
}

function reset() {
  offers.clear();
  configs.clear();
  seq = 0;
}

module.exports = {
  offers,
  configs,
  DEFAULT_CONFIG,
  nextSeq,
  getConfig,
  setConfig,
  reset,
};
