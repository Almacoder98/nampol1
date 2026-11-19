import { auth, db } from "./firebase-config.js";

import {
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
    doc,
    getDoc,
    serverTimestamp,
    writeBatch
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";


const loadingScreen = document.getElementById("loadingScreen");
const profilePage = document.getElementById("profilePage");
const profileForm = document.getElementById("profileForm");
const logoutBtn = document.getElementById("logoutBtn");
const saveBtn = document.getElementById("saveBtn");
const alertBox = document.getElementById("alertBox");


const firstName = document.getElementById("firstName");
const lastName = document.getElementById("lastName");
const idNumber = document.getElementById("idNumber");
const dateOfBirth = document.getElementById("dateOfBirth");
const gender = document.getElementById("gender");
const email = document.getElementById("email");

const phone = document.getElementById("phone");
const address = document.getElementById("address");
const region = document.getElementById("region");

const highestQualification =
    document.getElementById("highestQualification");

const employmentStatus =
    document.getElementById("employmentStatus");

const skills = document.getElementById("skills");
const academicPoints = document.getElementById("academicPoints");


let currentUser = null;
let currentProfile = null;
const profileSummary = document.getElementById("profileSummary");
const editProfileBtn = document.getElementById("editProfileBtn");
const cancelEditBtn = document.getElementById("cancelEditBtn");
const API_ORIGIN = ["localhost", "127.0.0.1"].includes(window.location.hostname)
    ? `${window.location.protocol}//${window.location.hostname}:8001` : window.location.origin;
const documentButtons = {
    cv: document.getElementById("viewCvBtn"),
    certificate: document.getElementById("viewCertificateBtn"),
    identification: document.getElementById("viewIdentificationBtn")
};
let savedDocumentSet = null;

function resetDocuments() {
    savedDocumentSet = null;
    for (const [kind, button] of Object.entries(documentButtons)) {
        document.getElementById(`${kind}FileName`).textContent = "—";
        button.classList.add("d-none");
    }
}

function assertCurrentUser(user) {
    if (auth.currentUser !== user || currentUser !== user) {
        throw new Error("Your session changed. Please reload your profile.");
    }
}

async function documentRequest(user, path) {
    assertCurrentUser(user);
    const token = await user.getIdToken(true);
    assertCurrentUser(user);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    try {
        const response = await fetch(`${API_ORIGIN}/api/me/document-sets${path}`, {
            headers: { Authorization: `Bearer ${token}` },
            credentials: "omit", cache: "no-store", redirect: "error", signal: controller.signal
        });
        assertCurrentUser(user);
        if (!response.ok) {
            throw new Error(response.status === 401 ? "Please log in again to view your documents."
                : response.status === 403 ? "Access to these documents was denied."
                    : "Unable to load your documents. Please try again.");
        }
        const result = path ? await response.blob() : await response.json();
        assertCurrentUser(user);
        return result;
    } finally { clearTimeout(timeout); }
}

async function loadUploadedDocuments(user) {
    resetDocuments();
    const result = await documentRequest(user, "");
    if (!Array.isArray(result.sets)) throw new Error("Unable to load your documents. Please reload.");
    savedDocumentSet = result.sets.filter(set => /^[a-f0-9]{32}$/.test(set.setId)
        && set.schemaVersion === 1 && set.state === "ready"
        && Object.keys(documentButtons).every(kind => {
            const file = set.documents?.[kind];
            return file?.scanStatus === "clean" && file.mimeType === "application/pdf"
                && file.fileSize > 0 && typeof file.fileName === "string";
        })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
    if (!savedDocumentSet) return;
    for (const [kind, button] of Object.entries(documentButtons)) {
        document.getElementById(`${kind}FileName`).textContent = savedDocumentSet.documents[kind].fileName;
        button.classList.remove("d-none");
    }
}

for (const [kind, button] of Object.entries(documentButtons)) {
    button.addEventListener("click", async () => {
        if (!currentUser || !savedDocumentSet || button.disabled) return;
        const user = currentUser;
        const setId = savedDocumentSet.setId;
        // Open synchronously so browser popup protection does not discard the view.
        const viewer = window.open("about:blank", "_blank");
        if (!viewer) { showAlert("Allow this page to open a new tab to view the PDF."); return; }
        viewer.opener = null;
        button.disabled = true;
        try {
            const blob = await documentRequest(user, `/${setId}/${kind}/download`);
            if (blob.type !== "application/pdf") throw new Error("The document service did not return a PDF.");
            const objectUrl = URL.createObjectURL(blob);
            viewer.location.href = objectUrl;
            setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
        } catch (error) {
            viewer.close();
            if (currentUser === user) showAlert(error.message || "Unable to open this PDF. Please try again.");
        } finally { button.disabled = false; }
    });
}

function showProfileSummary() {
    profileSummary.classList.remove("d-none");
    profileForm.classList.add("d-none");
}

editProfileBtn.addEventListener("click", () => {
    if (!currentProfile) return;
    hideAlert();
    profileSummary.classList.add("d-none");
    profileForm.classList.remove("d-none");
    cancelEditBtn.classList.remove("d-none");
    saveBtn.textContent = "Save Profile";
    phone.focus();
});

cancelEditBtn.addEventListener("click", () => {
    if (!currentProfile || saveBtn.disabled) return;
    populateProfile(currentProfile, currentUser);
    hideAlert();
    showProfileSummary();
});


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


function showProfilePage() {
    loadingScreen.classList.add("d-none");
    profilePage.classList.remove("d-none");
}


function populateProfile(data, user) {

    document.getElementById("savedFullName").textContent = [data.firstName, data.lastName].filter(Boolean).join(" ");
    document.getElementById("savedEmail").textContent = user.email || data.email || "";
    document.getElementById("savedPhone").textContent = data.phone || "";
    document.getElementById("savedRegion").textContent = data.region || "";
    document.getElementById("savedAcademicPoints").textContent = Number.isSafeInteger(data.academicPoints) && data.academicPoints >= 0
        ? `${data.academicPoints} (applicant-declared; not verified)` : "Not recorded";
    academicPoints.value = Number.isSafeInteger(data.academicPoints) && data.academicPoints >= 0 ? String(data.academicPoints) : "";

    firstName.value = data.firstName || "";
    lastName.value = data.lastName || "";
    idNumber.value = data.idNumber || "";
    dateOfBirth.value = data.dateOfBirth || "";
    gender.value = data.gender || "";

    email.value = data.email || user.email || "";

    phone.value = data.phone || "";
    address.value = data.address || "";
    region.value = data.region || "";
    region.disabled = data.profileCompleted === true;

    highestQualification.value =
        data.highestQualification || "";

    employmentStatus.value =
        data.employmentStatus || "";

    if (Array.isArray(data.skills)) {
        skills.value = data.skills.join(", ");
    } else {
        skills.value = data.skills || "";
    }
}


async function loadApplicantProfile(user) {

    try {

        const userRef = doc(db, "users", user.uid);
        const userSnapshot = await getDoc(userRef);
        if (currentUser !== user || auth.currentUser !== user) return;

        if (!userSnapshot.exists()) {

            await signOut(auth);

            alert(
                "Your applicant profile could not be found. " +
                "Please contact the system administrator."
            );

            window.location.href = "login.html";
            return;
        }


        const data = userSnapshot.data();

        if (data.role !== "applicant") {

            await signOut(auth);

            alert("Access denied.");

            window.location.href = "login.html";
            return;
        }


        if (data.accountStatus !== "active") {

            await signOut(auth);

            alert(
                "Your account is not currently active."
            );

            window.location.href = "login.html";
            return;
        }


        currentProfile = data;

        populateProfile(data, user);

        if (data.profileCompleted === true) {
            showProfileSummary();
        } else {
            profileSummary.classList.add("d-none");
            profileForm.classList.remove("d-none");
        }

        showProfilePage();
        if (data.profileCompleted === true) {
            try { await loadUploadedDocuments(user); }
            catch (error) {
                if (currentUser === user) showAlert(error.message || "Unable to load your documents. Please try again.");
            }
        }

    } catch (error) {

        if (currentUser !== user || auth.currentUser !== user) return;

        console.error(
            "Error loading applicant profile:",
            error
        );

        loadingScreen.classList.add("d-none");
        profilePage.classList.remove("d-none");

        showAlert(
            "Unable to load your profile. Please refresh the page and try again."
        );
    }
}


onAuthStateChanged(auth, async (user) => {

    currentUser = null;
    currentProfile = null;
    resetDocuments();
    hideAlert();
    profileSummary.classList.add("d-none");
    profileForm.classList.add("d-none");
    cancelEditBtn.classList.add("d-none");
    profilePage.classList.add("d-none");
    loadingScreen.classList.remove("d-none");

    if (!user) {
        window.location.href = "login.html";
        return;
    }


    if (!user.emailVerified) {

        await signOut(auth);

        alert(
            "Please verify your email address before accessing your profile."
        );

        window.location.href = "login.html";
        return;
    }


    currentUser = user;

    await loadApplicantProfile(user);
});


profileForm.addEventListener(
    "submit",
    async (event) => {

        event.preventDefault();

        hideAlert();


        if (!currentUser || !currentProfile || auth.currentUser !== currentUser || saveBtn.disabled) {

            showAlert(
                "Your session is not ready. Please refresh the page."
            );

            return;
        }


        const phoneValue = phone.value.trim();
        const addressValue = address.value.trim();
        const regionValue = region.value.trim();

        const qualificationValue =
            highestQualification.value.trim();

        const employmentValue =
            employmentStatus.value.trim();

        const pointsText = academicPoints.value.trim();
        const pointsValue = pointsText === "" ? null : Number(pointsText);
        if (pointsValue !== null && (!Number.isSafeInteger(pointsValue) || pointsValue < 0)) {
            showAlert("Enter a non-negative whole number for academic points, or leave it blank.", "warning");
            academicPoints.focus();
            return;
        }


        if (
            !phoneValue ||
            !addressValue ||
            !regionValue ||
            !qualificationValue ||
            !employmentValue
        ) {

            showAlert(
                "Please complete all required profile fields.",
                "warning"
            );

            return;
        }


        const skillsArray = skills.value
            .split(",")
            .map(skill => skill.trim())
            .filter(skill => skill.length > 0);


        saveBtn.disabled = true;
        saveBtn.textContent = "Saving Profile...";
        cancelEditBtn.disabled = true;
        const user = currentUser;
        const wasCompleted = currentProfile.profileCompleted === true;


        try {

            const userRef = doc(
                db,
                "users",
                user.uid
            );


            const batch = writeBatch(db);
            // FIX: Using set with merge:true prevents batch failures if the doc 
            // is missing or if certain fields are restricted by security rules.
            batch.set(userRef, {

                phone: phoneValue,

                address: addressValue,

                // Ensure we don't save 'undefined' if region is disabled/locked
                region: wasCompleted ? (currentProfile.region || regionValue) : regionValue,

                highestQualification:
                    qualificationValue,

                // Preserve existing profile saves until the optional field is
                // actually edited; old profiles need no migration/default write.
                ...((currentProfile.academicPoints ?? null) !== pointsValue ? { academicPoints: pointsValue } : {}),

                employmentStatus:
                    employmentValue,

                skills: skillsArray,

                profileCompleted: true,

                updatedAt: serverTimestamp()

            }, { merge: true }); // <--- CRITICAL FIX ADDED HERE

            await batch.commit();
            if (currentUser !== user || auth.currentUser !== user) return;

            if (wasCompleted) {
                currentProfile = { ...currentProfile, phone: phoneValue, address: addressValue, academicPoints: pointsValue,
                    highestQualification: qualificationValue, employmentStatus: employmentValue, skills: skillsArray };
                populateProfile(currentProfile, user);
                showProfileSummary();
                showAlert("Profile saved.", "success");
                return;
            }


            showAlert(
                "Profile completed successfully. Redirecting to your dashboard...",
                "success"
            );


            setTimeout(() => {
                if (currentUser !== user || auth.currentUser !== user) return;
                window.location.href =
                    "documents.html";

            }, 1500);


        } catch (error) {

            console.error(
                "Error saving profile:",
                error
            );
            
            // Added specific error logging to help debug
            if (error.code === 'permission-denied') {
                showAlert("Permission denied. You do not have permission to update this profile.");
            } else {
                showAlert(
                    "Unable to save your profile. Please try again."
                );
            }


        } finally {
            saveBtn.disabled = false;
            cancelEditBtn.disabled = false;
            saveBtn.textContent = wasCompleted ? "Save Profile" : "Save and Continue";
        }
    }
);


logoutBtn.addEventListener(
    "click",
    async () => {

        try {

            await signOut(auth);

            window.location.href =
                "login.html";

        } catch (error) {

            console.error(
                "Logout error:",
                error
            );

            showAlert(
                "Unable to log out. Please try again."
            );
        }
    }
);