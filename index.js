// Example Node.js Server Endpoint (External to Flutter Project)
// File: server.js or a dedicated API route
require('dotenv').config();

const express = require('express');
const admin = require('firebase-admin');
const Buffer = require('buffer').Buffer;
const schedule = require("node-schedule");
const cors = require("cors");


// --- Initialization Logic for Service Account Key ---
const FIREBASE_SERVICE_ACCOUNT_KEY_STRING = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!FIREBASE_SERVICE_ACCOUNT_KEY_STRING) {
    console.error("FATAL ERROR: FIREBASE_SERVICE_ACCOUNT environment variable is not set.");
    process.exit(1);
}

let jsonString;
try {
    // The key is Base64 encoded. Decode it first.
    jsonString = Buffer.from(FIREBASE_SERVICE_ACCOUNT_KEY_STRING, 'base64').toString('utf8');
    console.log("Successfully decoded Base64 key.");
} catch (e) {
    console.error("FATAL ERROR: Could not decode Base64 key.", e);
    process.exit(1);
}


let serviceAccount;
try {
    serviceAccount = JSON.parse(jsonString);
} catch (e) {
    console.error("FATAL ERROR: Could not parse FIREBASE_SERVICE_ACCOUNT JSON string.", e);
    process.exit(1);
}

// 2. Initialize the Firebase Admin SDK using the credentials object.
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
}); 
// --- End Initialization Logic ---
const db = admin.firestore();

const app = express();
app.use(express.json());

app.use(cors());

const activeJobs = new Map();

// Helper function to fetch user's FCM token
async function getFCMToken(userId) {
    const userDoc = await admin.firestore().collection('users').doc(userId).get();
    return userDoc.data()?.fcmToken;
}

