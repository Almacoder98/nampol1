// ============================================================
// FIREBASE CONFIGURATION
// NamPol Recruitment System
// ============================================================

// Firebase App
import {
    initializeApp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";


// Firebase Authentication
import {
    getAuth
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";


// Cloud Firestore
import {
    getFirestore
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";


// Firebase Storage
import {
    getStorage
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";


// ============================================================
// FIREBASE PROJECT CONFIGURATION
// Project ID: nampol-recruitment
// ============================================================

const firebaseConfig = {

    apiKey:
        "AIzaSyC9DmLIJ0z6XFQirbkR2wptnekccXAKxGA",

    authDomain:
        "nampol-recruitment.firebaseapp.com",

    projectId:
        "nampol-recruitment",

    storageBucket:
        "nampol-recruitment.firebasestorage.app",

    messagingSenderId:
        "194261837190",

    appId:
        "1:194261837190:web:065bed508fd33773087807",

    measurementId:
        "G-Z6YR18G5HR"
};


// ============================================================
// INITIALIZE FIREBASE
// ============================================================

const app =
    initializeApp(firebaseConfig);


// ============================================================
// INITIALIZE FIREBASE SERVICES
// ============================================================

// Authentication
export const auth =
    getAuth(app);


// Firestore Database
export const db =
    getFirestore(app);


// Firebase Storage
export const storage =
    getStorage(app);


// Export Firebase application
export default app;