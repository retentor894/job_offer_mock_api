"use strict";

/**
 * Smoke test: drives the mock API in-process and asserts one representative
 * case per area from the QA test matrix. Run with: npm test
 *
 * This is NOT the deliverable test suite — it only proves the mock behaves the
 * way the test cases expect, so the real collection can be written against it.
 */

const http = require("http");
const app = require("../src/server");

const CO_A = "550e8400-e29b-41d4-a716-446655440000";
const CO_B = "660e8400-e29b-41d4-a716-446655440111";

let server, base;
let pass = 0,
  fail = 0;

function ok(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

async function req(method, path, { company = CO_A, body, raw } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (company !== null) headers["X-Company-Id"] = company;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : raw,
  });
  let json = null;
  const text = await res.text();
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-json */
  }
  return { status: res.status, json, headers: res.headers };
}

const completeOffer = {
  title: "Senior Backend Developer",
  location: {
    type: "CUSTOM",
    address: { city: "Paris", countryCode: "FR" },
  },
  compensation: { salaryEntries: [{ type: "YEARLY", amount: 65000, currency: "EUR" }] },
};

async function createOffer(overrides = {}, company = CO_A) {
  const r = await req("POST", "/api/v1/job-offers", {
    company,
    body: { ...completeOffer, ...overrides },
  });
  return r;
}

async function setConfig(company, cfg) {
  return req("PUT", `/api/v1/companies/${company}/configuration`, { company, body: cfg });
}

async function transition(id, action, body, company = CO_A) {
  return req("POST", `/api/v1/job-offers/${id}/transitions/${action}`, { company, body: body || {} });
}

