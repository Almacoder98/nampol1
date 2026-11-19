import { auth } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

export async function shortlistRequest(path, body) {
    const user = auth.currentUser;
    if (auth.currentUser !== user || !user.emailVerified) throw new Error("Verify your email address before accessing shortlists.");
    const token = await user.getIdToken(true);
    if (auth.currentUser !== user) throw new Error("Your session changed. Sign in again.");
    const origin = ["localhost", "127.0.0.1"].includes(window.location.hostname)
        ? `${window.location.protocol}//${window.location.hostname}:8001` : window.location.origin;
    const response = await fetch(`${origin}/api/admin/${path}`, {
        method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`,
            ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(30000)
    });
    const data = await response.json();
    if (auth.currentUser !== user) throw new Error("Your session changed. Sign in again.");
    if (!response.ok) {
        const error = new Error(typeof data.detail === "string" ? data.detail : "Shortlist access failed. Check your login, regional permissions and backend service.");
        error.status = response.status; throw error;
    }
    return data;
}

export function createShortlistReview({ add, remove, refresh, reason, status }, changed = () => {}) {
    let application, record, generation = 0, busy = false, pending, owner;
    const clear = () => {
        generation++; application = record = pending = owner = null; busy = false;
        reason.value = ""; status.textContent = "";
        add.disabled = remove.disabled = refresh.disabled = true;
    };
    const unsubscribe = onAuthStateChanged(auth, user => { if (owner && user !== owner) clear(); });
    const render = () => {
        const active = record?.status === "shortlisted";
        status.textContent = active ? "Shortlisted for consideration. This is not final approval."
            : "Not currently shortlisted. Application approval/denial is separate.";
        if (record?.reviewerId) status.textContent += ` Last action by ${record.reviewerId}.`;
        if (record?.reason) status.textContent += ` Internal comment: ${record.reason}`;
        if (record?.updatedAt) status.textContent += ` Updated: ${record.updatedAt}.`;
        add.disabled = busy || active || !application?.vacancyId || !["Submitted", "Under Review"].includes(application?.status);
        remove.disabled = busy || !active; refresh.disabled = busy;
        if (!application?.vacancyId) status.textContent += " This legacy application has no linked vacancy; no vacancy will be guessed.";
    };
    async function load(value) {
        clear(); application = value; owner = auth.currentUser;
        const version = generation;
        status.textContent = "Loading shortlist selection…";
        try {
            const response = await shortlistRequest(`applications/${encodeURIComponent(value.id)}/shortlist`);
            if (version !== generation) return;
            record = response.result; render();
        } catch (error) { if (version === generation) { status.textContent = error.message; refresh.disabled = false; } }
    }
    async function change(action) {
        if (!application || !record || busy) return;
        const comment = reason.value.trim();
        if (!comment) { status.textContent = "Enter an internal reason or comment before changing the shortlist."; reason.focus(); return; }
        const version = generation, app = application;
        const signature = JSON.stringify([app.id, action, comment, record.version]);
        if (pending?.signature !== signature) pending = { signature, body: {
            action, reason: comment, expectedVersion: record.version, requestId: crypto.randomUUID() } };
        busy = true; render();
        try {
            const response = await shortlistRequest(`applications/${encodeURIComponent(app.id)}/shortlist`, pending.body);
            if (version !== generation) return;
            record = response.result; pending = null; reason.value = "";
            busy = false; render();
            try { changed(); } catch { /* A secondary view cannot undo a committed selection. */ }
        } catch (error) {
            if (version !== generation) return;
            busy = false;
            if (error.status === 409) { record = null; add.disabled = remove.disabled = true; refresh.disabled = false; }
            else render();
            status.textContent = `${error.message} Refresh after a conflict; retry the same action after a connection failure.`;
        }
    }
    add.addEventListener("click", () => change("shortlist"));
    remove.addEventListener("click", () => change("remove"));
    refresh.addEventListener("click", () => { if (application && !busy) return load(application); });
    clear();
    return { load, clear, destroy: () => { clear(); unsubscribe(); } };
}

export function createVacancyShortlistView(select, refresh, output, openApplication) {
    let generation = 0, owner;
    const clear = () => { generation++; owner = null; output.replaceChildren(); };
    const unsubscribe = onAuthStateChanged(auth, user => { if (owner && user !== owner) clear(); });
    async function load() {
        clear(); owner = auth.currentUser;
        if (!select.value) { output.textContent = "Choose a vacancy to view its shortlisted candidates."; return; }
        const version = generation;
        output.textContent = "Loading shortlisted candidates…";
        try {
            const response = await shortlistRequest(`vacancies/${encodeURIComponent(select.value)}/shortlist`);
            if (version !== generation) return;
            output.replaceChildren();
            if (!response.items.length) { output.textContent = "No candidates are currently shortlisted for this vacancy."; return; }
            for (const item of response.items) {
                const row = document.createElement("div"); row.className = "border rounded p-3 mb-2";
                const title = document.createElement("strong");
                title.textContent = `${item.applicantName || "Applicant"} — ${item.applicationReference}`;
                const detail = document.createElement("p");
                detail.textContent = `Application: ${item.applicationStatus}. Shortlisted: ${item.shortlistedAt}. Reviewer: ${item.reviewerId}. Internal comment: ${item.reason}`;
                const review = document.createElement("button"); review.type = "button"; review.className = "btn btn-outline-primary btn-sm";
                review.textContent = "Review Profile & Documents";
                review.addEventListener("click", () => openApplication(item.applicationId));
                row.append(title, detail, review); output.append(row);
            }
        } catch (error) { if (version === generation) output.textContent = error.message; }
    }
    function setApplications(applications) {
        const previous = select.value; clear(); select.replaceChildren();
        const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = "Select vacancy"; select.append(placeholder);
        const vacancies = new Map();
        for (const app of applications) if (app.vacancyId) vacancies.set(app.vacancyId, `${app.position} — ${app.region} (${app.vacancyId})`);
        for (const [id, label] of [...vacancies].sort((a, b) => a[1].localeCompare(b[1]))) {
            const option = document.createElement("option"); option.value = id; option.textContent = label; select.append(option);
        }
        select.value = vacancies.has(previous) ? previous : "";
        void load();
    }
    select.addEventListener("change", load); refresh.addEventListener("click", load);
    return { load, setApplications, clear, destroy: () => { clear(); unsubscribe(); } };
}
