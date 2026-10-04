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
    writeBatch,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { appendAuditEvent } from "./audit.js";


// ============================================================
// ALLOWED ADMIN ROLES
// ============================================================

const ALLOWED_ADMIN_ROLES = [
    "admin",
    "recruiter",
    "super_admin"
];


// ============================================================
// LOGIN ADMIN
// ============================================================

export async function loginAdmin(email, password) {

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


        // ----------------------------------------------------
        // STEP 2:
        // Require verified email
        // ----------------------------------------------------

        if (!user.emailVerified) {

            await signOut(auth);

            return {
                success: false,
                error:
                    "Your email address has not been verified. " +
                    "Please verify your email before logging in."
            };
        }


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
            "Unable to login. Please try again.";


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
    }
}


// ============================================================
// GET CURRENT ADMINISTRATOR
// ============================================================

export async function getCurrentAdmin() {

    const user =
        auth.currentUser;


    if (!user) {

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

            if (!user) {
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
            const leftTime = left.createdAt?.seconds || 0;
            const rightTime = right.createdAt?.seconds || 0;
            return rightTime - leftTime;
        })
        .slice(0, 100);
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
    if (!cleanReason || cleanReason.length > 1000) {
        throw new Error(
            "Enter a decision reason of up to 1,000 characters."
        );
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
            ["approved", "denied", "rejected", "shortlisted"]
                .includes(status)
        ) {
            throw new Error(
                "This application already has a final decision."
            );
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

        appendAuditEvent(transaction, {
            action: `application.${decision.toLowerCase()}`,
            actorUid: admin.uid,
            actorRole: admin.role,
            actorStaffNumber: admin.staffNumber || "",
            targetApplicantId: application.applicantId,
            region: application.region || "",
            entityType: "application",
            entityId: applicationId,
            details: {
                applicationReference:
                    application.applicationReference || applicationId,
                decision,
                reason: cleanReason
            }
        });
    });
}

export async function recordDocumentAccess(admin, applicantId, region) {
    const batch = writeBatch(db);
    appendAuditEvent(batch, {
        action: "admin.documents_accessed",
        actorUid: admin.uid,
        actorRole: admin.role,
        actorStaffNumber: admin.staffNumber || "",
        targetApplicantId: applicantId,
        region: region || "",
        entityType: "applicantDocuments",
        entityId: applicantId,
        details: {}
    });
    await batch.commit();
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
        const usersReference =
            collection(db, "users");

        const applicationsQuery =
            region
                ? query(
                    applicationsReference,
                    where("region", "==", region)
                )
                : query(applicationsReference);

        const usersQuery =
            region
                ? query(
                    usersReference,
                    where("region", "==", region)
                )
                : role === "super_admin"
                    ? query(usersReference)
                    : null;

        const [applicationsSnapshot, usersSnapshot] =
            await Promise.all([
                getDocs(applicationsQuery),
                usersQuery
                    ? getDocs(usersQuery)
                    : Promise.resolve(null)
            ]);

        const statuses = applicationsSnapshot.docs.map(
            application => String(application.data().status || "")
                .trim()
                .toLowerCase()
        );
        const pendingCount = statuses.filter(status =>
            ["submitted", "under review", "pending", "in progress"]
                .includes(status)
        ).length;
        const shortlistedCount = statuses.filter(status =>
            ["approved", "shortlisted"].includes(status)
        ).length;


        return {

            success: true,

            total:
                applicationsSnapshot.size,

            pending:
                pendingCount,

            shortlisted:
                shortlistedCount,

            users:
                usersSnapshot?.size ?? 0
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