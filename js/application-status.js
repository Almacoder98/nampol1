import { auth, db } from "./firebase-config.js";
import { collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

export async function watchApplicantApplications(user, update, failed) {
    if (auth.currentUser !== user || !user.emailVerified) throw new Error("Verify your email address and sign in again to track applications.");
    if (auth.currentUser !== user) throw new Error("Your session changed.");
    let active = true;
    let applications = [], shortlistStates = new Map(), shortlistReady = false;
    const emit = () => {
        if (!active || auth.currentUser !== user) return;
        update(applications.map(item => ({ ...item,
            // Never trust a similarly named field on an application snapshot.
            shortlistStatus: shortlistReady ? (shortlistStates.get(item.id) || "not_shortlisted") : "unavailable" })));
    };
    const unsubscribe = onSnapshot(query(collection(db, "applications"), where("applicantId", "==", user.uid)), snapshot => {
        if (!active || auth.currentUser !== user) return;
        applications = snapshot.docs.map(item => ({ id: item.id, ...item.data() }))
            .sort((a, b) => (b.submittedAt?.seconds || 0) - (a.submittedAt?.seconds || 0));
        emit();
    }, () => { if (active && auth.currentUser === user) failed("Live status updates are unavailable. Refresh or sign in again."); });
    let unsubscribeShortlists;
    try {
        unsubscribeShortlists = onSnapshot(query(collection(db, "applicantShortlistStatuses"), where("ownerUid", "==", user.uid)), snapshot => {
            if (!active || auth.currentUser !== user) return;
            shortlistStates = new Map(snapshot.docs.map(item => [item.id, item.data().status])
                .filter(([, status]) => ["shortlisted", "not_shortlisted"].includes(status)));
            shortlistReady = true; emit();
        }, () => {
            shortlistReady = false; shortlistStates.clear(); emit();
            if (active && auth.currentUser === user) failed("Shortlist indicators are unavailable. Application decisions remain separate; refresh after the updated rules are active.");
        });
    } catch (error) { active = false; unsubscribe(); throw error; }
    return () => { active = false; unsubscribe(); unsubscribeShortlists(); };
}

export function applicantShortlistLabel(application) {
    if (application.shortlistStatus === "shortlisted") return "Shortlisted for consideration — not final approval";
    if (application.shortlistStatus === "not_shortlisted") return "Not currently shortlisted";
    return "Shortlist indicator unavailable";
}
