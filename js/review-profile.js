import { applicantProfileRequest } from "./screening.js";
import { auth } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

// Application snapshots remain visible separately from the current profile.
// A failed profile request never prevents PDF review or decision controls.
export function createApplicantProfileReview(fields, feedback) {
    let generation = 0, owner;
    const text = value => typeof value === "string" && value.trim() ? value : "Not provided";
    const clear = () => {
        generation++;
        for (const field of Object.values(fields)) field.textContent = "Not provided";
        feedback.textContent = "";
        owner = null;
    };
    const unsubscribe = onAuthStateChanged(auth, user => { if (owner && user !== owner) clear(); });
    const load = async applicationId => {
        clear(); owner = auth.currentUser;
        const version = generation, user = owner;
        feedback.textContent = "Loading applicant profile and contact details…";
        try {
            const profile = await applicantProfileRequest(applicationId);
            if (version !== generation || auth.currentUser !== user) return;
            const values = { name: [profile.firstName, profile.lastName].filter(Boolean).join(" "),
                email: profile.email, phone: profile.phone, address: profile.address,
                dateOfBirth: profile.dateOfBirth, gender: profile.gender, region: profile.region,
                qualification: profile.highestQualification, employment: profile.employmentStatus,
                skills: Array.isArray(profile.skills) ? profile.skills.join(", ") : "" };
            for (const [key, value] of Object.entries(values)) fields[key].textContent = text(value);
            fields.points.textContent = typeof profile.academicPoints === "number" && Number.isFinite(profile.academicPoints)
                ? `${profile.academicPoints} (applicant-declared; verify against the qualification PDF)`
                : "Not recorded — review the qualification PDF. Screening checks below are not academic points.";
            feedback.textContent = "Current applicant profile. Contact details are applicant-provided. Application details below are the submission snapshot.";
        } catch (error) {
            if (version === generation) feedback.textContent = `Profile unavailable: ${error.message} You can still inspect the submitted application and documents below.`;
        }
    };
    return { load, clear, destroy: () => { clear(); unsubscribe(); } };
}
