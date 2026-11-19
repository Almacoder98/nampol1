import {
    db,
    auth
} from "./firebase-config.js";


import {
    collection,
    doc,
    query,
    where,
    getDocs,
    getDoc,
    serverTimestamp,
    writeBatch
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";


// ============================================================
// GENERATE APPLICATION REFERENCE
// ============================================================

function generateApplicationReference() {

    const year =
        new Date().getFullYear();

    const randomPart = crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();

    return `NAMPOL-${year}-${randomPart}`;
}


// ============================================================
// CHECK FOR DUPLICATE APPLICATION
// ============================================================

async function applicationAlreadyExists(
    applicantId,
    position
) {

    const applicationsRef =
        collection(
            db,
            "applications"
        );


    const duplicateQuery =
        query(
            applicationsRef,

            where(
                "applicantId",
                "==",
                applicantId
            ),

            where(
                "position",
                "==",
                position
            )
        );


    const snapshot =
        await getDocs(
            duplicateQuery
        );


    return !snapshot.empty;
}


// ============================================================
// SUBMIT APPLICATION
// ============================================================

export async function getReadyDocumentSet(user) {
    if (!user || auth.currentUser !== user) throw new Error("Please log in again.");
    const token = await user.getIdToken(true);
    if (auth.currentUser !== user) throw new Error("Your session changed. Please log in again.");
    const origin = ["localhost", "127.0.0.1"].includes(window.location.hostname)
        ? `${window.location.protocol}//${window.location.hostname}:8001` : window.location.origin;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
        const response = await fetch(`${origin}/api/me/document-sets`, {
            headers: { Authorization: `Bearer ${token}` }, credentials: "omit",
            cache: "no-store", redirect: "error", signal: controller.signal
        });
        if (!response.ok) throw new Error("Unable to confirm your uploaded documents. Please reload and try again.");
        const result = await response.json();
        if (auth.currentUser !== user) throw new Error("Your session changed. Please log in again.");
        if (!Array.isArray(result.sets)) throw new Error("Unable to confirm your uploaded documents. Please reload and try again.");
        return result.sets.filter(set => /^[a-f0-9]{32}$/.test(set.setId)
            && set.state === "ready" && set.schemaVersion === 1
            && ["cv", "certificate", "identification"].every(kind => {
                const file = set.documents?.[kind];
                return file?.mimeType === "application/pdf" && file.scanStatus === "clean"
                    && typeof file.fileName === "string" && file.fileSize > 0 && file.fileSize <= 5242880;
            })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
    } finally { clearTimeout(timeout); }
}

export async function submitApplication(
    applicationData
) {
    let retryReference;
    try {

        const user = auth.currentUser;
        if (!user || user.uid !== applicationData.applicantId) throw new Error("Please log in again.");
        const identity = JSON.stringify([user.uid, applicationData.position, applicationData.vacancyId || null]);
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
        const applicationId = "app_" + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
        const applicationRef = doc(db, "applications", applicationId);
        retryReference = applicationRef;
        const previous = await getDoc(applicationRef);
        if (auth.currentUser !== user) throw new Error("Your session changed. Please log in again.");
        if (previous.exists()) {
            const record = previous.data();
            if (record.applicantId !== user.uid || record.position !== applicationData.position) throw new Error("Application reference conflict. Contact support.");
            return { success: true, id: applicationId, applicationReference: record.applicationReference };
        }
        // Recheck at submission; Firestore independently validates this immutable
        // server-owned manifest in the same commit as application creation.
        const documentSet = await getReadyDocumentSet(user);
        if (!documentSet) throw new Error("Please upload all three required documents before applying for a vacancy.");

        if (!applicationData.applicantId) {

            throw new Error(
                "Applicant ID is missing."
            );
        }


        if (!applicationData.position) {

            throw new Error(
                "Please select a position."
            );
        }


        const duplicate =
            await applicationAlreadyExists(
                applicationData.applicantId,
                applicationData.position
            );


        if (duplicate) {

            return {
                success: false,
                error:
                    "You have already submitted an application for this position."
            };
        }


        const applicationReference =
            generateApplicationReference();


        const applicationsRef =
            collection(
                db,
                "applications"
            );


        const documentReference = applicationRef;
        const batch = writeBatch(db);
        if (auth.currentUser !== user) throw new Error("Your session changed. Please log in again.");

        batch.set(
            documentReference,
            {
                applicationReference,

                applicantId:
                    applicationData.applicantId,

                applicantName:
                    applicationData.applicantName,

                applicantEmail:
                    applicationData.applicantEmail,

                position:
                    applicationData.position,

                // Stable vacancy reference; legacy choices remain unlinked and
                // receive an explicit "could not verify" screening result.
                vacancyId: applicationData.vacancyId || null,

                stationPreference:
                    applicationData.stationPreference,

                region:
                    applicationData.region,

                qualification:
                    applicationData.qualification,

                institution:
                    applicationData.institution,

                fieldOfStudy:
                    applicationData.fieldOfStudy,

                graduationYear:
                    applicationData.graduationYear,

                documentsValidated:
                    true,

                documentRecordId:
                    applicationData.applicantId,

                documentSetId: documentSet.setId,

                status:
                    "Submitted",

                verificationStatus:
                    "Pending",

                aiScreeningStatus:
                    "Not Screened",

                aiMatchScore:
                    null,

                skillsMatched:
                    [],

                skillsMissing:
                    [],

                submittedAt:
                    serverTimestamp(),

                reviewStartedAt:
                    null,

                reviewedAt:
                    null,

                reviewedBy:
                    null,

                reviewedByStaffNumber:
                    null,

                decisionReason:
                    null,

                updatedAt:
                    serverTimestamp()
            }
        );

        batch.set(doc(db, "serverApplicationDocumentBindings", documentReference.id), {
            applicationId: documentReference.id, ownerUid: user.uid,
            setId: documentSet.setId, boundAt: serverTimestamp()
        });
        batch.set(doc(db, "auditLogs", `${documentReference.id}__DOCUMENT_SET_BOUND`), {
            action: "DOCUMENT_SET_BOUND", actorUid: user.uid, actorRole: "applicant",
            applicationId: documentReference.id, setId: documentSet.setId,
            region: applicationData.region, timestamp: serverTimestamp()
        });
        await batch.commit();

        return {

            success: true,

            id:
                documentReference.id,

            applicationReference:
                applicationReference
        };


    } catch (error) {

        // A lost commit response or concurrent tab must not create/rebind a second
        // application. Read back the same deterministic reference before reporting failure.
        if (retryReference && auth.currentUser?.uid === applicationData.applicantId) {
            try {
                const saved = await getDoc(retryReference);
                if (saved.exists() && auth.currentUser?.uid === applicationData.applicantId
                    && saved.data().applicantId === applicationData.applicantId
                    && saved.data().position === applicationData.position) {
                    return { success: true, id: retryReference.id, applicationReference: saved.data().applicationReference };
                }
            } catch { /* Preserve the original failure when reconciliation is unavailable. */ }
        }

        console.error(
            "Application submission error:",
            error
        );


        return {

            success: false,

            error:
                error.message ||
                "Application submission failed."
        };
    }
}
