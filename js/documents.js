import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// Public API origin only. Production should proxy /api on the HTTPS frontend origin.
// Keep this aligned with BACKEND.md and the backend's explicit CORS allowlist.
const API_ORIGIN = ["localhost", "127.0.0.1"].includes(window.location.hostname)
    ? `${window.location.protocol}//${window.location.hostname}:8001` : window.location.origin;
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const KINDS = ["cv", "identification", "certificate"];
const element = id => document.getElementById(id);
const inputs = [element("cvFile"), element("idFile"), element("certificateFile")];
const statuses = [element("cvStatus"), element("idStatus"), element("certificateStatus")];
const infos = [element("cvInfo"), element("idInfo"), element("certificateInfo")];
const documentForm = element("documentForm");
const saveDocumentsBtn = element("saveDocumentsBtn");
const alertBox = element("alertBox");
let currentUser = null;
let uploading = false;
let uncertainOutcome = false;

function showAlert(message, type = "danger") {
    alertBox.className = `alert alert-${type}`;
    alertBox.textContent = message;
    alertBox.classList.remove("d-none");
}

function setBusy(busy) {
    uploading = busy;
    saveDocumentsBtn.disabled = busy || uncertainOutcome || !currentUser;
    saveDocumentsBtn.textContent = busy ? "Uploading, scanning and storing..." : "Upload Documents Securely";
    documentForm.setAttribute("aria-busy", String(busy));
    element("uploadStatus").classList.toggle("d-none", !busy);
    inputs.forEach(input => { input.disabled = busy; });
}

function updateSelection() {
    inputs.forEach((input, index) => {
        const file = input.files[0];
        statuses[index].className = `badge bg-${file ? "success" : "secondary"} status-badge`;
        statuses[index].textContent = file ? "Selected" : "Not selected";
        infos[index].textContent = file ? `${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MiB)` : "";
    });
}

function validateFiles(files) {
    KINDS.forEach(kind => {
        const file = files[kind];
        if (!file || !file.size || file.size > MAX_FILE_SIZE) {
            throw new Error(`${kind}: select a non-empty PDF no larger than 5 MiB.`);
        }
        if (!/\.pdf$/i.test(file.name) || (file.type && file.type !== "application/pdf")) {
            throw new Error(`${kind}: only PDF files are accepted.`);
        }
    });
}

function isReadySet(manifest) {
    return manifest && /^[a-f0-9]{32}$/.test(manifest.setId)
        && manifest.state === "ready" && manifest.schemaVersion === 1
        && KINDS.every(kind => {
            const item = manifest.documents?.[kind];
            return item?.scanStatus === "clean" && typeof item.fileName === "string"
                && item.fileSize > 0 && typeof item.mimeType === "string";
        });
}

