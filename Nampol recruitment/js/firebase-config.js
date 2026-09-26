// ============================================================
// FIREBASE CONFIGURATION - NamPol Recruitment System
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

// Your Firebase Config
const firebaseConfig = {
    apiKey: "AIzaSyA4vlINYtRkZ2fxu9pA9EiLLdcxV8r7RFM",
    authDomain: "nampol-recruitment-d72e2.firebaseapp.com",
    projectId: "nampol-recruitment-d72e2",
    storageBucket: "nampol-recruitment-d72e2.firebasestorage.app",
    messagingSenderId: "717836405400",
    appId: "1:717836405400:web:1123801fd43c5df04a5eed",
    measurementId: "G-VZSQY45JRC"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Export services
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
export default app;