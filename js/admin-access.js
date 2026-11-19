import { auth, db } from "./firebase-config.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const ADMIN_ROLES = new Set(["admin", "recruiter", "super_admin"]);
const ADMIN_FIELDS = ["staffNumber", "firstName", "lastName", "email", "role", "region", "unit", "active"];

function accessDenied(message) {
    const error = new Error(message);
    error.code = "auth/access-denied";
    return error;
}

export async function getAdminSession(user) {
    if (!user || auth.currentUser !== user) {
        throw accessDenied("Your session changed. Please sign in again.");
    }
    if (!user.emailVerified) {
        throw accessDenied("Verify your email address before signing in.");
    }

    // Read the signed-in account's existing administrator record. Firestore
    // rules allow an own-record read and deny browser writes to admin records.
    let snapshot;
    try {
        snapshot = await getDoc(doc(db, "admins", user.uid));
    } catch (error) {
        if (error.code === "permission-denied") {
            throw accessDenied("The administrator record could not be read. The Firebase access rules need checking.");
        }
        throw accessDenied("Could not check administrator access. Check your connection and try again.");
    }
    if (auth.currentUser !== user) {
        throw accessDenied("Your session changed. Please sign in again.");
    }
    if (!user.emailVerified) {
        throw accessDenied("Verify your email address before signing in.");
    }
    if (!snapshot.exists()) {
        throw accessDenied("This email is not registered as an administrator. Use the applicant portal for applicant accounts.");
    }
    const record = snapshot.data();
    if (record.active !== true || !ADMIN_ROLES.has(record.role)) {
        throw accessDenied("This account does not have active administrator access.");
    }
    const admin = { uid: user.uid };
    for (const key of ADMIN_FIELDS) admin[key] = record[key] ?? "";
    return admin;
}
