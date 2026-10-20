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

    if (adminAuthenticationPending) {
        return { success: false, error: "An administrator authentication request is already in progress." };
    }
    if (resendVerification) {
        const throttleError = reserveEmailRequest("verification");
        if (throttleError) return { success: false, error: throttleError };
    }
    adminAuthenticationPending = true;
    let authenticated = false;
    let keepSession = false;

    try {

        // ----------------------------------------------------
        // STEP 1:
        // Authenticate the email and password with Firebase
        // ----------------------------------------------------

        const userCredential =
            await signInWithEmailAndPassword(
                auth,
                email,
                password
            );


        const user = userCredential.user;
        authenticated = true;


        // ----------------------------------------------------
        // STEP 2:
        // Require verified email
        // ----------------------------------------------------

        // ----------------------------------------------------
        // STEP 3:
        // Check if this Firebase user exists in admins
        //
        // Firestore structure:
        //
        // admins
        //    UID
        //       staffNumber
        //       email
        //       firstName
        //       lastName
        //       role
        //       region
        //       unit
        //       active
        //
        // ----------------------------------------------------

        const adminReference =
            doc(
                db,
                "admins",
                user.uid
            );


        const adminSnapshot =
            await getDoc(adminReference);


        // ----------------------------------------------------
        // User authenticated but is NOT an admin
        // ----------------------------------------------------

        if (!adminSnapshot.exists()) {

            await signOut(auth);

            return {
                success: false,
                error:
                    "This account is not registered as an authorized NamPol administrator."
            };
        }


        const adminData =
            adminSnapshot.data();


        // ----------------------------------------------------
        // STEP 4:
        // Check administrator account status
        // ----------------------------------------------------

        if (adminData.active !== true) {

            await signOut(auth);

            return {
                success: false,
                error:
                    "Your administrator account is inactive or has been disabled."
            };
        }


        // ----------------------------------------------------
        // STEP 5:
        // Check administrator role
        // ----------------------------------------------------

        if (
            !adminData.role ||
            !ALLOWED_ADMIN_ROLES.includes(
                adminData.role
            )
        ) {

            await signOut(auth);

            return {
                success: false,
                error:
                    "Your account does not have permission to access the administrator portal."
            };
        }


        // ----------------------------------------------------
        // STEP 6:
        // Successful admin authentication
        // ----------------------------------------------------

        if (resendVerification) {
            if (user.emailVerified) {
                return { success: true, message: "Your email is already verified. Please log in to continue." };
            }
            await sendEmailVerification(user);
            return {
                success: true,
                message: "Verification email sent. Check your inbox and spam folder, verify your email, then log in again."
            };
        }
        if (!user.emailVerified) {
            return {
                success: false,
                error: "Your email address has not been verified. Use Resend verification email with your email and password, then verify your email before logging in."
            };
        }
        keepSession = true;
        return {

            success: true,

            admin: {

                uid: user.uid,

                email: user.email,

                staffNumber:
                    adminData.staffNumber || "",

                firstName:
                    adminData.firstName || "",

                lastName:
                    adminData.lastName || "",

                role:
                    adminData.role,

                region:
                    adminData.region || "",

                unit:
                    adminData.unit || "",

                active:
                    adminData.active
            }
        };


    } catch (error) {

        console.error(
            "Admin login error:",
            error
        );


        let message =
            resendVerification
                ? "Unable to send a verification email. Please try again later."
                : "Unable to login. Please try again.";


        // ----------------------------------------------------
        // Friendly Firebase error messages
        // ----------------------------------------------------

        if (
            error.code === "auth/invalid-credential" ||
            error.code === "auth/wrong-password" ||
            error.code === "auth/user-not-found"
        ) {

            message =
                "Invalid email address or password.";
        }


        else if (
            error.code === "auth/invalid-email"
        ) {

            message =
                "Please enter a valid email address.";
        }


        else if (
            error.code === "auth/user-disabled"
        ) {

            message =
                "This Firebase account has been disabled.";
        }


        else if (
            error.code === "auth/too-many-requests"
        ) {

            message =
                "Too many unsuccessful login attempts. " +
                "Please wait and try again later.";
        }


        else if (
            error.code === "auth/network-request-failed"
        ) {

            message =
                "Network error. Please check your internet connection.";
        }


        return {
            success: false,
            error: message
        };
    } finally {
        try {
            if (authenticated && !keepSession) await signOut(auth);
        } finally {
            adminAuthenticationPending = false;
        }
    }
}


// ============================================================
// GET CURRENT ADMINISTRATOR
// ============================================================

