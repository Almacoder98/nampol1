import { db } from "./firebase-config.js";
import { collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// Only published, open vacancies are returned to applicant-facing pages.
export async function getOpenJobs() {
    const snapshot = await getDocs(query(
        collection(db, "jobs"),
        where("status", "==", "Open"),
        where("published", "==", true)
    ));
    return snapshot.docs.map(item => ({ id: item.id, ...item.data() }))
        .sort((a, b) => String(a.title || "").localeCompare(String(b.title || "")));
}