async function run() {
  await fetch(base.replace("/api/v1", "") + "/__admin/reset", { method: "POST" });

  // ---- HDR ----
  ok("HDR-001 list valid", (await req("GET", "/api/v1/job-offers")).status === 200);
  ok("HDR-002 missing header 401", (await req("GET", "/api/v1/job-offers", { company: null })).status === 401);
  ok("HDR-003 invalid uuid 400", (await req("GET", "/api/v1/job-offers", { company: "nope" })).status === 400);
  const hdr4 = await req("GET", "/api/v1/job-offers?size=101");
  ok("HDR-004 error contract", hdr4.status === 400 && hdr4.json.code && hdr4.json.message);

  // ---- CRUD ----
  const created = await createOffer();
  ok("CRUD-001 create 201 DRAFT", created.status === 201 && created.json.status === "DRAFT");
  ok("CRUD-002 Location header", !!created.headers.get("location"));
  const id = created.json.id;
  ok("CRUD-003 get 200", (await req("GET", `/api/v1/job-offers/${id}`)).status === 200);
  const upd = await req("PUT", `/api/v1/job-offers/${id}`, { body: { title: "New Title" } });
  ok("CRUD-004 update DRAFT 200", upd.status === 200 && upd.json.title === "New Title");

  const toDelete = await createOffer();
  ok("CRUD-005 delete DRAFT 204", (await req("DELETE", `/api/v1/job-offers/${toDelete.json.id}`)).status === 204);
  ok("CRUD-006 get deleted 404", (await req("GET", `/api/v1/job-offers/${toDelete.json.id}`)).status === 404);

  // published offer for 409 cases
  const pub = await createOffer();
  await transition(pub.json.id, "submit"); // all flags off -> PUBLISHED
  ok("CRUD-007 update PUBLISHED 409", (await req("PUT", `/api/v1/job-offers/${pub.json.id}`, { body: { title: "x" } })).status === 409);
  ok("CRUD-008 delete PUBLISHED 409", (await req("DELETE", `/api/v1/job-offers/${pub.json.id}`)).status === 409);

  // ---- VAL (422) ----
  ok("VAL-001 no title", (await createOffer({ title: undefined })).status === 422);
  ok("VAL-002 empty title", (await createOffer({ title: "" })).status === 422);
  ok("VAL-003 title >200", (await createOffer({ title: "a".repeat(201) })).status === 422);
  ok("VAL-004 CUSTOM no address", (await createOffer({ location: { type: "CUSTOM" } })).status === 422);
  ok("VAL-005 CUSTOM no city", (await createOffer({ location: { type: "CUSTOM", address: { countryCode: "FR" } } })).status === 422);
  ok("VAL-006 bad country", (await createOffer({ location: { type: "CUSTOM", address: { city: "Paris", countryCode: "France" } } })).status === 422);
  ok("VAL-007 negative salary", (await createOffer({ compensation: { salaryEntries: [{ type: "YEARLY", amount: -1, currency: "EUR" }] } })).status === 422);
  ok("VAL-008 bad currency", (await createOffer({ compensation: { salaryEntries: [{ type: "YEARLY", amount: 1, currency: "EU" }] } })).status === 422);

  // ---- STM ----
  const s1 = await createOffer();
  const s1r = await transition(s1.json.id, "submit");
  ok("STM-001 simple -> PUBLISHED", s1r.status === 200 && s1r.json.status === "PUBLISHED");
  const s2r = await transition(s1.json.id, "close");
  ok("STM-002 close -> CLOSED", s2r.json.status === "CLOSED");
  const s3r = await transition(s1.json.id, "reopen");
  ok("STM-003 reopen -> PUBLISHED", s3r.json.status === "PUBLISHED");

  // full workflow, all flags on
  await setConfig(CO_B, { approvalRequired: true, partialSaveEnabled: true, manualPostingRequired: true });
  const full = await createOffer({}, CO_B);
  const seq = [];
  seq.push((await transition(full.json.id, "submit", {}, CO_B)).json.status);
  seq.push((await transition(full.json.id, "finalize", {}, CO_B)).json.status);
  seq.push((await transition(full.json.id, "approve", {}, CO_B)).json.status);
  seq.push((await transition(full.json.id, "post", {}, CO_B)).json.status);
  seq.push((await transition(full.json.id, "close", {}, CO_B)).json.status);
  ok("STM-004 full workflow", JSON.stringify(seq) === JSON.stringify(["TO_FINALIZE", "TO_APPROVE", "TO_POST", "PUBLISHED", "CLOSED"]), seq.join(","));

  // reject -> DRAFT (approvalRequired)
  await setConfig(CO_A, { approvalRequired: true, partialSaveEnabled: false, manualPostingRequired: false });
  const rej = await createOffer();
  await transition(rej.json.id, "submit"); // -> TO_APPROVE
  const rejR = await transition(rej.json.id, "reject", { reason: "budget" });
  ok("STM-005 reject -> DRAFT", rejR.json.status === "DRAFT");

  // manual posting: approve -> TO_POST
  await setConfig(CO_A, { approvalRequired: true, manualPostingRequired: true });
  const mp = await createOffer();
  await transition(mp.json.id, "submit"); // -> TO_APPROVE
  const mpR = await transition(mp.json.id, "approve");
  ok("STM-006 approve -> TO_POST", mpR.json.status === "TO_POST");

  // partial save: submit -> TO_FINALIZE
  await setConfig(CO_A, { approvalRequired: false, partialSaveEnabled: true, manualPostingRequired: false });
  const ps = await createOffer();
  const psR = await transition(ps.json.id, "submit");
  ok("STM-007 submit -> TO_FINALIZE", psR.json.status === "TO_FINALIZE");

  // withdraw from TO_APPROVE -> DRAFT
  await setConfig(CO_A, { approvalRequired: true, partialSaveEnabled: false, manualPostingRequired: false });
  const wd = await createOffer();
  await transition(wd.json.id, "submit");
  const wdR = await transition(wd.json.id, "withdraw");
  ok("STM-008 withdraw -> DRAFT", wdR.json.status === "DRAFT");

  // ---- TRN ----
  await setConfig(CO_A, { approvalRequired: false, partialSaveEnabled: false, manualPostingRequired: false });
  const t1 = await createOffer();
  ok("TRN-001 approve from DRAFT 400", (await transition(t1.json.id, "approve")).status === 400);
  ok("TRN-002 post before approval 400", (await transition(t1.json.id, "post")).status === 400);
  ok("TRN-003 close DRAFT 400", (await transition(t1.json.id, "close")).status === 400);

  await setConfig(CO_A, { approvalRequired: true });
  const t4 = await createOffer();
  await transition(t4.json.id, "submit");
  ok("TRN-004 reject no reason 422", (await transition(t4.json.id, "reject", {})).status === 422);

  await setConfig(CO_A, { approvalRequired: false, partialSaveEnabled: false, manualPostingRequired: false });
  const t5 = await createOffer({ compensation: undefined }); // incomplete
  const t5R = await transition(t5.json.id, "submit");
  ok("TRN-005 incomplete submit 422", t5R.status === 422 && t5R.json.code === "INCOMPLETE_OFFER", t5R.json && t5R.json.code);

  const t6 = await createOffer();
  const t6R = await req("GET", `/api/v1/job-offers/${t6.json.id}/transitions`);
  ok("TRN-006 available transitions", t6R.status === 200 && Array.isArray(t6R.json.transitions));

  // ---- MTN ----
  const ownA = await createOffer({}, CO_A);
  await createOffer({ title: "B offer" }, CO_B);
  const listA = await req("GET", "/api/v1/job-offers", { company: CO_A });
  ok("MTN-001 only own offers", listA.json.content.every((o) => o.companyId === CO_A));
  ok("MTN-002 cross get 404", (await req("GET", `/api/v1/job-offers/${ownA.json.id}`, { company: CO_B })).status === 404);
  ok("MTN-003 cross put 404", (await req("PUT", `/api/v1/job-offers/${ownA.json.id}`, { company: CO_B, body: { title: "x" } })).status === 404);
  ok("MTN-004 cross delete 404", (await req("DELETE", `/api/v1/job-offers/${ownA.json.id}`, { company: CO_B })).status === 404);

  // ---- LST ----
  await fetch(base.replace("/api/v1", "") + "/__admin/reset", { method: "POST" });
  await setConfig(CO_A, {});
  await createOffer({ title: "backend engineer", location: { type: "CUSTOM", address: { city: "Paris", countryCode: "FR" } } });
  await createOffer({ title: "frontend dev", location: { type: "CUSTOM", address: { city: "Lyon", countryCode: "FR" } } });
  const pg = await req("GET", "/api/v1/job-offers?page=0&size=20");
  ok("LST-001 pagination meta", ["content", "page", "size", "totalElements", "totalPages"].every((k) => k in pg.json));
  const fStatus = await req("GET", "/api/v1/job-offers?status=DRAFT");
  ok("LST-002 filter status", fStatus.json.content.every((o) => o.status === "DRAFT"));
  const fTitle = await req("GET", "/api/v1/job-offers?titleContains=backend");
  ok("LST-003 filter title", fTitle.json.content.length === 1 && fTitle.json.content[0].title.includes("backend"));
  const fCity = await req("GET", "/api/v1/job-offers?locationCity=paris");
  ok("LST-004 filter city", fCity.json.content.length === 1 && fCity.json.content[0].locationCity === "Paris");
  const sorted = await req("GET", "/api/v1/job-offers?sort=-createdAt");
  ok("LST-005 sort desc", new Date(sorted.json.content[0].createdAt) >= new Date(sorted.json.content[1].createdAt));
  ok("LST-006 invalid size 400", (await req("GET", "/api/v1/job-offers?size=101")).status === 400);
  ok("LST-007 invalid sort 400", (await req("GET", "/api/v1/job-offers?sort=salary")).status === 400);

  // ---- CFG ----
  ok("CFG-001 get config 200", (await req("GET", `/api/v1/companies/${CO_A}/configuration`)).status === 200);
  const cfgUpd = await setConfig(CO_A, { approvalRequired: true });
  ok("CFG-002 update config", cfgUpd.status === 200 && cfgUpd.json.approvalRequired === true);
  // new offers use updated workflow
  const newOffer = await createOffer();
  const newOfferTr = await transition(newOffer.json.id, "submit");
  ok("CFG-003 new workflow applied", newOfferTr.json.status === "TO_APPROVE");
  // existing offers keep old workflow
  await setConfig(CO_A, { approvalRequired: false });
  const exTr = await transition(newOffer.json.id, "withdraw"); // back to DRAFT, still approval workflow
  const exTr2 = await transition(newOffer.json.id, "submit");
  ok("CFG-004 existing keeps workflow", exTr2.json.status === "TO_APPROVE", exTr2.json.status);
  ok("CFG-005 cross config 403", (await req("GET", `/api/v1/companies/${CO_B}/configuration`, { company: CO_A })).status === 403);

  // ---- HIS ----
  await setConfig(CO_A, { approvalRequired: true });
  const h = await createOffer();
  await transition(h.json.id, "submit");
  await transition(h.json.id, "reject", { reason: "needs revision" });
  const hist = await req("GET", `/api/v1/job-offers/${h.json.id}/history`);
  ok("HIS-001 history array", hist.status === 200 && Array.isArray(hist.json));
  ok("HIS-002 submit entry", hist.json.some((e) => e.action === "submit"));
  ok("HIS-003 reject reason stored", hist.json.some((e) => e.action === "reject" && e.reason === "needs revision"));
  const times = hist.json.map((e) => new Date(e.performedAt).getTime());
  ok("HIS-004 chronological", times.every((t, i) => i === 0 || t >= times[i - 1]));

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail === 0 ? 0 : 1);
}

server = http.createServer(app).listen(0, () => {
  base = `http://localhost:${server.address().port}`;
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
});
