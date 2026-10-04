import { db } from './firebase-config.js';
import { 
    collection, 
    addDoc, 
    getDocs, 
    getDoc, 
    doc, 
    updateDoc, 
    deleteDoc,
    query,
    where,
    orderBy,
    limit,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ==================== APPLICATIONS ====================

// SUBMIT APPLICATION
export async function submitApplication(applicationData) {
    try {
        const applicationId = `NAP-${new Date().getFullYear()}-${Math.floor(10000 + Math.random() * 90000)}`;
        
        const docRef = await addDoc(collection(db, "applications"), {
            ...applicationData,
            applicationId: applicationId,
            submittedAt: serverTimestamp(),
            status: 'pending'
        });
        
        return { success: true, id: docRef.id, applicationId: applicationId };
    } catch (error) {
        console.error("Application submission error:", error);
        return { success: false, error: error.message };
    }
}

// GET APPLICATIONS BY USER
export async function getUserApplications(userId) {
    try {
        const q = query(
            collection(db, "applications"),
            where("userId", "==", userId)
        );
        const querySnapshot = await getDocs(q);
        const applications = [];
        querySnapshot.forEach((doc) => {
            applications.push({ id: doc.id, ...doc.data() });
        });
        return { success: true, data: applications };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// GET ALL APPLICATIONS (ADMIN) - filtered by region
export async function getAllApplications(region = null) {
    try {
        let q;
        if (region) {
            q = query(
                collection(db, "applications"),
                where("region", "==", region)
            );
        } else {
            q = query(collection(db, "applications"));
        }
        
        const querySnapshot = await getDocs(q);
        const applications = [];
        querySnapshot.forEach((doc) => {
            applications.push({ id: doc.id, ...doc.data() });
        });
        return { success: true, data: applications };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// GET APPLICATION BY ID
export async function getApplicationById(applicationId) {
    try {
        const docRef = doc(db, "applications", applicationId);
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
            return { success: true, data: { id: docSnap.id, ...docSnap.data() } };
        } else {
            return { success: false, error: "Application not found" };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// UPDATE APPLICATION STATUS (ADMIN)
export async function updateApplicationStatus(applicationId, status, adminNotes = '') {
    try {
        const docRef = doc(db, "applications", applicationId);
        await updateDoc(docRef, {
            status: status,
            adminNotes: adminNotes,
            updatedAt: serverTimestamp()
        });
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// ==================== AUDIT LOGS ====================

// ADD AUDIT LOG
export async function addAuditLog(action, actor, details, severity = 'ACTION', region = 'Unknown') {
    try {
        await addDoc(collection(db, "auditLogs"), {
            timestamp: serverTimestamp(),
            actionType: action,
            actor: actor,
            details: details,
            severity: severity,
            region: region
        });
        return { success: true };
    } catch (error) {
        console.error("Audit log error:", error);
        return { success: false, error: error.message };
    }
}

// GET AUDIT LOGS (ADMIN)
export async function getAuditLogs(maxResults = 50, region = null) {
    try {
        let q;
        if (region) {
            q = query(
                collection(db, "auditLogs"),
                where("region", "==", region),
                limit(maxResults)
            );
        } else {
            q = query(
                collection(db, "auditLogs"),
                limit(maxResults)
            );
        }
        
        const querySnapshot = await getDocs(q);
        const logs = [];
        querySnapshot.forEach((doc) => {
            logs.push({ id: doc.id, ...doc.data() });
        });
        return { success: true, data: logs };
    } catch (error) {
        return { success: false, error: error.message };
    }
}