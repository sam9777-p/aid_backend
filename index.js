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


const app = express();
app.use(express.json());

app.use(cors());

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

app.post("/api/schedule-walk", async (req, res) => {
    console.log(`[API] Received schedule-walk request:`, req.body);
    
    const { walkId, senderId, recipientId, scheduledTimestampISO } = req.body;

    // Validation
    if (!walkId || !senderId || !recipientId || !scheduledTimestampISO) {
        console.error("[API] Missing required fields:", { walkId, senderId, recipientId, scheduledTimestampISO });
        return res.status(400).send({ 
            error: "Missing required fields.",
            received: { walkId, senderId, recipientId, scheduledTimestampISO }
        });
    }

    let scheduledDate;
    let timeoutDate;
    
    try {
        scheduledDate = new Date(scheduledTimestampISO);
        
        // Validate the date
        if (isNaN(scheduledDate.getTime())) {
            throw new Error("Invalid date format");
        }
        
        // Check if the date is in the past
        const now = new Date();
        if (scheduledDate < now) {
            console.warn("[API] Warning: Scheduled date is in the past. Adjusting to current time + 1 minute.");
            scheduledDate = new Date(now.getTime() + 60000); // Add 1 minute
        }
        
        // Calculate timeout 5 minutes after scheduled start
        timeoutDate = new Date(scheduledDate.getTime() + 5 * 60000);
        
        console.log(`[API] Parsed dates - Scheduled: ${scheduledDate.toISOString()}, Timeout: ${timeoutDate.toISOString()}`);
    } catch (error) {
        console.error("[API] Error parsing date:", error);
        return res.status(400).send({ 
            error: "Invalid scheduledTimestampISO format",
            details: error.message 
        });
    }

    const db = admin.firestore();

    try {
        // --- 1. Schedule the "Activation" Job ---
        const activationJob = schedule.scheduleJob(scheduledDate, async () => {
            console.log(`[Scheduler] ACTIVATING walk: ${walkId} at ${new Date().toISOString()}`);
            try {
                const walkRef = db.collection("accepted_walks").doc(walkId);
                const walkDoc = await walkRef.get();

                if (!walkDoc.exists) {
                    console.log(`[Scheduler] Walk ${walkId} does not exist. Skipping activation.`);
                    return;
                }

                const walkData = walkDoc.data();
                
                if (walkData.status !== "Accepted") {
                    console.log(`[Scheduler] Walk ${walkId} status is '${walkData.status}', not 'Accepted'. Skipping activation.`);
                    return;
                }

                // Check if already activated
                if (walkData.activeWalkIdSet === true) {
                    console.log(`[Scheduler] Walk ${walkId} already activated. Skipping.`);
                    return;
                }

                const batch = db.batch();
                
                // Set activeWalkId for both users
                batch.update(db.collection("users").doc(senderId), { activeWalkId: walkId });
                batch.update(db.collection("users").doc(recipientId), { activeWalkId: walkId });
                
                // Mark that we've set the ID
                batch.update(walkRef, { 
                    activeWalkIdSet: true,
                    activatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                
                await batch.commit();
                console.log(`[Scheduler] ✅ Successfully activated walk ${walkId}`);
                
                // Send notifications to both users
                const notificationPayload = {
                    notification: {
                        title: "Walk Starting Soon! ⏰",
                        body: "Your scheduled walk is starting now. Open the app to begin.",
                    },
                    data: { type: "walk_reminder", walkId: walkId }
                };
                
                const senderToken = await getFCMToken(senderId);
                const recipientToken = await getFCMToken(recipientId);
                
                if (senderToken) {
                    await sendFCM(senderToken, notificationPayload);
                    console.log(`[Scheduler] Notification sent to sender ${senderId}`);
                }
                if (recipientToken) {
                    await sendFCM(recipientToken, notificationPayload);
                    console.log(`[Scheduler] Notification sent to recipient ${recipientId}`);
                }

            } catch (error) {
                console.error(`[Scheduler] ❌ Failed to activate walk ${walkId}:`, error);
                console.error(`[Scheduler] Error stack:`, error.stack);
            }
        });

        // --- 2. Schedule the "Timeout" Job ---
        const timeoutJob = schedule.scheduleJob(timeoutDate, async () => {
            console.log(`[Scheduler] CHECKING TIMEOUT for walk: ${walkId} at ${new Date().toISOString()}`);
            try {
                const walkRef = db.collection("accepted_walks").doc(walkId);
                const walkDoc = await walkRef.get();

                if (!walkDoc.exists) {
                    console.log(`[Scheduler] Walk ${walkId} does not exist. No timeout needed.`);
                    return;
                }

                const walkData = walkDoc.data();

                // If walk was started, completed, or cancelled, do nothing
                if (walkData.status !== "Accepted") {
                    console.log(`[Scheduler] Walk ${walkId} status is '${walkData.status}'. No timeout needed.`);
                    return;
                }
                
                // If we are here, the walk was missed/not started
                console.log(`[Scheduler] ⚠️ EXPIRING walk: ${walkId}`);
                const batch = db.batch();
                
                // Update status to Expired
                batch.update(walkRef, { 
                    status: "Expired",
                    expiredAt: admin.firestore.FieldValue.serverTimestamp()
                });
                
                // Update in requests collection as well
                const requestRef = db.collection("requests").doc(walkId);
                const requestDoc = await requestRef.get();
                if (requestDoc.exists) {
                    batch.update(requestRef, { 
                        status: "Expired",
                        expiredAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                }

                // CRITICAL: Delete activeWalkId from users to return their app to normal
                batch.update(db.collection("users").doc(senderId), {
                    activeWalkId: admin.firestore.FieldValue.delete(),
                });
                batch.update(db.collection("users").doc(recipientId), {
                    activeWalkId: admin.firestore.FieldValue.delete(),
                });
                
                await batch.commit();
                console.log(`[Scheduler] ✅ Successfully expired walk ${walkId}`);

                // Optionally send expiration notifications
                const expirationPayload = {
                    notification: {
                        title: "Walk Expired ⏱️",
                        body: "Your scheduled walk was not started in time and has expired.",
                    },
                    data: { type: "walk_expired", walkId: walkId }
                };
                
                const senderToken = await getFCMToken(senderId);
                const recipientToken = await getFCMToken(recipientId);
                
                if (senderToken) await sendFCM(senderToken, expirationPayload);
                if (recipientToken) await sendFCM(recipientToken, expirationPayload);

            } catch (error) {
                console.error(`[Scheduler] ❌ Failed to expire walk ${walkId}:`, error);
                console.error(`[Scheduler] Error stack:`, error.stack);
            }
        });

        // Check if jobs were scheduled successfully
        if (!activationJob) {
            throw new Error("Failed to schedule activation job");
        }
        if (!timeoutJob) {
            throw new Error("Failed to schedule timeout job");
        }

        console.log(`[API] ✅ Walk ${walkId} scheduled successfully`);
        console.log(`[API] - Activation scheduled for: ${scheduledDate.toISOString()}`);
        console.log(`[API] - Timeout scheduled for: ${timeoutDate.toISOString()}`);
        
        res.status(200).send({ 
            success: true, 
            message: "Walk scheduled successfully.",
            walkId: walkId,
            scheduledTime: scheduledDate.toISOString(),
            timeoutTime: timeoutDate.toISOString()
        });

    } catch (error) {
        console.error("[API] ❌ Error scheduling walk:", error);
        console.error("[API] Error stack:", error.stack);
        res.status(500).send({ 
            success: false, 
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
