import { layout } from "./ui/layout.js";
export const policyPage = layout("Policies and batch runs", "/policies", `<div class="page-head"><p class="eyebrow">Procurement policy</p><h1>Policies and batch runs</h1><p class="lead">Propose changes, review decisions, and run a batch.</p></div>
<label>Actor name <input id="actor" autocomplete="name"></label>
<section class="card"><p class="step">Step 1 · Propose</p><h2>Draft a policy change</h2><p class="help">Select a baseline and describe your change, or edit the JSON directly.</p>
<label>Compare with approved version <select id="base"><option value="">No baseline</option></select></label>
<button class="secondary" id="copy">Copy baseline to editor</button>
<label>Upload a PDF or text policy <input id="document" type="file" accept=".pdf,.txt,.md,application/pdf,text/plain"></label>
<label>Uploaded text <textarea id="uploadedText" rows="4" placeholder="Text from an uploaded file appears here"></textarea></label>
<button class="secondary" id="extract">Extract proposal</button>
<form id="chat">
<label>Describe a policy change <textarea id="message" rows="3" required placeholder="Include the new version and effective date"></textarea></label>
<button>Propose change</button>
</form>
<label>Policy JSON <textarea id="draft" rows="18" spellcheck="false"></textarea></label>
<div class="divider"></div><p class="step">Step 2 · Review diff</p><h2>Review and validate</h2><button id="review" class="secondary">Validate and review</button>
<div class="divider"></div><p class="step">Step 3 · Approve</p><h2>Approve version</h2><p id="effectiveDate" class="banner" style="font-size:1.5rem;font-weight:bold" aria-live="polite"></p>
<p id="immediateWarning" role="alert" style="font-weight:bold;color:#a00"></p>
<button id="approve" disabled>Approve reviewed version</button>
<pre id="reviewStatus" class="status" role="status"></pre>
<ul id="changes"></ul>
</section>
<section class="card section"><h2>Batch run</h2>
<p>The selected batch is also used for the effective date warning during policy review.</p>
<form id="batch">
<label>Snapshot ID <input id="snapshot" required></label>
<label>Batch CSV <input id="csv" type="file" accept=".csv,text/csv" required></label>
<label>Policy mode <select id="mode">
<option value="requirement_date">As of requirement date</option>
<option value="currently_active">Currently active version</option>
<option value="explicit_version">Explicit approved version</option>
</select></label>
<label id="explicitLabel" hidden>Approved version <select id="explicit"></select></label>
<label>Download as <select id="slot"><option value="run1">Run 1</option><option value="run2">Run 2</option></select></label>
<button>Process batch</button>
</form>
<p id="runStatus" class="status" role="status"></p><div id="routeSummary" class="row"></div>
<a id="download" class="button secondary" hidden>Download decision CSV</a>
</section>
`, `<script type="module">
const byId = id => document.getElementById(id);
byId("actor").value=workspace.actor; byId("snapshot").value=localStorage.getItem("cantill.snapshot")||""; workspace.save(byId("actor").value,"Procurement"); byId("actor").addEventListener("change",()=>workspace.save(byId("actor").value,"Procurement"));
const actor = () => {workspace.save(byId("actor").value,"Procurement");return { name: byId("actor").value, role: "Procurement" }};
const reviewStatus = byId("reviewStatus");
const approve = byId("approve");
const draftEditor = byId("draft");
const changes = byId("changes");
let policies = [];
let reviewed;
let revision = 0;
let approving = false;
async function api(path, body) {
  const response = await fetch(path, body === undefined ? undefined : {
    method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
async function refreshPolicies() {
  policies = await api("/api/policies");
  for (const id of ["base", "explicit"]) {
    const select = byId(id);
    const selected = select.value;
    const empty = id === "base" ? "No baseline" : "Choose a version";
    select.replaceChildren(new Option(empty, ""), ...policies.map(p => new Option(p.version + " · " + p.effective_date, p.version)));
    if (policies.some(p => p.version === selected)) select.value = selected;
  }
}
function invalidateReview() {
  revision++;
  reviewed = undefined;
  approve.disabled = true;
  changes.replaceChildren();
  reviewStatus.textContent = "";
  byId("effectiveDate").textContent = "";
  byId("immediateWarning").textContent = "";
}
for (const id of ["draft", "base", "csv"])
  byId(id).addEventListener("input", invalidateReview);
function putDraft(value) {
  draftEditor.value = JSON.stringify(value, null, 2);
  invalidateReview();
}
byId("copy").onclick = () => {
  const base = policies.find(p => p.version === byId("base").value);
  if (!base) return;
  const { approval, ...draft } = base;
  putDraft(draft);
};
async function loadProposal(source) {
  const requestRevision = revision;
  const data = await api("/api/policies/propose", { source, baseVersion: byId("base").value || undefined });
  if (requestRevision !== revision) return;
  putDraft(data.draft);
  reviewStatus.textContent = "Proposal loaded. Validate and review before approving.";
}
byId("document").onchange = async () => {
  const file = byId("document").files[0];
  byId("uploadedText").value = file && !file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf" ? await file.text() : "";
};
byId("extract").onclick = async () => {
  const button=byId("extract"); button.disabled=true; button.textContent="Extracting…"; reviewStatus.className="status"; reviewStatus.textContent="Extracting proposal…";
  try {
    const file = byId("document").files[0];
    if (!file && !byId("uploadedText").value.trim()) throw new Error("Select a PDF or enter text.");
    if (file && (file.name.toLowerCase().endsWith(".pdf") || file.type === "application/pdf")) {
      if (file.size > 5_000_000) throw new Error("Choose a PDF smaller than 5 MB.");
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      await loadProposal({kind: "pdf", base64: data});
    } else {
      if (file && !byId("uploadedText").value) byId("uploadedText").value = await file.text();
      await loadProposal({kind: "text", text: byId("uploadedText").value});
    }
  } catch (error) { reviewStatus.className="status error"; reviewStatus.textContent = error.message; }
  finally { button.disabled=false; button.textContent="Extract proposal"; }
};
byId("chat").onsubmit = async event => {
  event.preventDefault();
  const button=event.submitter; button.disabled=true; button.textContent="Preparing…"; reviewStatus.className="status"; reviewStatus.textContent="Preparing proposal…";
  try { await loadProposal({kind: "chat", text: byId("message").value}); }
  catch (error) { reviewStatus.className="status error"; reviewStatus.textContent = error.message; }
  finally { button.disabled=false; button.textContent="Propose change"; }
};
byId("review").onclick = async () => {
  invalidateReview();
  const requestRevision = revision;
  const button=byId("review"); button.disabled=true; button.textContent="Validating…";
  try {
    const file = byId("csv").files[0];
    const input = {
      draft: JSON.parse(draftEditor.value),
      baseVersion: byId("base").value || undefined,
      batch: file ? {csv: await file.text()} : undefined,
    };
    const result = await api("/api/policies/review", input);
    if (requestRevision !== revision) return;
    reviewed = input;
    byId("effectiveDate").textContent = "Effective date: " + result.effective.effectiveDate;
    byId("immediateWarning").textContent = result.effective.immediate ? "This takes effect immediately." : "";
    approve.disabled = approving;
    for (const change of result.changes) {
      const item = document.createElement("li");
      item.textContent = change;
      changes.append(item);
    }
    reviewStatus.className="status success";
    reviewStatus.textContent = result.impact.warning
      ? result.impact.warning + ". No line qualifies for this amendment by requirement date."
      : "Draft validated.";
  } catch (error) {
    if (requestRevision === revision) { reviewStatus.className="status error"; reviewStatus.textContent = error.message; }
  } finally { button.disabled=false; button.textContent="Validate and review"; }
};
approve.onclick = async () => {
  if (!reviewed || approving) return;
  approving = true;
  approve.disabled = true;
  try {
    const result = await api("/api/policies/approve", { ...reviewed, actor: actor() });
    invalidateReview();
    reviewStatus.className="status success";
    reviewStatus.textContent = "Approved " + result.policy.version + " by " + result.policy.approval.actor + " at " + result.policy.approval.at + ".";
    await refreshPolicies();
  } catch (error) {
    reviewStatus.className="status error"; reviewStatus.textContent = error.message;
  } finally {
    approving = false;
    approve.disabled = !reviewed;
  }
};
const mode = byId("mode");
mode.onchange = () => {
  byId("explicitLabel").hidden = mode.value !== "explicit_version";
  byId("explicit").required = mode.value === "explicit_version";
};
byId("batch").onsubmit = async event => {
  event.preventDefault();
  const status = byId("runStatus");
  const download = byId("download");
  const button = event.submitter;
  if (button) button.disabled = true;
  download.hidden = true;
  byId("routeSummary").replaceChildren();
  status.textContent = "Processing…";
  try {
    const date = new Intl.DateTimeFormat("sv-SE", {timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date());
    const selection = { mode: mode.value, execution_date: date };
    if (mode.value === "explicit_version") selection.version = byId("explicit").value;
    const slot = byId("slot").value;
    const run = await api("/api/process-batch", {
      actor: actor(), selection, snapshotId: byId("snapshot").value.trim(), csv: await byId("csv").files[0].text(),
    });
    status.textContent = "Run " + run.id + " · " + run.result.decisions.length + " lines · " + selection.mode + " · policy " + run.result.metadata.policy_versions.join(", ");
    byId("routeSummary").replaceChildren();
    const counts={};for(const row of run.result.decisions)counts[row.route]=(counts[row.route]||0)+1;
    for(const [route,count] of Object.entries(counts)){const badge=document.createElement("span");badge.className="badge "+(route.endsWith("_PO")?"po":route==="NOT_PROCESSED"?"rejected":"source");badge.textContent=route.replaceAll("_"," ")+" · "+count;byId("routeSummary").append(badge)}
    download.href = "/api/runs/" + encodeURIComponent(run.id) + "/export?slot=" + slot;
    download.hidden = false;
  } catch (error) { status.textContent = error.message; }
  finally { if (button) button.disabled = false; }
};
refreshPolicies().catch(error => { reviewStatus.textContent = error.message; });
</script>`);
