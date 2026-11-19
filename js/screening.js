import { auth } from "./firebase-config.js";

async function adminApplicationRequest(applicationId, resource, run = false) {
    const user = auth.currentUser;
    if (auth.currentUser !== user || !user.emailVerified) throw new Error("Verify your email address before accessing application reviews.");
    const token = await user.getIdToken(true);
    if (auth.currentUser !== user) throw new Error("Your session changed. Sign in again.");
    const origin = ["localhost", "127.0.0.1"].includes(window.location.hostname)
        ? `${window.location.protocol}//${window.location.hostname}:8001` : window.location.origin;
    const response = await fetch(`${origin}/api/admin/applications/${encodeURIComponent(applicationId)}/${resource}`, {
        method: run ? "POST" : "GET", headers: { Authorization: `Bearer ${token}` },
        cache: "no-store", credentials: "omit", redirect: "error",
        signal: AbortSignal.timeout(run ? 300000 : 60000)
    });
    if (auth.currentUser !== user) throw new Error("Your session changed. Sign in again.");
    if (!response.ok) {
        const messages = { 401: "Sign in again.", 403: "Your account is not authorized to access this application.",
            404: "Application not found.", 409: "Stored evidence or permissions changed or are incomplete. Reload and check the original documents.",
            429: "Screening capacity reached. Wait and retry." };
        throw new Error(messages[response.status] || "Application review data is unavailable. Check the backend service and try again later.");
    }
    const body = await response.json();
    if (auth.currentUser !== user) throw new Error("Your session changed. Sign in again.");
    return body.result;
}

export async function screeningRequest(applicationId, run = false) {
    return adminApplicationRequest(applicationId, 'screening', run);
}

export async function notificationRequest(applicationId) {
    return adminApplicationRequest(applicationId, 'notification');
}

export async function applicantProfileRequest(applicationId) {
    return adminApplicationRequest(applicationId, 'profile');
}

export function renderScreening(container, result) {
    container.replaceChildren();
    const paragraph = text => { const p = document.createElement("p"); p.textContent = text; container.append(p); };
    if (!result) { paragraph("Not screened. Select Screen CV to compare the linked CV with the published vacancy requirements locally."); return; }
    paragraph(result.notice);
    if (result.matchingEngine) paragraph(`Matching method: ${result.matchingEngine}.`);
    if (result.vacancyResolution !== "matched") {
        paragraph("No linked published vacancy could be verified. Vacancy criteria need manual verification.");
    }
    const cvMessages = {
        readable: "CV text extracted from the private, linked PDF.",
        missing: "No CV is linked to this application. Each criterion needs manual verification.",
        unavailable: "The linked CV is missing, unready, or not a clean PDF. Each criterion needs manual verification.",
        unreadable: "No text could be extracted from the CV. It may be scanned or image-only; manual review is needed."
    };
    if (result.cvStatus) paragraph(cvMessages[result.cvStatus] || "CV availability could not be verified.");
    if (result.summary) {
        const possible = result.summary.met;
        const manual = result.summary.could_not_verify;
        if ([possible, manual].every(value => Number.isSafeInteger(value) && value >= 0)) {
            paragraph(`Possible CV excerpts found for ${possible} requirement(s); ${manual} need manual verification. This is not a score or eligibility decision.`);
        } else paragraph("Screening summary unavailable. Review the individual requirements below.");
    }
    if (result.stale) paragraph("OUTDATED: vacancy criteria, document evidence or the synthetic fixture changed or are unavailable. Run screening again before relying on this report.");
    paragraph(`Vacancy: ${result.vacancyTitle || "Could not verify a linked published vacancy"}. Run: ${result.runId}. Created: ${result.createdAt}.`);
    for (const check of result.criteria || []) {
        paragraph(`${check.status === "met" ? "POSSIBLE CV EVIDENCE" : "NEEDS MANUAL VERIFICATION"}: ${check.requirement} — ${check.explanation}`);
        if (check.excerpt) paragraph(`CV excerpt: "${check.excerpt}"`);
    }
    if (result.aiReview) paragraph(`External AI service: not used. ${result.aiReview.message || ""}`);
    paragraph("Document authenticity is not verified. These evidence suggestions never approve or reject an application.");
}