async function apiRequest(user, method, body) {
    let token;
    try {
        // Force refresh before sending files; revoked/disabled sessions fail closed.
        token = await user.getIdToken(true);
    } catch (error) {
        if (error.code === "auth/network-request-failed") {
            throw new Error("Cannot refresh authentication while offline. Check your connection and reload.");
        }
        if (error.code === "auth/too-many-requests") {
            throw new Error("Authentication is temporarily busy. Wait and reload.");
        }
        throw new Error("Your session could not be refreshed. Please log in again.");
    }
    if (auth.currentUser !== user || currentUser !== user) {
        throw new Error("Your session changed. Please log in again.");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    let response;
    let authenticationRejected = false;
    let storageFailureMessage = "";
    try {
        response = await fetch(`${API_ORIGIN}/api/me/document-sets`, {
            method, headers: { Authorization: `Bearer ${token}` },
            ...(body ? { body } : {}), signal: controller.signal,
            credentials: "omit", cache: "no-store", redirect: "error"
        });
        if (!response.ok) {
            // These codes are returned before authorization/body processing. A login
            // cannot repair them; no upload has started and no POST is retried.
            let code;
            if ([401, 503].includes(response.status)) {
                try { code = (await response.json()).detail?.code; } catch { /* generic HTTP error */ }
            }
            const authenticationMessages = {
                auth_clock_error: "The backend clock is behind Firebase. Ask the operator to synchronize server time, then reload. No upload was started.",
                auth_project_error: "The backend Firebase project configuration does not match this sign-in. Contact the operator. No upload was started.",
                auth_backend_error: "The backend cannot access Firebase Authentication. Ask the operator to check server credentials and permissions. No upload was started."
            };
            if (response.status === 503 && Object.hasOwn(authenticationMessages, code)) {
                authenticationRejected = true;
                throw new Error(authenticationMessages[code]);
            }
            const storageMessages = {
                storage_credentials_error: "Supabase rejected the backend credentials. The operator must check the matching project URL and active server secret key.",
                storage_connection_error: "The backend cannot connect to the configured Supabase project. The operator must check the project URL, DNS and network.",
                storage_bucket_missing: "The required private document bucket was not found in the configured Supabase project.",
                storage_bucket_not_private: "The configured document bucket is not private. Uploads are blocked.",
                storage_request_error: "Supabase rejected the backend storage request. The operator must inspect the storage integration.",
                storage_timeout: "The Supabase storage request timed out.",
                storage_service_error: "The private storage service is unavailable."
            };
            if (response.status === 503 && Object.hasOwn(storageMessages, code)) {
                storageFailureMessage = storageMessages[code];
                throw new Error(storageFailureMessage);
            }
            const messages = {
                401: code === "session_expired" ? "Your session has expired. Please log in again."
                    : "Authentication was rejected. Please log in again; if it persists, contact the operator.",
                403: "Upload access denied. Check your verified email and applicant profile.",
                408: "The upload request timed out. Check saved sets before trying again.",
                413: "Files rejected: each PDF must be no larger than 5 MiB.",
                422: "Files rejected by server validation or malware scanning. Select safe, valid sample PDFs.",
                429: "The upload service is busy. Please try again later."
            };
            throw new Error(messages[response.status] || "The document service is unavailable. Upload was not confirmed; check saved sets before retrying.");
        }
        const result = await response.json();
        if (auth.currentUser !== user || currentUser !== user) {
            throw new Error("Your session changed. Reload to check your saved documents.");
        }
        return result;
    } catch (error) {
        // A dropped response may follow a committed upload. Never automatically POST again.
        if (method === "POST" && !authenticationRejected && (!response || response.ok || response.status >= 500)) {
            uncertainOutcome = true;
            throw new Error((storageFailureMessage ? storageFailureMessage + " " : "Upload outcome could not be confirmed. ")
                + "Reload this page to check saved document sets before uploading again.");
        }
        if (!response) {
            throw new Error("Cannot reach the document service. Check that the backend is running and reload this page.");
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

function displaySets(sets) {
    const list = element("savedDocumentsList");
    list.replaceChildren();
    for (const manifest of sets) {
        const row = document.createElement("div");
        row.className = "list-group-item";
        row.textContent = `Document set ID: ${manifest.setId} ? Upload confirmed; malware scan clean. `
            + KINDS.map(kind => `${kind}: ${manifest.documents[kind].fileName}`).join("; ")
            + ". Document authenticity has not been verified.";
        list.append(row);
    }
    element("savedDocumentsSection").classList.toggle("d-none", sets.length === 0);
}

async function loadExistingDocuments(user) {
    const result = await apiRequest(user, "GET");
    if (!Array.isArray(result.sets)) throw new Error("Unable to read saved document sets. Reload before uploading.");
    const ready = result.sets.filter(isReadySet).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    displaySets(ready);
    if (result.sets.some(manifest => manifest.state === "pending")) {
        throw new Error("A previous upload is still pending. Wait and reload before uploading again; contact support if it remains pending.");
    }
    if (!ready.length) {
        const legacy = await getDoc(doc(db, "applicantDocuments", user.uid));
        if (legacy.exists()) {
            showAlert("An existing document record is present, but no ready uploaded set was returned. Metadata alone does not confirm a file upload.", "warning");
        }
    }
}

inputs.forEach(input => input.addEventListener("change", updateSelection));
saveDocumentsBtn.disabled = true;
onAuthStateChanged(auth, async user => {
    currentUser = null;
    setBusy(uploading);
    if (!user || !user.emailVerified) {
        window.location.href = "login.html";
        return;
    }
    try {
        const snapshot = await getDoc(doc(db, "users", user.uid));
        if (auth.currentUser !== user) return;
        if (!snapshot.exists()) { window.location.href = "login.html"; return; }
        const profile = snapshot.data();
        if (profile.role !== "applicant" || profile.accountStatus !== "active") {
            window.location.href = "login.html"; return;
        }
        if (profile.profileCompleted !== true) { window.location.href = "profile.html"; return; }
        currentUser = user;
        // Reconcile previous uploads before enabling another submission.
        await loadExistingDocuments(user);
        uncertainOutcome = false;
        setBusy(uploading);
    } catch (error) {
        uncertainOutcome = true;
        setBusy(uploading);
        showAlert(error.message || "Unable to load the document centre. Reload to try again.");
    } finally {
        element("loadingScreen").classList.add("d-none");
        element("documentPage").classList.remove("d-none");
    }
});

documentForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (uploading || uncertainOutcome) return;
    alertBox.classList.add("d-none");
    const user = currentUser;
    if (!user || auth.currentUser !== user) {
        showAlert("Your session has expired. Please log in again."); return;
    }
    const files = Object.fromEntries(KINDS.map((kind, index) => [kind, inputs[index].files[0]]));
    try { validateFiles(files); } catch (error) { showAlert(error.message, "warning"); return; }
    setBusy(true);
    try {
        const body = new FormData();
        KINDS.forEach(kind => body.append(kind, files[kind]));
        const manifest = await apiRequest(user, "POST", body);
        if (!isReadySet(manifest)) {
            uncertainOutcome = true;
            throw new Error("The backend did not confirm a clean, ready document set. Reload to check saved sets before retrying.");
        }
        displaySets([manifest]);
        documentForm.reset();
        updateSelection();
        showAlert(`Upload succeeded. Document set ID: ${manifest.setId}. All three files were scanned and stored privately. Authenticity has not been verified.`, "success");
    } catch (error) {
        showAlert(error.message || "Upload failed. No successful upload has been confirmed.");
    } finally {
        setBusy(false);
    }
});
element("dashboardBtn").addEventListener("click", () => { window.location.href = "dashboard.html"; });
