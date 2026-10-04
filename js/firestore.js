import {
    db
} from "./firebase-config.js";


import {
    collection,
    doc,
    query,
    where,
    getDocs,
    serverTimestamp,
    writeBatch
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { appendAuditEvent } from "./audit.js";


// ============================================================
// GENERATE APPLICATION REFERENCE
// ============================================================

function generateApplicationReference() {

    const year =
        new Date().getFullYear();

    const randomPart =
        Math.random()
            .toString(36)
            .substring(2, 8)
            .toUpperCase();

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

export async function submitApplication(
    applicationData
) {

    try {

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


        const documentReference = doc(applicationsRef);
        const batch = writeBatch(db);

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

        appendAuditEvent(batch, {
            action: "application.submitted",
            actorUid: applicationData.applicantId,
            actorRole: "applicant",
            targetApplicantId: applicationData.applicantId,
            region: applicationData.region || "",
            entityType: "application",
            entityId: documentReference.id,
            details: {
                applicationReference,
                position: applicationData.position
            }
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