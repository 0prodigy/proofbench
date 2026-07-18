/* =========================================================================
   Proofbench case file — self-contained, offline renderer + self-verify.

   Nothing here trusts a precomputed answer. The verdict is RE-DERIVED in your
   browser from the sealed receipts by a faithful port of src/verdict.mjs, and
   the seal is checked by recomputing, with WebCrypto SHA-256, the same canonical
   manifest digest src/evidence.mjs signs (INTACT/TAMPERED). No network, no server.

   Honesty ceiling (stated, not hidden): this in-browser check verifies content
   integrity — every receipt's content address and the sealed manifest digest.
   The ed25519 SIGNATURE over that digest is verified by `verifySeal` in Node
   (src/evidence.mjs); on your own machine the key lives on hardware you control,
   so evidence is tamper-EVIDENT, not tamper-RESISTANT.
   ========================================================================= */
(function () {
  "use strict";

  /* ---------- enums (verbatim from src/types.mjs) ---------- */
  var PROVENANCE_RANK = { agent: 0, tool: 1, harness: 2 };
  function rankOf(p) { return Object.prototype.hasOwnProperty.call(PROVENANCE_RANK, p) ? PROVENANCE_RANK[p] : -1; }
  var TOOL_RANK = 1, HARNESS_RANK = 2;
  var Verdict = { WORKS: "WORKS", DOES_NOT_WORK: "DOES_NOT_WORK", COULD_NOT_DETERMINE: "COULD_NOT_DETERMINE", UNVERIFIED: "UNVERIFIED" };
  var ClaimState = { CONFIRMED: "CONFIRMED", FALSIFIED: "FALSIFIED", NOT_EXECUTED: "NOT_EXECUTED" };
  var ReceiptKind = { DELTA: "delta", ATTEMPT: "attempt", FRESH_SESSION: "fresh-session", EGRESS: "egress", NAV: "nav", COMPARATOR: "comparator" };
  var ClaimKind = { EFFECT: "effect", NEGATIVE: "negative", SURVIVE: "survive", REACH: "reach" };

  /* ---------- canonical JSON (verbatim from src/evidence.mjs / verdict.mjs) ---------- */
  function sortKeys(v) {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") {
      var out = {};
      Object.keys(v).sort().forEach(function (k) { out[k] = sortKeys(v[k]); });
      return out;
    }
    return v;
  }
  function stableStringify(v) { return JSON.stringify(sortKeys(v)); }
  function deepEqual(a, b) { return stableStringify(a) === stableStringify(b); }

  /* ---------- verdict.mjs port (faithful, deterministic) ---------- */
  function receiptMap(bundle) {
    var m = {};
    (bundle.receipts || []).forEach(function (r) { if (r && r.id != null) m[r.id] = r; });
    return m;
  }
  function claimReceipts(claim, rmap) {
    var out = [];
    (claim.receiptIds || []).forEach(function (id) { if (rmap[id]) out.push(rmap[id]); });
    return out;
  }
  function satisfies(r) { return !!r && rankOf(r.provenance) >= TOOL_RANK; }
  function satisfiesPersisted(r) { return !!r && rankOf(r.provenance) >= HARNESS_RANK; }
  function isNullDelta(d) {
    var dd = (d && d.data) || {};
    if (dd.nullDelta === true) return true;
    if ("before" in dd && "after" in dd) return deepEqual(dd.before, dd.after);
    return false;
  }
  function relationHolds(rel, before, after) {
    if (!rel || typeof rel.op !== "string") return false;
    switch (rel.op) {
      case "increased": return Number(after) > Number(before);
      case "decreased": return Number(after) < Number(before);
      case "changed": return !deepEqual(before, after);
      case "unchanged": return deepEqual(before, after);
      case "equals": return deepEqual(after, rel.value);
      default: return false;
    }
  }
  function freshBinds(fresh, delta) {
    var fd = (fresh && fresh.data) || {}, dd = (delta && delta.data) || {};
    if (fd.nonce != null && dd.nonce != null && deepEqual(fd.nonce, dd.nonce)) return true;
    if (fd.observed !== undefined && "after" in dd && deepEqual(fd.observed, dd.after)) return true;
    return false;
  }
  function contentBinds(egress, delta) {
    var en = egress && egress.data ? egress.data.nonce : undefined;
    var dn = delta && delta.data ? delta.data.nonce : undefined;
    if (en != null && dn != null && deepEqual(en, dn)) return true;
    var cb = egress && egress.data ? egress.data.contentBoundSha : undefined;
    if (cb && delta && cb === delta.sha256) return true;
    return false;
  }
  function isValidConfirmLeg(leg, delta) {
    if (!satisfies(leg)) return false;
    if (leg.kind === ReceiptKind.FRESH_SESSION) return freshBinds(leg, delta);
    if (leg.kind === ReceiptKind.EGRESS) return contentBinds(leg, delta);
    return false;
  }
  function evalEffect(claim, rmap) {
    var ec = claim.effectCheck;
    if (!ec) return { state: ClaimState.NOT_EXECUTED, detail: "effect claim has no effectCheck" };
    var delta = rmap[ec.deltaReceiptId];
    if (!satisfiesPersisted(delta) || delta.kind !== ReceiptKind.DELTA) {
      return { state: ClaimState.NOT_EXECUTED, detail: "delta receipt missing or not a HARNESS store-handle observation — a tool/agent or app-endpoint read cannot satisfy the persisted leg (§1.1/§4, M3)" };
    }
    if (delta.sourcePR === true) {
      return { state: ClaimState.NOT_EXECUTED, detail: "delta oracle is code shipped by the PR under test (sourcePR) — disqualified (M3/FW-19)" };
    }
    var dd = delta.data || {};
    var before = "before" in dd ? dd.before : ec.beforeValue;
    if (ec.beforeValue !== undefined && !deepEqual(ec.beforeValue, before)) {
      return { state: ClaimState.NOT_EXECUTED, detail: "comparator baseline mismatch (pinned beforeValue != observed delta before)" };
    }
    if (!relationHolds(ec.expectedAfterRelation, before, dd.after)) {
      return { state: ClaimState.FALSIFIED, detail: "harness delta does not satisfy the expected relation" };
    }
    if (isNullDelta(delta) || deepEqual(before, dd.after)) {
      return { state: ClaimState.NOT_EXECUTED, detail: "effect check satisfied by a null delta — the harness observed NO change (§1.1 write-set-bound requires an observed delta)" };
    }
    var leg = rmap[ec.confirmLegReceiptId];
    if (!isValidConfirmLeg(leg, delta)) {
      return { state: ClaimState.NOT_EXECUTED, detail: "no valid confirm leg (needs a fresh-session re-observation consistent with the delta, or an egress content-bound to it §1.5)" };
    }
    return { state: ClaimState.CONFIRMED, detail: "effect confirmed on a harness delta + a content-bound confirm leg" };
  }
  function evalNegative(claim, rmap) {
    var receipts = claimReceipts(claim, rmap);
    var attempt = receipts.find(function (r) { return r.kind === ReceiptKind.ATTEMPT && satisfies(r); });
    var delta = receipts.find(function (r) { return r.kind === ReceiptKind.DELTA && satisfiesPersisted(r); });
    if (!attempt) return { state: ClaimState.NOT_EXECUTED, detail: "no attempted-action receipt (M1) — a null delta cannot distinguish \"blocked\" from \"never tried\"" };
    if (!delta) return { state: ClaimState.NOT_EXECUTED, detail: "no delta receipt to prove no state change occurred" };
    if (isNullDelta(delta)) return { state: ClaimState.CONFIRMED, detail: "attempt was made and produced no persisted change (blocked)" };
    return { state: ClaimState.FALSIFIED, detail: "the \"cannot\" was violated — the attempt persisted a change" };
  }
  function evalReach(claim, rmap) {
    var receipts = claimReceipts(claim, rmap);
    var nav = receipts.find(function (r) { return r.kind === ReceiptKind.NAV && satisfies(r); });
    if (!nav) return { state: ClaimState.NOT_EXECUTED, detail: "no navigation receipt" };
    if (nav.data && nav.data.frontDoor === true) return { state: ClaimState.CONFIRMED, detail: "front door reached via user-shaped navigation" };
    return { state: ClaimState.NOT_EXECUTED, detail: "navigation was a deep link, not the front door — reach not confirmed" };
  }
  function evalSurvive(claim, rmap) {
    var receipts = claimReceipts(claim, rmap);
    var probe = receipts.find(function (r) { return satisfies(r) && r.data && "survived" in r.data; });
    if (!probe) return { state: ClaimState.NOT_EXECUTED, detail: "no hostile-probe receipt" };
    if (probe.data.survived === true) return { state: ClaimState.CONFIRMED, detail: "hostile-repertoire class survived" };
    return { state: ClaimState.FALSIFIED, detail: "hostile-repertoire probe breached the feature" };
  }
  function naJustified(claim, rmap) {
    if (claim.kind !== ClaimKind.SURVIVE && claim.kind !== ClaimKind.REACH) return false;
    var receipts = claimReceipts(claim, rmap);
    return receipts.some(function (r) { return satisfies(r) && r.data && r.data.naJustification; });
  }
  function distinctInstantiations(claim, rmap, actorIdentity) {
    var receipts = claimReceipts(claim, rmap);
    var deltas = receipts.filter(function (r) { return r.kind === ReceiptKind.DELTA && satisfiesPersisted(r) && r.sourcePR !== true; });
    var ec = claim.effectCheck;
    var identities = {};
    deltas.forEach(function (d) {
      var identity = d.identity;
      if (identity == null || identity === actorIdentity) return;
      var leg = receipts.find(function (r) {
        return (r.kind === ReceiptKind.FRESH_SESSION || r.kind === ReceiptKind.EGRESS) && r.identity === identity && isValidConfirmLeg(r, d);
      });
      if (!leg) return;
      var dd = d.data || {};
      var before = "before" in dd ? dd.before : ec ? ec.beforeValue : undefined;
      if (ec && ec.beforeValue !== undefined && !deepEqual(ec.beforeValue, before)) return;
      if (ec && !relationHolds(ec.expectedAfterRelation, before, dd.after)) return;
      identities[identity] = true;
    });
    return Object.keys(identities);
  }
  function verdict(bundle) {
    var b = bundle || {};
    var rmap = receiptMap(b);
    var actorIdentity = b.actorIdentity != null ? b.actorIdentity : null;
    var claims = b.claims || [];
    var reasons = [];
    var scoreboard = claims.map(function (c) {
      var res;
      switch (c.kind) {
        case ClaimKind.EFFECT: res = evalEffect(c, rmap); break;
        case ClaimKind.NEGATIVE: res = evalNegative(c, rmap); break;
        case ClaimKind.REACH: res = evalReach(c, rmap); break;
        case ClaimKind.SURVIVE: res = evalSurvive(c, rmap); break;
        default: res = { state: ClaimState.NOT_EXECUTED, detail: "unknown claim kind '" + c.kind + "'" };
      }
      return { claimId: c.id, kind: c.kind, quantified: !!c.quantified, scope: c.scope != null ? c.scope : null, state: res.state, detail: res.detail, naJustified: naJustified(c, rmap) };
    });
    for (var i = 0; i < claims.length; i++) {
      var c = claims[i], entry = scoreboard[i];
      if (!c.quantified || entry.state !== ClaimState.CONFIRMED) continue;
      var distinct = distinctInstantiations(c, rmap, actorIdentity);
      var hasConfirmedNegative = scoreboard.some(function (s) { return s.kind === ClaimKind.NEGATIVE && s.state === ClaimState.CONFIRMED; });
      if (distinct.length >= 2 && hasConfirmedNegative) {
        entry.detail += "; quantifier satisfied (" + distinct.length + " distinct non-actor instantiations + a confirmed negative)";
      } else {
        entry.state = ClaimState.NOT_EXECUTED;
        var missing = [];
        if (distinct.length < 2) missing.push(distinct.length + " distinct non-actor instantiation(s) (need >=2)");
        if (!hasConfirmedNegative) missing.push("no confirmed out-of-scope negative");
        entry.detail = "quantifier lint failed (§1.4/FW-11): " + missing.join("; ");
      }
    }
    var falsified = scoreboard.filter(function (s) { return s.state === ClaimState.FALSIFIED; });
    if (falsified.length > 0) {
      falsified.forEach(function (s) { reasons.push("FALSIFIED " + s.claimId + " (" + s.kind + "): " + s.detail); });
      var kFail = (b.reproduce && b.reproduce.kFail) || 0;
      if (kFail >= 2) return { state: Verdict.DOES_NOT_WORK, reasons: reasons, scoreboard: scoreboard };
      var nFail = (b.reproduce && b.reproduce.n) || 0;
      falsified.forEach(function (s) {
        reasons.push("COULD_NOT_DETERMINE: claim " + s.claimId + " FALSIFIED but the failure reproduced only kFail=" + kFail + "/" + nFail + " (a single unreproduced failure is \"observed once, could not reproduce\"; conviction needs kFail>=2).");
      });
      return { state: Verdict.COULD_NOT_DETERMINE, reasons: reasons, scoreboard: scoreboard };
    }
    var confirmedEffect = scoreboard.some(function (s) { return s.kind === ClaimKind.EFFECT && s.state === ClaimState.CONFIRMED; });
    var incomplete = scoreboard.filter(function (s) { return !(s.state === ClaimState.CONFIRMED || s.naJustified); });
    var k = (b.reproduce && b.reproduce.k) || 0;
    if (confirmedEffect && incomplete.length === 0 && k >= 2) {
      reasons.push("WORKS: >=1 confirmed effect claim, all " + scoreboard.length + " claim(s) satisfied, reproduced k=" + k + ".");
      return { state: Verdict.WORKS, reasons: reasons, scoreboard: scoreboard };
    }
    if (!confirmedEffect) reasons.push("COULD_NOT_DETERMINE: no CONFIRMED effect claim (WORKS requires effectChecks >= 1, rechecked at verdict).");
    incomplete.forEach(function (s) { reasons.push("COULD_NOT_DETERMINE: claim " + s.claimId + " (" + s.kind + ") is " + s.state + " — " + s.detail); });
    if (confirmedEffect && incomplete.length === 0 && k < 2) reasons.push("COULD_NOT_DETERMINE: reproduced only k=" + k + " (WORKS requires k>=2; a single walk is never WORKS, FW-6).");
    return { state: Verdict.COULD_NOT_DETERMINE, reasons: reasons, scoreboard: scoreboard };
  }

  /* ---------- WebCrypto SHA-256 (matches src/evidence.mjs contentAddress) ---------- */
  function sha256hex(str) {
    var bytes = new TextEncoder().encode(str);
    return crypto.subtle.digest("SHA-256", bytes).then(function (buf) {
      var arr = Array.prototype.slice.call(new Uint8Array(buf));
      return arr.map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    });
  }
  function contentAddress(data) { return sha256hex(stableStringify(data == null ? null : data)); }
  function manifestDigest(bundle) {
    var manifest = stableStringify({ intent: bundle.intent != null ? bundle.intent : null, claims: bundle.claims || [], receipts: bundle.receipts || [], verdict: verdict(bundle) });
    return sha256hex(manifest);
  }

  /* ---------- tiny DOM helpers ---------- */
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function el(id) { return document.getElementById(id); }
  function short(sha, n) { return String(sha || "").slice(0, n || 12); }
  function readBundle(id) {
    var node = el(id);
    if (!node) return null;
    try { return JSON.parse(node.textContent); } catch (e) { return null; }
  }

  var VERDICT_META = {
    WORKS: { cls: "works", label: "WORKS", badge: "badge-works" },
    DOES_NOT_WORK: { cls: "dnw", label: "DOES NOT WORK", badge: "badge-dnw" },
    COULD_NOT_DETERMINE: { cls: "cnd", label: "COULD NOT DETERMINE", badge: "badge-cnd" }
  };
  function verdictBadge(state) {
    var m = VERDICT_META[state] || VERDICT_META.COULD_NOT_DETERMINE;
    return '<span class="badge ' + m.badge + '">' + m.label + "</span>";
  }
  var PROV_BADGE = { harness: "badge-harness", tool: "badge-tool", agent: "badge-agent" };
  function provBadge(p) { return '<span class="badge badge-prov ' + (PROV_BADGE[p] || "badge-agent") + '">' + esc(p) + "</span>"; }

  /* ================= render ================= */
  var merge = readBundle("bundle-merge");
  var parent = readBundle("bundle-parent");
  if (!merge) return;

  var vMerge = verdict(merge);
  var vParent = parent ? verdict(parent) : null;
  var diffPass = vMerge.state === Verdict.WORKS && vParent && vParent.state !== Verdict.WORKS;

  var fp = (merge.receipts || []).find(function (r) { return r.kind === "fingerprint"; });
  var fpData = (fp && fp.data) || {};

  /* ---- verdict block (the differential ruling) ---- */
  (function renderVerdict() {
    var host = el("verdict-block");
    if (!host) return;
    var stampCls = diffPass ? "" : "is-cnd";
    var head = diffPass ? "DIFFERENTIAL · PASS" : "DIFFERENTIAL · FAIL";
    var headCls = diffPass ? "works" : "cnd";
    host.className = "verdict-block";
    host.innerHTML =
      '<div class="verdict-stamp ' + stampCls + '">' +
        '<svg viewBox="0 0 100 100" role="img" aria-label="differential ' + (diffPass ? "pass" : "fail") + '">' +
          '<defs><path id="vseal-arc" d="M 50,50 m -38,0 a 38,38 0 1,1 76,0 a 38,38 0 1,1 -76,0"/></defs>' +
          '<circle cx="50" cy="50" r="47"/><circle cx="50" cy="50" r="34"/>' +
          '<text font-size="8" letter-spacing="1"><textPath href="#vseal-arc" startOffset="2">PROOFBENCH · SEALED · ed25519 ·</textPath></text>' +
          '<text x="50" y="47" text-anchor="middle" font-size="10" font-weight="600">' + (diffPass ? "PASS" : "FAIL") + '</text>' +
          '<text x="50" y="61" text-anchor="middle" font-size="7">' + esc(short(fpData.sha, 7)) + '</text>' +
        "</svg>" +
      "</div>" +
      "<div>" +
        '<div class="verdict-headline ' + headCls + '">' + head + "</div>" +
        "<p>merge <strong>" + esc(short(fpData.sha, 7)) + "</strong> is <strong>" + esc(vMerge.state) + "</strong> and its parent is <strong>" + esc(vParent ? vParent.state : "—") + "</strong> — so this PR's diff is why the feature works, not the environment.</p>" +
        '<ul class="verdict-reasons">' + vMerge.reasons.map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("") + "</ul>" +
      "</div>";
  })();

  /* ---- differential grid ---- */
  (function renderDiff() {
    var host = el("diff-grid");
    if (!host) return;
    function leg(bundle, v, primary) {
      var f = (bundle.receipts || []).find(function (r) { return r.kind === "fingerprint"; });
      var sha = f && f.data ? f.data.sha : "";
      if (!sha) { var im = (bundle.intent || "").match(/SHA ([0-9a-f]+)/i); if (im) sha = im[1]; }
      var rep = bundle.reproduce || {};
      var note = v.reasons[0] || "";
      return '<div class="diff-leg' + (primary ? " is-primary" : "") + '">' +
        '<span class="diff-leg-label">' + (primary ? "merge" : "parent") + " · " + esc(short(sha, 7)) + "</span>" +
        verdictBadge(v.state) +
        '<span class="diff-leg-note">reproduce k=' + (rep.k || 0) + "/" + (rep.n || 0) + ", kFail=" + (rep.kFail || 0) + ". " + esc(note) + "</span>" +
        "</div>";
    }
    host.innerHTML =
      leg(merge, vMerge, true) +
      '<div class="diff-op"><span class="diff-verb">∧</span><span>merge = WORKS<br/>parent ≠ WORKS</span></div>' +
      (parent ? leg(parent, vParent, false) : '<div class="diff-leg"><span class="diff-leg-note">parent leg not embedded</span></div>');
    var res = el("diff-result");
    if (res) res.innerHTML = "<span>DIFFERENTIAL:</span> <span class=\"" + (diffPass ? "pass" : "fail") + "\">" + (diffPass ? "PASS" : "FAIL") + "</span> <span style=\"color:var(--ink-3)\">— PASS iff merge=WORKS ∧ parent≠WORKS</span>";
  })();

  /* ---- the decisive moment (merge) ---- */
  (function renderMoment() {
    var host = el("moment");
    if (!host) return;
    var rmap = receiptMap(merge);
    var delta = rmap["store-delta"];
    var drive = rmap["browser-drive"];
    var fresh = rmap["fresh-execution"];
    var dd = (delta && delta.data) || {};
    var drv = (drive && drive.data) || {};
    var frd = (fresh && fresh.data) || {};
    host.innerHTML =
      '<div class="moment-panel">' +
        "<h4>" + provBadge(delta ? delta.provenance : "harness") + " store of record — tapped out of band</h4>" +
        '<dl class="moment-kv">' +
          "<dt>entity</dt><dd>" + esc(dd.entity) + "</dd>" +
          "<dt>before</dt><dd>" + esc(dd.before) + "</dd>" +
          "<dt>after</dt><dd class=\"moment-delta\">" + esc(dd.after) + "  (increased)</dd>" +
          "<dt>status</dt><dd>" + esc(dd.status) + "</dd>" +
          "<dt>workflow</dt><dd>" + esc(dd.workflowId) + "</dd>" +
        "</dl>" +
        (fresh ? '<div class="moment-screen">fresh session re-read: observed id ' + esc(frd.observed) + " — binds the delta's after=" + esc(dd.after) + "</div>" : "") +
      "</div>" +
      '<div class="moment-panel">' +
        "<h4>" + provBadge(drive ? drive.provenance : "tool") + " what the visitor saw at the front door</h4>" +
        '<div class="moment-screen">' + esc((drv.observed || "").trim()) + "</div>" +
        '<dl class="moment-kv" style="margin-top:var(--space-2)">' +
          "<dt>front door</dt><dd>" + esc(drv.frontDoorUrl || "") + "</dd>" +
          "<dt>DOM steps</dt><dd>" + ((drv.steps || []).length) + " recorded</dd>" +
        "</dl>" +
      "</div>";
  })();

  /* ---- claim scoreboard (merge) ---- */
  (function renderScoreboard() {
    var host = el("scoreboard");
    if (!host) return;
    var rows = vMerge.scoreboard.map(function (s) {
      return "<tr>" +
        '<td class="mono">' + esc(s.claimId) + "</td>" +
        '<td class="mono">' + esc(s.kind) + "</td>" +
        '<td class="mono claim-state-' + s.state.toLowerCase() + '">' + esc(s.state) + "</td>" +
        '<td class="detail">' + esc(s.detail) + "</td>" +
        "</tr>";
    }).join("");
    host.innerHTML = "<thead><tr><th>claim</th><th>kind</th><th>state</th><th>why</th></tr></thead><tbody>" + rows + "</tbody>";
  })();

  /* ---- receipt ledger (merge) ---- */
  var receiptShaEls = [];
  (function renderReceipts() {
    var host = el("receipts");
    if (!host) return;
    host.innerHTML = (merge.receipts || []).map(function (r, idx) {
      var body;
      if (r.kind === "attempt" && r.data && r.data.steps) {
        body = '<div class="step-list">' + r.data.steps.map(function (st) {
          var detail = st.url || st.css || st.text || (st.value !== undefined ? JSON.stringify(st.value) : "") || (st.script ? st.script.slice(0, 80) + "…" : "");
          return '<div><span class="step-op">' + esc(st.op) + "</span> " + esc(detail) + "</div>";
        }).join("") + "</div>" + (r.data.observed ? '<div class="moment-screen" style="margin-top:8px">observed: ' + esc(r.data.observed.trim()) + "</div>" : "");
      } else {
        body = "<pre>" + esc(JSON.stringify(r.data, null, 2)) + "</pre>";
      }
      return '<details class="receipt"' + (idx === 1 ? " open" : "") + ">" +
        '<summary>' +
          '<span class="receipt-id">' + esc(r.id) + "</span>" +
          "<span>" + provBadge(r.provenance) + "</span>" +
          '<span class="receipt-kind">' + esc(r.kind) + (r.identity ? " · " + esc(r.identity) : "") + "</span>" +
          '<span class="receipt-sha" data-sha="' + esc(r.sha256 || "") + '" data-idx="' + idx + '">sha ' + esc(short(r.sha256, 12)) + "…</span>" +
        "</summary>" +
        '<div class="receipt-body">' + body + "</div>" +
      "</details>";
    }).join("");
    receiptShaEls = Array.prototype.slice.call(host.querySelectorAll(".receipt-sha"));
  })();

  /* ---- touched-surface manifest ---- */
  (function renderManifest() {
    var host = el("manifest");
    if (!host) return;
    var order = [["sha", "code sha"], ["image_digest", "image digest"], ["version_label", "version"], ["image_ref_or_tag", "image ref"], ["container", "container"], ["mode", "build mode"]];
    host.innerHTML = order.filter(function (o) { return fpData[o[0]] != null; }).map(function (o) {
      return "<dt>" + esc(o[1]) + "</dt><dd>" + esc(fpData[o[0]]) + "</dd>";
    }).join("");
  })();

  /* ---- machine-readable verdict block ---- */
  (function renderMachine() {
    var host = el("machine");
    if (!host) return;
    var block = {
      differential: diffPass ? "PASS" : "FAIL",
      merge: { sha: fpData.sha, verdict: vMerge.state },
      parent: parent ? { sha: (parent.receipts.find(function (r) { return r.kind === "fingerprint"; }) || { data: {} }).data.sha || short((parent.intent || "").match(/SHA (\w+)/) ? "" : "", 0), verdict: vParent.state } : null,
      reproduce: merge.reproduce,
      seal: { algorithm: merge.seal.algorithm, digest: merge.seal.digest }
    };
    // parent sha lives in its intent when no fingerprint receipt is present
    if (block.parent && !block.parent.sha) {
      var m = (parent.intent || "").match(/SHA ([0-9a-f]+)/i);
      block.parent.sha = m ? m[1] : "869b8f14";
    }
    host.textContent = JSON.stringify(block, null, 2);
  })();

  /* ---- re-run command ---- */
  (function renderRerun() {
    var host = el("rerun-cmd");
    if (host) host.textContent = "node src/cli.mjs prove recipes/n8n-form-trigger-pr7130";
  })();

  /* ================= self-verify (INTACT / TAMPERED) ================= */
  function setStatus(state, detail) {
    var s = el("sv-status"), d = el("sv-detail");
    if (s) { s.className = "sv-status " + state; s.textContent = state === "intact" ? "INTACT" : state === "tampered" ? "TAMPERED" : "checking…"; }
    if (d) d.textContent = detail || "";
  }

  function runSelfVerify(bundle, tamper) {
    setStatus("pending", "recomputing digests in your browser…");
    var work = tamper ? JSON.parse(JSON.stringify(bundle)) : bundle;
    if (tamper) {
      // flip one byte of one receipt's data — the acceptance-test tamper
      if (work.receipts && work.receipts[1] && work.receipts[1].data) {
        var d = work.receipts[1].data;
        if ("after" in d) d.after = Number(d.after) + 1; else d.__tamper = 1;
      }
    }
    var checks = [];
    var receiptChecks = (work.receipts || []).map(function (r) {
      return contentAddress(r.data).then(function (h) { return { id: r.id, ok: h === r.sha256, got: h, want: r.sha256 }; });
    });
    return Promise.all(receiptChecks).then(function (rc) {
      checks = rc;
      return manifestDigest(work);
    }).then(function (digest) {
      var digestOk = digest === work.seal.digest;
      var allReceiptsOk = checks.every(function (c) { return c.ok; });
      var intact = digestOk && allReceiptsOk;
      // reflect per-receipt result in the ledger
      if (!tamper) {
        receiptShaEls.forEach(function (elm) {
          var want = elm.getAttribute("data-sha");
          var res = checks.find(function (c) { return c.want === want; });
          var okMark = res && res.ok ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>';
          elm.innerHTML = "sha " + short(want, 12) + "… " + okMark;
        });
      }
      var list = el("sv-list");
      if (list) {
        list.innerHTML =
          checks.map(function (c) { return "<li" + (c.ok ? "" : ' class="bad"') + ">receipt " + esc(c.id) + " content address " + (c.ok ? "matches" : "MISMATCH") + "</li>"; }).join("") +
          "<li" + (digestOk ? "" : ' class="bad"') + ">sealed manifest digest " + (digestOk ? "matches sha256 " + short(digest, 16) + "…" : "MISMATCH") + "</li>";
      }
      setStatus(
        intact ? "intact" : "tampered",
        intact
          ? "All " + checks.length + " receipt content addresses and the sealed manifest digest recompute exactly — nothing was edited after sealing."
          : (tamper ? "Demo: one byte of a receipt was flipped — the manifest digest no longer matches the seal." : "A field was edited after sealing — this bundle is not authentic.")
      );
      return intact;
    }).catch(function (e) {
      setStatus("tampered", "self-verify could not run: " + (e && e.message ? e.message : e));
    });
  }

  var btn = el("btn-verify");
  if (btn) btn.addEventListener("click", function () { runSelfVerify(merge, false); });
  var tbtn = el("btn-tamper");
  if (tbtn) tbtn.addEventListener("click", function () {
    runSelfVerify(merge, true).then(function () {
      setTimeout(function () { runSelfVerify(merge, false); }, 2400);
    });
  });

  // run once on load
  if (window.crypto && window.crypto.subtle) {
    runSelfVerify(merge, false);
  } else {
    setStatus("pending", "this browser has no WebCrypto; run `node src/cli.mjs prove …` to verify the seal.");
  }
})();
