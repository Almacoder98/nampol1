import { completeAdminAccess, getAdminSession } from "./admin-access.js";
// ============================================================
// NAMPOL RECRUITMENT SYSTEM
// ADMIN AUTHENTICATION AND ADMIN FUNCTIONS
// ============================================================

import {
    auth,
    db
} from "./firebase-config.js";


import {
    signInWithEmailAndPassword,
    signOut,
    sendEmailVerification,
    sendPasswordResetEmail,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";


import {
    collection,
    query,
    where,
    getDocs,
    doc,
    getDoc,
    runTransaction,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";


// ============================================================
// ALLOWED ADMIN ROLES
// ============================================================

const ALLOWED_ADMIN_ROLES = [
    "admin",
    "recruiter",
    "super_admin"
];

let adminAuthenticationPending = false;
const emailCooldowns = new Map();

function reserveEmailRequest(action) {
    const key = "nampol-admin-email-" + action;
    let lastRequest = emailCooldowns.get(key) || 0;
    try {
        lastRequest = Math.max(lastRequest, Number(sessionStorage.getItem(key)) || 0);
    } catch {
        // In-memory throttling still works when browser storage is unavailable.
    }
    const remaining = Math.ceil((lastRequest + 60000 - Date.now()) / 1000);
    if (remaining > 0) {
        return `Please wait ${remaining} seconds before requesting another email.`;
    }
    const now = Date.now();
    emailCooldowns.set(key, now);
    try {
        sessionStorage.setItem(key, String(now));
    } catch {}
    return "";
}

export async function resendAdminVerificationEmail(email, password) {
    return loginAdmin(email, password, true);
}

export async function resetAdminPassword(email) {
    const throttleError = reserveEmailRequest("reset");
    if (throttleError) return { success: false, error: throttleError };
    const message = "If an account is eligible for password reset, a reset email will be sent. Check your inbox and spam folder.";
    try {
        await sendPasswordResetEmail(auth, email);
    } catch (error) {
        if (error.code === "auth/invalid-email") {
            return { success: false, error: "Please enter a valid email address." };
        }
        if (error.code === "auth/network-request-failed") {
            return { success: false, error: "Network error. Please check your internet connection and try again later." };
        }
        // Account-specific failures and Firebase throttling use the same neutral response.
    }
    return { success: true, message };
}


// ============================================================
// LOGIN ADMIN
// ============================================================

export async function loginAdmin(email, password, resendVerification = false) {
    if (adminAuthenticationPending) return { success: false, error: "Authentication is already in progress." };
    if (resendVerification) {
        const error = reserveEmailRequest("verification");
        if (error) return { success: false, error };
    }
    adminAuthenticationPending = true;
    let keepSession = false;
    try {
        if (resendVerification) {
            const { user } = await signInWithEmailAndPassword(auth, email, password);
            if (user.emailVerified) return { success: true, message: "Your email is already verified. Sign in with your email and password." };
            await sendEmailVerification(user);
            return { success: true, message: "Verification email sent. Verify your email, then sign in again." };
        }
        const { user } = await signInWithEmailAndPassword(auth, email, password);
        if (!user.emailVerified) return { success: false, error: "Verify your email first. Use Resend verification email, then sign in again." };
        const admin = await completeAdminAccess(user);
        keepSession = true;
        return { success: true, admin };
    } catch (error) {
        return { success: false, error: error.securityMessage || (
            error.code === "auth/invalid-credential" || error.code === "auth/wrong-password" || error.code === "auth/user-not-found"
                ? "Invalid email address or password."
                : error.code === "auth/too-many-requests" ? "Too many attempts. Please wait before trying again."
                : error.code === "auth/access-denied" ? error.message
                : "Unable to complete administrator authentication. Check your connection or contact IT.") };
    } finally {
        try { if (!keepSession && auth.currentUser) await signOut(auth); }
        finally { adminAuthenticationPending = false; }
    }
}

export async function getCurrentAdmin() {
    try {
        if (!auth.currentUser) return { success: false, error: "Sign in to continue." };
        return { success: true, admin: await getAdminSession(auth.currentUser) };
    } catch { return { success: false, error: "Administrator authentication is required. Contact IT if access was removed." }; }
}

export function protectAdminPage(callback) {
    return onAuthStateChanged(auth, async user => {
        try {
            if (!user) { window.location.href = "admin_login.html"; return; }
            const admin = await getAdminSession(user);
            if (auth.currentUser === user && typeof callback === "function") callback(admin);
        } catch {
            try { await signOut(auth); }
            finally { window.location.href = "admin_login.html"; }
        }
    });
}

export function redirectIfAdminLoggedIn() {
    return onAuthStateChanged(auth, async user => {
        if (!user || adminAuthenticationPending) return;
        try {
            if (!user.emailVerified || auth.currentUser !== user) return;
            await getAdminSession(user);
            if (!adminAuthenticationPending && auth.currentUser === user) window.location.href = "admin.html";
        } catch { /* No redirect without the backend's current administrator grant. */ }
    });
}

export async function getAdminApplications(admin) {
    if (
        admin.role !== "super_admin" &&
        !admin.region
    ) {
        throw new Error(
            "Your administrator profile needs a region before you can review applications."
        );
    }

    const applicationsQuery = admin.role === "super_admin"
        ? query(collection(db, "applications"))
        : query(
            collection(db, "applications"),
            where("region", "==", admin.region)
        );
    const snapshot = await getDocs(applicationsQuery);

    return snapshot.docs
        .map(applicationSnapshot => ({
            id: applicationSnapshot.id,
            ...applicationSnapshot.data()
        }))
        .sort((left, right) => {
            const leftTime = left.submittedAt?.seconds || 0;
            const rightTime = right.submittedAt?.seconds || 0;
            return rightTime - leftTime;
        });
}


export async function getAdminAuditEvents(admin) {
    if (
        admin.role !== "super_admin" &&
        !admin.region
    ) {
        throw new Error(
            "Your administrator profile needs a region before you can view audit events."
        );
    }

    const eventsQuery = admin.role === "super_admin"
        ? query(collection(db, "auditLogs"))
        : query(
            collection(db, "auditLogs"),
            where("region", "==", admin.region)
        );
    const snapshot = await getDocs(eventsQuery);

    return snapshot.docs
        .map(eventSnapshot => ({
            id: eventSnapshot.id,
            ...eventSnapshot.data()
        }))
        .sort((left, right) => {
            const leftTime = left.timestamp?.seconds || left.createdAt?.seconds || 0;
            const rightTime = right.timestamp?.seconds || right.createdAt?.seconds || 0;
            return rightTime - leftTime;
        })
        .slice(0, 100);
}


export async function startApplicationReview(applicationId, admin) {
    const applicationRef = doc(db, "applications", applicationId);
    await runTransaction(db, async transaction => {
        const applicationSnapshot = await transaction.get(applicationRef);
        if (!applicationSnapshot.exists()) {
            throw new Error("This application no longer exists.");
        }

        const application = applicationSnapshot.data();
        if (
            admin.role !== "super_admin" &&
            application.region !== admin.region
        ) {
            throw new Error("You are not authorized to review applications outside your region.");
        }
        if (application.status === "Under Review") return; // Retry never resets timestamps/audits.
        if (application.status !== "Submitted") throw new Error("Only submitted applications can be started for review.");

        transaction.update(applicationRef, {
            status: "Under Review",
            reviewStartedAt: serverTimestamp(),
            reviewedBy: admin.uid,
            reviewedByStaffNumber: admin.staffNumber || "",
            updatedAt: serverTimestamp()
        });

        // Must match the canonical ID enforced by hasReviewAudit() in the rules.
        const auditRef = doc(db, "auditLogs", `${applicationId}__REVIEW_STARTED`);
        transaction.set(auditRef, {
            action: "REVIEW_STARTED",
            adminId: admin.uid,
            staffNumber: admin.staffNumber || "",
            applicationId,
            applicationReference: application.applicationReference || applicationId,
            applicantId: application.applicantId || "",
            reason: "",
            timestamp: serverTimestamp(),
            region: application.region || ""
        });
    });
}


export async function reviewApplication(
    applicationId,
    decision,
    reason,
    admin
) {
    if (!["Approved", "Denied"].includes(decision)) {
        throw new Error("Choose either Approved or Denied.");
    }

    const cleanReason = reason.trim();
    if (decision === "Denied" && !cleanReason) {
        throw new Error("A denial reason is required.");
    }
    if (cleanReason.length > 1000) {
        throw new Error("Enter a decision reason of up to 1,000 characters.");
    }

    const applicationRef = doc(db, "applications", applicationId);
    await runTransaction(db, async transaction => {
        const applicationSnapshot =
            await transaction.get(applicationRef);

        if (!applicationSnapshot.exists()) {
            throw new Error("This application no longer exists.");
        }

        const application = applicationSnapshot.data();
        const status = String(application.status || "")
            .trim()
            .toLowerCase();


        if (
            admin.role !== "super_admin" &&
            application.region !== admin.region
        ) {
            throw new Error(
                "You are not authorized to review applications outside your region."
            );
        }
        if (application.status === decision && application.reviewedBy === admin.uid && application.decisionReason === cleanReason) return;
        if (status !== "under review") throw new Error("Start the review before recording a decision. Final decisions cannot be changed.");

        transaction.update(applicationRef, {
            status: decision,
            decisionReason: cleanReason,
            reviewedAt: serverTimestamp(),
            reviewedBy: admin.uid,
            reviewedByStaffNumber: admin.staffNumber || "",
            updatedAt: serverTimestamp()
        });

        const action = decision === "Approved" ? "APPLICATION_APPROVED" : "APPLICATION_DENIED";
        const auditRef = doc(db, "auditLogs", `${applicationId}__${action}`);
        transaction.set(auditRef, {
            action,
            adminId: admin.uid,
            staffNumber: admin.staffNumber || "",
            applicationId,
            applicationReference: application.applicationReference || applicationId,
            applicantId: application.applicantId || "",
            reason: cleanReason,
            timestamp: serverTimestamp(),
            region: application.region || ""
        });
        const notificationId = `${applicationId}__${decision}`;
        transaction.set(doc(db, "notificationOutbox", notificationId), {
            applicationId, applicantId: application.applicantId,
            applicationReference: application.applicationReference,
            region: application.region, status: decision, state: "pending", createdAt: serverTimestamp()
        });
        transaction.set(doc(db, "auditLogs", `${notificationId}__queued`), {
            action: "NOTIFICATION_QUEUED", actorUid: admin.uid, applicationId,
            notificationId, region: application.region, timestamp: serverTimestamp()
        });
    });
}

// ============================================================
// GET REGIONAL STATISTICS
// ============================================================

export async function getRegionalStats(region, role = "admin") {

    try {
        if (!region && role !== "super_admin") {
            throw new Error(
                "Your administrator profile needs a region before statistics can be loaded."
            );
        }

        const applicationsReference =
            collection(db, "applications");
        const applicationsQuery = role === "super_admin"
            ? query(applicationsReference)
            : query(
                applicationsReference,
                where("region", "==", region)
            );

        const applicationsSnapshot = await getDocs(applicationsQuery);

        const statuses = applicationsSnapshot.docs.map(
            application => String(application.data().status || "")
                .trim()
                .toLowerCase()
        );
        const countStatus = status =>
            statuses.filter(value => value === status).length;

        return {
            success: true,
            total: applicationsSnapshot.size,
            submitted: countStatus("submitted"),
            underReview: countStatus("under review"),
            approved: countStatus("approved"),
            denied: countStatus("denied")
        };


    } catch (error) {

        console.error(
            "Regional statistics error:",
            error
        );


        return {
            success: false,
            error: error.message
        };
    }
}


// ============================================================
// ADMIN LOGOUT
// ============================================================

export async function adminLogout() {

    try {

        await signOut(auth);


        window.location.href =
            "admin_login.html";


    } catch (error) {

        console.error(
            "Admin logout error:",
            error
        );


        alert(
            "Unable to log out. Please try again."
        );
    }
}