// Helper function to send the actual FCM message
async function sendFCM(token, payload) {
  try {
    const message = {
      tokens: [token], // array of device tokens
      notification: {
        title: payload.notification.title,
        body: payload.notification.body,
      },
      data: payload.data || {}, // optional custom data
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    console.log("✅ Notification sent successfully:", response);
  } catch (error) {
    console.error("❌ Error sending notification:", error);
  }
}

function cancelExistingJobs(walkId) {
    if (activeJobs.has(walkId)) {
        const jobs = activeJobs.get(walkId);
        if (jobs.activation) {
            jobs.activation.cancel();
            console.log(`🗑️ Cancelled activation job for walk ${walkId}`);
        }
        if (jobs.timeout) {
            jobs.timeout.cancel();
            console.log(`🗑️ Cancelled timeout job for walk ${walkId}`);
        }
        activeJobs.delete(walkId);
    }
}



app.post('/api/sendNotification', async (req, res) => {
  const { recipientId, type, data } = req.body;

  if (!recipientId || !type) {
    return res.status(400).send({ error: 'Missing recipientId or type' });
  }

  try {
    const recipientToken = await getFCMToken(recipientId);
    if (!recipientToken) {
      console.warn(`No FCM token found for user: ${recipientId}`);
      return res.status(200).send({ success: false, message: 'No token' });
    }

    let title = "aidKRIYA Update";
    let body = "";

    switch (type) {
      case "walk_request":
        title = "New Walk Request 🐾";
        body = "Someone requested you for a walk!";
        break;
      case "request_accepted":
        title = "Request Accepted ✅";
        body = "Your walk request has been accepted!";
        break;
      case "walk_started":
        title = "Walk Started 🚶";
        body = "Your walk has just started!";
        break;
      case "walk_Completed":
        title = "Walk Completed 🎉";
        body = "Your walk has been successfully completed!";
        break;
      case "walk_CancelledByWalker":
        title = "Walk Cancelled 🚫";
        body = "Your walker cancelled the walk.";
        break;
      case "walk_CancelledByWanderer":
        title = "Walk Cancelled 🚫";
        body = "The wanderer cancelled the walk.";
        break;
      case "chat_message":
        title = "New Message 💬";
        body = data?.text || "You have a new chat message.";
        break;
      default:
        body = "You have a new notification!";
    }

    const payload = {
      notification: { title, body },
      data: {
        type,
        walkId: data?.walkId || '',
        click_action: "FLUTTER_NOTIFICATION_CLICK",
      },
    };

    const response = await sendFCM(recipientToken, payload);
    return res.status(200).send({ success: true, response });
  } catch (error) {
    console.error("Error sending notification:", error);
    return res.status(500).send({ success: false, error: error.message });
  }
});

// --- Schedule Walk Endpoint (IMPROVED) ---
app.post("/api/schedule-walk", async (req, res) => {
    const startTime = Date.now();
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📅 [${new Date().toISOString()}] Schedule Walk Request`);
    console.log(`${'='.repeat(60)}`);
    
    const { walkId, senderId, recipientId, scheduledTimestampISO } = req.body;

    // Validation
    if (!walkId || !senderId || !recipientId || !scheduledTimestampISO) {
        console.error("❌ Missing required fields");
        return res.status(400).json({ 
            error: "Missing required fields",
            received: { walkId, senderId, recipientId, scheduledTimestampISO }
        });
    }

    let scheduledDate, timeoutDate;
    
    try {
        scheduledDate = new Date(scheduledTimestampISO);
        
        if (isNaN(scheduledDate.getTime())) {
            throw new Error("Invalid date format");
        }
        
        // Warn if date is in the past
        const now = new Date();
        if (scheduledDate < now) {
            console.warn("⚠️ Scheduled date is in the past. Adjusting to now + 1 minute");
            scheduledDate = new Date(now.getTime() + 60000);
        }
        
        timeoutDate = new Date(scheduledDate.getTime() + 5 * 60000); // 5 min after
        
        console.log(`📍 Walk ID: ${walkId}`);
        console.log(`👤 Sender: ${senderId}`);
        console.log(`🚶 Walker: ${recipientId}`);
        console.log(`⏰ Scheduled: ${scheduledDate.toISOString()}`);
        console.log(`⏱️  Timeout: ${timeoutDate.toISOString()}`);
        
    } catch (error) {
        console.error("❌ Date parsing error:", error.message);
        return res.status(400).json({ 
            error: "Invalid scheduledTimestampISO format",
            details: error.message 
        });
    }

    try {
        // Cancel any existing jobs for this walk (in case of rescheduling)
        cancelExistingJobs(walkId);

        // --- Activation Job ---
        const activationJob = schedule.scheduleJob(scheduledDate, async () => {
            console.log(`\n🟢 [ACTIVATION] Walk ${walkId} at ${new Date().toISOString()}`);
            
            try {
                const walkRef = db.collection("accepted_walks").doc(walkId);
                const walkDoc = await walkRef.get();

                if (!walkDoc.exists) {
                    console.log(`⚠️ Walk ${walkId} not found. Cleaning up.`);
                    cancelExistingJobs(walkId);
                    return;
                }

                const walkData = walkDoc.data();
                
                if (walkData.status !== "Accepted") {
                    console.log(`⚠️ Walk ${walkId} status: ${walkData.status}. Skipping activation.`);
                    cancelExistingJobs(walkId);
                    return;
                }

                if (walkData.activeWalkIdSet === true) {
                    console.log(`⚠️ Walk ${walkId} already activated. Skipping.`);
                    return;
                }

                // Activate the walk
                const batch = db.batch();
                batch.update(db.collection("users").doc(senderId), { activeWalkId: walkId });
                batch.update(db.collection("users").doc(recipientId), { activeWalkId: walkId });
                batch.update(walkRef, { 
                    activeWalkIdSet: true,
                    activatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                
                await batch.commit();
                console.log(`✅ Walk ${walkId} activated successfully`);
                
                // Send notifications
                const payload = {
                    notification: {
                        title: "Walk Starting Soon! ⏰",
                        body: "Your scheduled walk is starting now. Open the app to begin.",
                    },
                    data: { type: "walk_reminder", walkId }
                };
                
                const [senderToken, recipientToken] = await Promise.all([
                    getFCMToken(senderId),
                    getFCMToken(recipientId)
                ]);
                
                await Promise.all([
                    senderToken ? sendFCM(senderToken, payload) : null,
                    recipientToken ? sendFCM(recipientToken, payload) : null
                ]);
                
                console.log(`📲 Notifications sent for walk ${walkId}`);

            } catch (error) {
                console.error(`❌ Activation failed for ${walkId}:`, error.message);
            }
        });

        // --- Timeout Job ---
        const timeoutJob = schedule.scheduleJob(timeoutDate, async () => {
            console.log(`\n🔴 [TIMEOUT CHECK] Walk ${walkId} at ${new Date().toISOString()}`);
            
            try {
                const walkRef = db.collection("accepted_walks").doc(walkId);
                const walkDoc = await walkRef.get();

                if (!walkDoc.exists) {
                    console.log(`⚠️ Walk ${walkId} not found.`);
                    cancelExistingJobs(walkId);
                    return;
                }

                const walkData = walkDoc.data();

                if (walkData.status !== "Accepted") {
                    console.log(`✅ Walk ${walkId} status: ${walkData.status}. No expiration needed.`);
                    cancelExistingJobs(walkId);
                    return;
                }
                
                // Expire the walk
                console.log(`⏱️ Walk ${walkId} expired - not started within 5 minutes`);
                
                const batch = db.batch();
                batch.update(walkRef, { 
                    status: "Expired",
                    expiredAt: admin.firestore.FieldValue.serverTimestamp()
                });
                
                const requestRef = db.collection("requests").doc(walkId);
                const requestDoc = await requestRef.get();
                if (requestDoc.exists) {
                    batch.update(requestRef, { 
                        status: "Expired",
                        expiredAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                }

                batch.update(db.collection("users").doc(senderId), {
                    activeWalkId: admin.firestore.FieldValue.delete(),
                });
                batch.update(db.collection("users").doc(recipientId), {
                    activeWalkId: admin.firestore.FieldValue.delete(),
                });
                
                await batch.commit();
                console.log(`✅ Walk ${walkId} expired successfully`);

                // Send expiration notifications
                const payload = {
                    notification: {
                        title: "Walk Expired ⏱️",
                        body: "Your scheduled walk was not started in time and has expired.",
                    },
                    data: { type: "walk_expired", walkId }
                };
                
                const [senderToken, recipientToken] = await Promise.all([
                    getFCMToken(senderId),
                    getFCMToken(recipientId)
                ]);
                
                await Promise.all([
                    senderToken ? sendFCM(senderToken, payload) : null,
                    recipientToken ? sendFCM(recipientToken, payload) : null
                ]);

                // Clean up
                cancelExistingJobs(walkId);

            } catch (error) {
                console.error(`❌ Timeout failed for ${walkId}:`, error.message);
            }
        });

        // Store jobs in memory
        if (!activationJob || !timeoutJob) {
            throw new Error("Failed to create scheduled jobs");
        }

        activeJobs.set(walkId, { activation: activationJob, timeout: timeoutJob });

        const duration = Date.now() - startTime;
        console.log(`✅ Walk ${walkId} scheduled successfully (${duration}ms)`);
        console.log(`📊 Active jobs: ${activeJobs.size}`);
        console.log(`${'='.repeat(60)}\n`);
        
        res.status(200).json({ 
            success: true, 
            message: "Walk scheduled successfully",
            walkId,
            scheduledTime: scheduledDate.toISOString(),
            timeoutTime: timeoutDate.toISOString(),
            activeJobsCount: activeJobs.size
        });

    } catch (error) {
        console.error(`❌ Scheduling error for ${walkId}:`, error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