export async function getCurrentAdmin() {

    const user =
        auth.currentUser;


    if (!user || !user.emailVerified) {

        return {
            success: false,
            error: "No administrator is currently logged in."
        };
    }


    try {

        const adminReference =
            doc(
                db,
                "admins",
                user.uid
            );


        const adminSnapshot =
            await getDoc(adminReference);


        if (!adminSnapshot.exists()) {

            return {
                success: false,
                error:
                    "Administrator profile was not found."
            };
        }


        const adminData =
            adminSnapshot.data();


        if (adminData.active !== true) {

            return {
                success: false,
                error:
                    "Administrator account is inactive."
            };
        }


        if (
            !adminData.role ||
            !ALLOWED_ADMIN_ROLES.includes(
                adminData.role
            )
        ) {

            return {
                success: false,
                error:
                    "Account does not have administrator privileges."
            };
        }


        return {

            success: true,

            admin: {

                uid: user.uid,

                email: user.email,

                ...adminData
            }
        };


    } catch (error) {

        console.error(
            "Get current admin error:",
            error
        );


        return {
            success: false,
            error:
                "Unable to verify administrator account."
        };
    }
}


// ============================================================
// PROTECT ADMIN PAGES
//
// Use this on admin.html.
//
// It checks:
//
// 1. Firebase session exists
// 2. User has an admins/{uid} document
// 3. Admin account is active
// 4. Role is permitted
//
// ============================================================

export function protectAdminPage(callback) {

    onAuthStateChanged(
        auth,
        async function (user) {

            // ------------------------------------------------
            // Nobody logged in
            // ------------------------------------------------

            if (!user) {

                window.location.href =
                    "admin_login.html";

                return;
            }


            try {

                // --------------------------------------------
                // Require verified email
                // --------------------------------------------

                if (!user.emailVerified) {

                    await signOut(auth);

                    window.location.href =
                        "admin_login.html";

                    return;
                }


                // --------------------------------------------
                // Get admin profile
                // --------------------------------------------

                const adminReference =
                    doc(
                        db,
                        "admins",
                        user.uid
                    );


                const adminSnapshot =
                    await getDoc(adminReference);


                // --------------------------------------------
                // Firebase user is not an administrator
                // --------------------------------------------

                if (!adminSnapshot.exists()) {

                    await signOut(auth);

                    window.location.href =
                        "admin_login.html";

                    return;
                }


                const adminData =
                    adminSnapshot.data();


                // --------------------------------------------
                // Admin disabled
                // --------------------------------------------

                if (adminData.active !== true) {

                    await signOut(auth);

                    window.location.href =
                        "admin_login.html";

                    return;
                }


                // --------------------------------------------
                // Invalid role
                // --------------------------------------------

                if (
                    !adminData.role ||
                    !ALLOWED_ADMIN_ROLES.includes(
                        adminData.role
                    )
                ) {

                    await signOut(auth);

                    window.location.href =
                        "admin_login.html";

                    return;
                }


                // --------------------------------------------
                // Administrator successfully verified
                // --------------------------------------------

                if (
                    typeof callback === "function"
                ) {

                    callback({

                        uid: user.uid,

                        email: user.email,

                        ...adminData
                    });
                }


            } catch (error) {

                console.error(
                    "Admin authorization error:",
                    error
                );


                try {

                    await signOut(auth);

                } catch (
                    logoutError
                ) {

                    console.error(
                        logoutError
                    );
                }


                window.location.href =
                    "admin_login.html";
            }
        }
    );
}


// ============================================================
// REDIRECT ADMIN IF ALREADY LOGGED IN
//
// Used on admin_login.html.
// ============================================================

export function redirectIfAdminLoggedIn() {

    onAuthStateChanged(
        auth,
        async function (user) {

            if (!user || adminAuthenticationPending) {
                return;
            }


            try {

                if (!user.emailVerified) {
                    return;
                }


                const adminReference =
                    doc(
                        db,
                        "admins",
                        user.uid
                    );


                const adminSnapshot =
                    await getDoc(adminReference);


                if (!adminSnapshot.exists()) {
                    return;
                }


                const adminData =
                    adminSnapshot.data();


                if (
                    !adminAuthenticationPending &&
                    auth.currentUser?.uid === user.uid &&
                    adminData.active === true &&
                    ALLOWED_ADMIN_ROLES.includes(
                        adminData.role
                    )
                ) {

                    window.location.href =
                        "admin.html";
                }


            } catch (error) {

                console.error(
                    "Existing admin session check error:",
                    error
                );
            }
        }
    );
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
        if (application.status !== "Submitted") {
            throw new Error("Only submitted applications can be started for review.");
        }
        if (
            admin.role !== "super_admin" &&
            application.region !== admin.region
        ) {
            throw new Error("You are not authorized to review applications outside your region.");
        }

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

        if (status !== "under review") {
            throw new Error("Start the review before recording a decision.");
        }

        if (
            admin.role !== "super_admin" &&
            application.region !== admin.region
        ) {
            throw new Error(
                "You are not authorized to review applications outside your region."
            );
        }

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
