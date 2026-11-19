import { auth } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

export function createReviewDocumentViewer(buttons, display, feedback) {
    let generation = 0, controller, objectUrl, owner;
    const clearPdf = () => {
        if (controller) controller.abort();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = null; display.replaceChildren();
    };
    const clear = () => { generation++; clearPdf(); buttons.replaceChildren(); feedback.textContent = ""; owner = null; };
    const unsubscribe = onAuthStateChanged(auth, user => { if (owner && user !== owner) clear(); });
    async function request(user, path, signal) {
        if (auth.currentUser !== user || !user.emailVerified) throw new Error("Verify your email address before viewing documents.");
        const token = await user.getIdToken(true);
        if (auth.currentUser !== user) throw new Error("Your session changed. Sign in again.");
        const origin = ["localhost", "127.0.0.1"].includes(window.location.hostname)
            ? `${window.location.protocol}//${window.location.hostname}:8001` : window.location.origin;
        const response = await fetch(`${origin}${path}`, {
            headers: { Authorization: `Bearer ${token}` }, signal,
            credentials: "omit", cache: "no-store", redirect: "error"
        });
        if (auth.currentUser !== user) throw new Error("Your session changed. Sign in again.");
        if (!response.ok) {
            const messages = { 401: "Your session expired. Sign in again to view documents.",
                403: "You are not authorized to view these documents.",
                404: "The original submitted PDFs or document binding were not found. Older metadata-only applications have no PDF to display; no replacement set was selected.",
                409: "The original submitted document set is incomplete or its binding needs support. No replacement set was selected.",
                503: "The document service is unavailable. Check that the backend, malware scanner and private storage are configured; no files were released." };
            throw new Error(messages[response.status] || "The submitted PDFs could not be loaded. Check the backend service and try again.");
        }
        return response;
    }
    async function open(user, applicationId, kind, label) {
        const version = ++generation; clearPdf(); controller = new AbortController();
        const requestController = controller;
        const timer = setTimeout(() => requestController.abort(), 30000);
        feedback.textContent = `Loading ${label}…`;
        try {
            const response = await request(user, `/api/applications/${encodeURIComponent(applicationId)}/documents/${kind}/download`, requestController.signal);
            if (response.headers.get("Content-Type")?.split(";")[0].trim() !== "application/pdf") throw new Error("A PDF document is required.");
            const blob = await response.blob();
            if (version !== generation || auth.currentUser !== user) return;
            if (!blob.size || blob.size > 5242880) throw new Error("Invalid PDF response.");
            objectUrl = URL.createObjectURL(blob);
            const frame = document.createElement("iframe"); frame.title = `${label} PDF`;
            frame.setAttribute("sandbox", ""); frame.src = objectUrl;
            frame.style.cssText = "width:100%;height:480px;border:1px solid #ddd";
            const fallback = document.createElement("a"); fallback.href = objectUrl;
            fallback.target = "_blank"; fallback.rel = "noopener noreferrer";
            fallback.textContent = `Open ${label} PDF in a separate tab if the embedded viewer is unavailable`;
            display.append(frame, fallback); feedback.textContent = `${label}: private submitted PDF. Authenticity has not been verified.`;
        } catch (error) {
            if (version === generation) feedback.textContent = error.name === "AbortError" ? "Document request cancelled or timed out. Try again." : error.message;
        } finally { clearTimeout(timer); }
    }
    async function load(applicationId) {
        clear(); owner = auth.currentUser;
        const user = owner, version = generation; controller = new AbortController();
        const requestController = controller;
        const timer = setTimeout(() => requestController.abort(), 30000);
        feedback.textContent = "Checking the application’s submitted document set…";
        try {
            const response = await request(user, `/api/applications/${encodeURIComponent(applicationId)}/documents`, requestController.signal);
            const manifest = await response.json();
            if (version !== generation || auth.currentUser !== user) return;
            if (manifest.state !== "ready") throw new Error("The submitted document set is not READY.");
            for (const [kind, label] of [["cv", "CV"], ["certificate", "Qualifications"], ["identification", "Identification"]]) {
                const record = manifest.documents?.[kind];
                const button = document.createElement("button"); button.type = "button";
                button.className = "btn btn-outline-primary me-2 mb-2"; button.textContent = `View ${label}`;
                button.disabled = record?.mimeType !== "application/pdf" || record?.scanStatus !== "clean";
                button.addEventListener("click", () => open(user, applicationId, kind, label)); buttons.append(button);
            }
            feedback.textContent = "Only the immutable submitted set is shown. Choose a PDF to review alongside screening.";
        } catch (error) { if (version === generation) feedback.textContent = error.message; }
        finally { clearTimeout(timer); }
    }
    return { load, clear, destroy: () => { clear(); unsubscribe(); } };
}
