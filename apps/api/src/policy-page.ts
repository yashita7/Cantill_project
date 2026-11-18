export const policyPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Policies and batch runs</title>
<style>
body { margin: 2rem auto; padding: 0 1rem; max-width: 56rem; font: 1rem/1.5 system-ui; }
label { display: block; margin: .6rem 0; }
textarea { width: 100%; box-sizing: border-box; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
button { margin: .25rem 0; }
</style></head><body>
<nav><a href="/">Data setup</a></nav>
<h1>Policies and batch runs</h1>
<label>Actor name <input id="actor" autocomplete="name"></label>
<section><h2>Policy review</h2>
<label>Compare with approved version <select id="base"><option value="">No baseline</option></select></label>
<button id="copy">Copy baseline to editor</button>
<label>Upload a PDF or text policy <input id="document" type="file" accept=".pdf,.txt,.md,application/pdf,text/plain"></label>
<label>Uploaded text <textarea id="uploadedText" rows="4" placeholder="Text from an uploaded file appears here"></textarea></label>
<button id="extract">Extract proposal</button>
<form id="chat">
<label>Describe a policy change <textarea id="message" rows="3" required placeholder="Include the new version and effective date"></textarea></label>
<button>Propose change</button>
</form>
<label>Policy JSON <textarea id="draft" rows="18" spellcheck="false"></textarea></label>
<button id="review">Validate and review</button>
<button id="approve" disabled>Approve reviewed version</button>
<pre id="reviewStatus" role="status"></pre>
<ul id="changes"></ul>
</section>
<section><h2>Batch run</h2>
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
<p id="runStatus" role="status"></p>
<a id="download" hidden>Download decision CSV</a>
</section>
<script type="module">
const byId = id => document.getElementById(id);
const actor = () => ({ name: byId("actor").value, role: "Procurement" });
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
  } catch (error) { reviewStatus.textContent = error.message; }
};
byId("chat").onsubmit = async event => {
  event.preventDefault();
  try { await loadProposal({kind: "chat", text: byId("message").value}); }
  catch (error) { reviewStatus.textContent = error.message; }
};
byId("review").onclick = async () => {
  invalidateReview();
  const requestRevision = revision;
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
    approve.disabled = approving;
    for (const change of result.changes) {
      const item = document.createElement("li");
      item.textContent = change;
      changes.append(item);
    }
    reviewStatus.textContent = result.impact.warning
      ? result.impact.warning + ". No line qualifies for this amendment by requirement date."
      : "Draft validated.";
  } catch (error) {
    if (requestRevision === revision) reviewStatus.textContent = error.message;
  }
};
approve.onclick = async () => {
  if (!reviewed || approving) return;
  approving = true;
  approve.disabled = true;
  try {
    const result = await api("/api/policies/approve", { ...reviewed, actor: actor() });
    invalidateReview();
    reviewStatus.textContent = "Approved " + result.policy.version + " by " + result.policy.approval.actor + " at " + result.policy.approval.at + ".";
    await refreshPolicies();
  } catch (error) {
    reviewStatus.textContent = error.message;
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
    download.href = "/api/runs/" + encodeURIComponent(run.id) + "/export?slot=" + slot;
    download.hidden = false;
  } catch (error) { status.textContent = error.message; }
  finally { if (button) button.disabled = false; }
};
refreshPolicies().catch(error => { reviewStatus.textContent = error.message; });
</script></body></html>`;
