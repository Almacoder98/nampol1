import { auth, db } from "./firebase-config.js";

import {
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
    doc,
    getDoc,
    serverTimestamp,
    writeBatch
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";


const MAX_FILE_SIZE = 5 * 1024 * 1024;


const loadingScreen =
    document.getElementById("loadingScreen");

const documentPage =
    document.getElementById("documentPage");

const documentForm =
    document.getElementById("documentForm");

const alertBox =
    document.getElementById("alertBox");

const saveDocumentsBtn =
    document.getElementById("saveDocumentsBtn");

const dashboardBtn =
    document.getElementById("dashboardBtn");


const cvFile =
    document.getElementById("cvFile");

const idFile =
    document.getElementById("idFile");

const certificateFile =
    document.getElementById("certificateFile");


const cvStatus =
    document.getElementById("cvStatus");

const idStatus =
    document.getElementById("idStatus");

const certificateStatus =
    document.getElementById("certificateStatus");


const cvInfo =
    document.getElementById("cvInfo");

const idInfo =
    document.getElementById("idInfo");

const certificateInfo =
    document.getElementById("certificateInfo");


const savedDocumentsSection =
    document.getElementById("savedDocumentsSection");

const savedDocumentsList =
    document.getElementById("savedDocumentsList");


let currentUser = null;
let currentUserData = null;


function showAlert(message, type = "danger") {

    alertBox.className = `alert alert-${type}`;
    alertBox.textContent = message;

    alertBox.classList.remove("d-none");

    window.scrollTo({
        top: 0,
        behavior: "smooth"
    });
}


function hideAlert() {

    alertBox.classList.add("d-none");
    alertBox.textContent = "";
}


function formatFileSize(bytes) {

    if (!bytes) {
        return "0 KB";
    }

    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}


function setSelectedStatus(
    statusElement,
    infoElement,
    file
) {

    if (!file) {

        statusElement.className =
            "badge bg-secondary status-badge";

        statusElement.textContent =
            "Not selected";

        infoElement.textContent = "";

        return;
    }


    statusElement.className =
        "badge bg-success status-badge";

    statusElement.textContent =
        "Selected";

    infoElement.textContent =
        `${file.name} — ${formatFileSize(file.size)}`;
}


function validateFile(
    file,
    allowedTypes,
    documentName
) {

    if (!file) {

        throw new Error(
            `${documentName} is required.`
        );
    }


    if (file.size > MAX_FILE_SIZE) {

        throw new Error(
            `${documentName} must be 5 MB or smaller.`
        );
    }

    if (file.size === 0) {

        throw new Error(
            `${documentName} cannot be an empty file.`
        );
    }


    if (!allowedTypes.includes(file.type)) {

        throw new Error(
            `${documentName} has an unsupported file type.`
        );
    }


    return true;
}


function createDocumentMetadata(
    file,
    documentType
) {

    return {

        documentType: documentType,

        fileName: file.name,

        fileSize: file.size,

        mimeType: file.type,

        storageMode: "prototype-metadata-only",

        uploaded: false,

        validationStatus: "validated",

        updatedAt: serverTimestamp()

    };
}


async function loadExistingDocuments(uid) {

    try {

        const documentsRef =
            doc(db, "applicantDocuments", uid);

        const snapshot =
            await getDoc(documentsRef);


        if (!snapshot.exists()) {
            return;
        }


        const data = snapshot.data();

        savedDocumentsSection.classList.remove(
            "d-none"
        );


        const cvName =
            data.cv?.fileName || "Not recorded";

        const idName =
            data.identification?.fileName ||
            "Not recorded";

        const certificateName =
            data.certificate?.fileName ||
            "Not recorded";


        savedDocumentsList.innerHTML = `
            <div class="list-group">

                <div class="list-group-item">
                    <strong>CV:</strong>
                    ${escapeHtml(cvName)}
                </div>

                <div class="list-group-item">
                    <strong>Identification:</strong>
                    ${escapeHtml(idName)}
                </div>

                <div class="list-group-item">
                    <strong>Certificate:</strong>
                    ${escapeHtml(certificateName)}
                </div>

                <div class="list-group-item">
                    <strong>Status:</strong>
                    Prototype-validated; metadata recorded in Firestore only.
                    Document authenticity has not been verified.
                </div>

            </div>
        `;

    } catch (error) {

        console.error(
            "Error loading document metadata:",
            error
        );
    }
}


function escapeHtml(value) {

    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}


cvFile.addEventListener(
    "change",
    () => {

        setSelectedStatus(
            cvStatus,
            cvInfo,
            cvFile.files[0]
        );
    }
);


idFile.addEventListener(
    "change",
    () => {

        setSelectedStatus(
            idStatus,
            idInfo,
            idFile.files[0]
        );
    }
);


certificateFile.addEventListener(
    "change",
    () => {

        setSelectedStatus(
            certificateStatus,
            certificateInfo,
            certificateFile.files[0]
        );
    }
);


onAuthStateChanged(
    auth,
    async (user) => {

        if (!user) {

            window.location.href =
                "login.html";

            return;
        }


        if (!user.emailVerified) {

            window.location.href =
                "login.html";

            return;
        }


        try {

            const userRef =
                doc(db, "users", user.uid);

            const snapshot =
                await getDoc(userRef);


            if (!snapshot.exists()) {

                window.location.href =
                    "login.html";

                return;
            }


            const userData =
                snapshot.data();

            if (userData.profileCompleted !== true) {
                window.location.href =
                    "profile.html";
                return;
            }

            if (
                userData.role !== "applicant" ||
                userData.accountStatus !== "active"
            ) {

                window.location.href =
                    "login.html";

                return;
            }


            currentUser = user;
            currentUserData = userData;


            await loadExistingDocuments(
                user.uid
            );


            loadingScreen.classList.add(
                "d-none"
            );

            documentPage.classList.remove(
                "d-none"
            );


        } catch (error) {

            console.error(
                "Document page authentication error:",
                error
            );


            loadingScreen.classList.add(
                "d-none"
            );

            documentPage.classList.remove(
                "d-none"
            );


            showAlert(
                "Unable to load the document centre."
            );
        }
    }
);


documentForm.addEventListener(
    "submit",
    async (event) => {

        event.preventDefault();

        hideAlert();


        if (!currentUser) {

            showAlert(
                "Your session has expired. Please log in again."
            );

            return;
        }


        const cv =
            cvFile.files[0];

        const identification =
            idFile.files[0];

        const certificate =
            certificateFile.files[0];


        try {

            validateFile(
                cv,
                ["application/pdf"],
                "Curriculum Vitae"
            );


            validateFile(
                identification,
                [
                    "application/pdf",
                    "image/jpeg",
                    "image/png"
                ],
                "Identification document"
            );


            validateFile(
                certificate,
                [
                    "application/pdf",
                    "image/jpeg",
                    "image/png"
                ],
                "Qualification certificate"
            );


        } catch (error) {

            showAlert(
                error.message,
                "warning"
            );

            return;
        }


        saveDocumentsBtn.disabled = true;

        saveDocumentsBtn.textContent =
            "Validating and Saving Metadata...";

        const metadataRef = doc(
            db,
            "applicantDocuments",
            currentUser.uid
        );

        try {
            const cvMetadata =
                createDocumentMetadata(cv, "cv");

            const identificationMetadata =
                createDocumentMetadata(
                    identification,
                    "identification"
                );

            const certificateMetadata =
                createDocumentMetadata(
                    certificate,
                    "qualification_certificate"
                );

            const userRef =
                doc(
                    db,
                    "users",
                    currentUser.uid
                );


            const batch = writeBatch(db);
            batch.set(metadataRef, {
                applicantId: currentUser.uid,
                cv: cvMetadata,
                identification: identificationMetadata,
                certificate: certificateMetadata,
                documentsValidated: true,
                prototypeMode: true,
                updatedAt: serverTimestamp()
            });
            batch.update(userRef, {
                documentsUploaded: true,
                documentStorageMode: "prototype-metadata-only",
                documentsUpdatedAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
            await batch.commit();

            await loadExistingDocuments(
                currentUser.uid
            );

            showAlert(
                "Prototype validation completed. Document metadata was recorded securely in Firestore; the files themselves were not uploaded or stored. Authenticity was not verified.",
                "success"
            );

            saveDocumentsBtn.disabled =
                false;

            saveDocumentsBtn.textContent =
                "Validate and Save Metadata";


        } catch (error) {

            console.error(
                "Error saving applicant document metadata:",
                error
            );

            showAlert(
                error.message ||
                "Unable to save your document metadata. Please try again."
            );


            saveDocumentsBtn.disabled =
                false;

            saveDocumentsBtn.textContent =
                "Validate and Save Metadata";
        }
    }
);


dashboardBtn.addEventListener(
    "click",
    () => {

        window.location.href =
            "dashboard.html";
    }
);
