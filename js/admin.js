import { db } from './firebase-config.js';
import { 
    collection, 
    query, 
    where, 
    getDocs
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// VERIFY ADMIN LOGIN
export async function verifyAdminLogin(adminCode, region) {
    try {
        const q = query(
            collection(db, "admins"),
            where("adminCode", "==", adminCode),
            where("region", "==", region)
        );
        const querySnapshot = await getDocs(q);
        
        if (!querySnapshot.empty) {
            const adminDoc = querySnapshot.docs[0];
            const adminData = adminDoc.data();
            return { 
                success: true, 
                admin: { id: adminDoc.id, ...adminData } 
            };
        } else {
            return { success: false, error: "Invalid admin credentials" };
        }
    } catch (error) {
        console.error("Admin verification error:", error);
        return { success: false, error: error.message };
    }
}

// GET REGIONAL STATS
export async function getRegionalStats(region) {
    try {
        // Total applications
        const appsQuery = query(
            collection(db, "applications"),
            where("region", "==", region)
        );
        const appsSnapshot = await getDocs(appsQuery);
        const totalApplications = appsSnapshot.size;
        
        // Pending applications
        const pendingQuery = query(
            collection(db, "applications"),
            where("region", "==", region),
            where("status", "==", "pending")
        );
        const pendingSnapshot = await getDocs(pendingQuery);
        const pendingCount = pendingSnapshot.size;
        
        // Shortlisted applications
        const shortlistedQuery = query(
            collection(db, "applications"),
            where("region", "==", region),
            where("status", "==", "shortlisted")
        );
        const shortlistedSnapshot = await getDocs(shortlistedQuery);
        const shortlistedCount = shortlistedSnapshot.size;
        
        // Registered users in region
        const usersQuery = query(
            collection(db, "users"),
            where("region", "==", region)
        );
        const usersSnapshot = await getDocs(usersQuery);
        const totalUsers = usersSnapshot.size;
        
        return {
            success: true,
            total: totalApplications,
            pending: pendingCount,
            shortlisted: shortlistedCount,
            users: totalUsers
        };
    } catch (error) {
        console.error("Stats error:", error);
        return { success: false, error: error.message };
    }
}

// CHECK IF ADMIN IS LOGGED IN (session check)
export function isAdminLoggedIn() {
    return localStorage.getItem('isAdminLoggedIn') === 'true';
}

// GET ADMIN DATA FROM SESSION
export function getAdminSession() {
    return {
        staffId: localStorage.getItem('adminStaffId'),
        region: localStorage.getItem('adminRegion'),
        adminCode: localStorage.getItem('adminCode'),
        isLoggedIn: localStorage.getItem('isAdminLoggedIn') === 'true'
    };
}

// LOGOUT ADMIN
export function adminLogout() {
    localStorage.removeItem('isAdminLoggedIn');
    localStorage.removeItem('adminStaffId');
    localStorage.removeItem('adminRegion');
    localStorage.removeItem('adminCode');
    localStorage.removeItem('adminData');
    window.location.href = 'admin_login.html';
}