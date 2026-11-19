import { auth } from "./firebase-config.js";
import { onIdTokenChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

// UX guard only. FastAPI and Firebase rules independently enforce authorization.
onIdTokenChanged(auth, async user => {
    if (!user) return;
    if (user.emailVerified && auth.currentUser === user) return;
    try { await signOut(auth); }
    finally { window.location.replace(window.location.pathname.endsWith("/admin.html") ? "admin_login.html" : "login.html"); }
});
