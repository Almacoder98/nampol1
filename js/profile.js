import { auth, db } from "./firebase-config.js";

import {
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
    doc,
    getDoc,
    updateDoc,
    serverTimestamp,
    writeBatch
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { appendAuditEvent } from "./audit.js";


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


let currentUser = null;
let currentProfile = null;


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

        showProfilePage();

    } catch (error) {

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


        if (!currentUser || !currentProfile) {

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


        try {

            const userRef = doc(
                db,
                "users",
                currentUser.uid
            );


            const batch = writeBatch(db);
            batch.update(userRef, {

                phone: phoneValue,

                address: addressValue,

                region: regionValue,

                highestQualification:
                    qualificationValue,

                employmentStatus:
                    employmentValue,

                skills: skillsArray,

                profileCompleted: true,

                updatedAt: serverTimestamp()

            });

            appendAuditEvent(batch, {
                action: "applicant.profile_completed",
                actorUid: currentUser.uid,
                actorRole: "applicant",
                targetApplicantId: currentUser.uid,
                region: regionValue,
                entityType: "user",
                entityId: currentUser.uid,
                details: {}
            });

            await batch.commit();


            showAlert(
                "Profile completed successfully. Redirecting to your dashboard...",
                "success"
            );


            setTimeout(() => {

                window.location.href =
                    "documents.html";

            }, 1500);


        } catch (error) {

            console.error(
                "Error saving profile:",
                error
            );


            showAlert(
                "Unable to save your profile. Please try again."
            );


            saveBtn.disabled = false;
            saveBtn.textContent =
                "Save and Continue";
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