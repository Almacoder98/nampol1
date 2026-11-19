// ============================================================
// NAMPOL RECRUITMENT SYSTEM
// APPLICANT AUTHENTICATION
// ============================================================

import {
    auth,
    db
} from "./firebase-config.js";


import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signOut,
    onAuthStateChanged,
    sendEmailVerification,
    sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";


import {
    doc,
    getDoc,
    serverTimestamp,
    writeBatch
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";


// ============================================================
// REGISTER APPLICANT
// ============================================================

export async function registerUser(
    email,
    password,
    userData
) {

    try {

        // ----------------------------------------------------
        // 1. CREATE FIREBASE AUTHENTICATION ACCOUNT
        // ----------------------------------------------------

        const userCredential =
            await createUserWithEmailAndPassword(
                auth,
                email,
                password
            );


        const user =
            userCredential.user;


        try {

            // ------------------------------------------------
            // 2. CREATE APPLICANT RECORD IN FIRESTORE
            // ------------------------------------------------

            const userReference = doc(db, "users", user.uid);
            const batch = writeBatch(db);

            batch.set(userReference, {
                uid:
                    user.uid,

                email:
                    email.toLowerCase(),

                firstName:
                    userData.firstName,

                lastName:
                    userData.lastName,

                idNumber:
                    userData.idNumber,

                dateOfBirth:
                    userData.dateOfBirth,

                gender:
                    userData.gender,

                phone:
                    userData.phone,

                address:
                    userData.address,

                region:
                    userData.region,


                // ----------------------------------------
                // SECURITY / ROLE
                // ----------------------------------------

                role:
                    "applicant",

                accountStatus:
                    "active",

                profileCompleted:
                    false,

                documentsUploaded:
                    false,


                // This value describes the Firestore
                // profile at creation time.
                // Actual email verification is always
                // checked from Firebase Authentication.
                emailVerificationPending:
                    true,


                createdAt:
                    serverTimestamp(),

                updatedAt:
                    serverTimestamp()
            });

            await batch.commit();


            // ------------------------------------------------
            // 3. SEND FIREBASE EMAIL VERIFICATION
            // ------------------------------------------------

            await sendEmailVerification(
                user
            );


            // ------------------------------------------------
            // 4. SIGN OUT UNTIL EMAIL IS VERIFIED
            // ------------------------------------------------

            await signOut(auth);


            return {

                success: true,

                message:
                    "Registration successful. Please verify your email."
            };


        } catch (setupError) {

            console.error(
                "Applicant setup error:",
                setupError
            );


            // If the Auth account was created but something
            // else failed, sign out instead of leaving an
            // incomplete authenticated session.

            try {

                await signOut(auth);

            } catch (logoutError) {

                console.error(
                    "Sign-out after setup failure:",
                    logoutError
                );
            }


            return {

                success: false,

                error:
                    "Your account was created, but registration could not be completed. Please contact support before trying again."
            };
        }


    } catch (error) {

        console.error(
            "Applicant registration error:",
            error
        );


        let message =
            "Unable to create your account. Please try again.";


        if (
            error.code ===
            "auth/email-already-in-use"
        ) {

            message =
                "An account already exists with this email address.";
        }


        else if (
            error.code ===
            "auth/invalid-email"
        ) {

            message =
                "Please enter a valid email address.";
        }


        else if (
            error.code ===
            "auth/weak-password"
        ) {

            message =
                "Your password is too weak. Please choose a stronger password.";
        }


        else if (
            error.code ===
            "auth/network-request-failed"
        ) {

            message =
                "Network error. Please check your internet connection.";
        }


        else if (
            error.code ===
            "auth/operation-not-allowed"
        ) {

            message =
                "Email/password registration is not enabled in Firebase Authentication.";
        }


        return {

            success: false,

            error:
                message
        };
    }
}


// ============================================================
// LOGIN APPLICANT
// ============================================================

export async function loginUser(
    email,
    password
) {

    try {

        // ----------------------------------------------------
        // 1. FIREBASE LOGIN
        // ----------------------------------------------------

        const userCredential =
            await signInWithEmailAndPassword(
                auth,
                email,
                password
            );


        const user =
            userCredential.user;


        // ----------------------------------------------------
        // 2. EMAIL MUST BE VERIFIED
        // ----------------------------------------------------

        if (!user.emailVerified) {

            await signOut(auth);


            return {

                success: false,

                needsVerification: true,

                error:
                    "Your email address has not been verified. Please check your email and verify your account before logging in."
            };
        }


        // ----------------------------------------------------
        // 3. GET USER RECORD
        // ----------------------------------------------------

        const userReference =
            doc(
                db,
                "users",
                user.uid
            );


        const userSnapshot =
            await getDoc(
                userReference
            );


        if (!userSnapshot.exists()) {

            await signOut(auth);


            return {

                success: false,

                error:
                    "Your applicant profile could not be found."
            };
        }


        const userData =
            userSnapshot.data();


        // ----------------------------------------------------
        // 4. ONLY APPLICANTS USE THIS LOGIN
        // ----------------------------------------------------

        if (
            userData.role !==
            "applicant"
        ) {

            await signOut(auth);


            return {

                success: false,

                error:
                    "This account cannot use the applicant portal."
            };
        }


        // ----------------------------------------------------
        // 5. CHECK ACCOUNT STATUS
        // ----------------------------------------------------

        if (
            userData.accountStatus &&
            userData.accountStatus !== "active"
        ) {

            await signOut(auth);


            return {

                success: false,

                error:
                    "Your applicant account is currently inactive."
            };
        }


        // ----------------------------------------------------
        // 6. UPDATE VERIFICATION STATE IN FIRESTORE
        // ----------------------------------------------------

        try {

            const batch = writeBatch(db);
            batch.set(userReference, {

                emailVerificationPending:
                    false,

                emailVerified:
                    true,

                lastLoginAt:
                    serverTimestamp(),

                updatedAt:
                    serverTimestamp()
            }, { merge: true });

            await batch.commit();

        } catch (updateError) {

            console.error(
                "Could not update applicant verification metadata:",
                updateError
            );
        }


        return {

            success: true,

            user:
                user,

            data:
                userData
        };


    } catch (error) {

        console.error("Applicant authentication failed.");


        let message =
            "Unable to login. Please try again.";


        if (
            error.code === "auth/invalid-credential" ||
            error.code === "auth/wrong-password" ||
            error.code === "auth/user-not-found"
        ) {

            message =
                "Invalid email address or password.";
        }


        else if (
            error.code ===
            "auth/invalid-email"
        ) {

            message =
                "Please enter a valid email address.";
        }


        else if (
            error.code ===
            "auth/user-disabled"
        ) {

            message =
                "This account has been disabled.";
        }


        else if (
            error.code ===
            "auth/too-many-requests"
        ) {

            message =
                "Too many unsuccessful login attempts. Please wait and try again later.";
        }


        else if (
            error.code ===
            "auth/network-request-failed"
        ) {

            message =
                "Network error. Please check your internet connection.";
        }


        return {

            success: false,

            error:
                error.securityMessage || message
        };
    }
}


// ============================================================
// RESEND EMAIL VERIFICATION
// ============================================================

export async function resendVerificationEmail(
    email,
    password
) {

    try {

        const userCredential =
            await signInWithEmailAndPassword(
                auth,
                email,
                password
            );


        const user =
            userCredential.user;


        if (user.emailVerified) {

            await signOut(auth);


            return {

                success: false,

                alreadyVerified: true,

                error:
                    "This email address has already been verified. You can log in."
            };
        }


        await sendEmailVerification(
            user
        );


        await signOut(auth);


        return {

            success: true,

            message:
                "A new verification email has been sent."
        };


    } catch (error) {

        console.error(
            "Resend verification error:",
            error
        );


        let message =
            "Unable to resend the verification email.";


        if (
            error.code === "auth/invalid-credential" ||
            error.code === "auth/wrong-password" ||
            error.code === "auth/user-not-found"
        ) {

            message =
                "Invalid email address or password.";
        }


        else if (
            error.code ===
            "auth/too-many-requests"
        ) {

            message =
                "Too many requests. Please wait before trying again.";
        }


        return {

            success: false,

            error:
                message
        };
    }
}


// ============================================================
// LOGOUT APPLICANT
// ============================================================

export async function logoutUser() {

    try {

        await signOut(auth);


        return {
            success: true
        };


    } catch (error) {

        console.error(
            "Logout error:",
            error
        );


        return {

            success: false,

            error:
                error.message
        };
    }
}


// ============================================================
// CHECK AUTHENTICATION STATE
// ============================================================

export function checkAuthState(
    callback
) {

    onAuthStateChanged(
        auth,
        async function (user) {
            try { callback(user && user.emailVerified && auth.currentUser === user ? user : null); }
            catch { callback(null); }
        }
    );
}


// ============================================================
// GET CURRENT FIREBASE USER
// ============================================================

export function getCurrentUser() {

    return auth.currentUser;
}


// ============================================================
// GET APPLICANT DATA
// ============================================================

export async function getUserData(
    uid
) {

    try {

        const userReference =
            doc(
                db,
                "users",
                uid
            );


        const userSnapshot =
            await getDoc(
                userReference
            );


        if (!userSnapshot.exists()) {

            return {

                success: false,

                error:
                    "Applicant record not found."
            };
        }


        return {

            success: true,

            data:
                userSnapshot.data()
        };


    } catch (error) {

        console.error(
            "Get user data error:",
            error
        );


        return {

            success: false,

            error:
                error.message
        };
    }
}


// ============================================================
// RESET PASSWORD
// ============================================================

export async function resetPassword(
    email
) {

    try {

        await sendPasswordResetEmail(
            auth,
            email
        );


        return {

            success: true,

            message:
                "Password reset instructions have been sent to your email address."
        };


    } catch (error) {

        console.error(
            "Password reset error:",
            error
        );


        let message =
            "Unable to send password reset email.";


        if (
            error.code ===
            "auth/invalid-email"
        ) {

            message =
                "Please enter a valid email address.";
        }


        else if (
            error.code ===
            "auth/too-many-requests"
        ) {

            message =
                "Too many requests. Please wait and try again later.";
        }


        return {

            success: false,

            error:
                message
        };
    }
}
