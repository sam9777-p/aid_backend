// Example Node.js Server Endpoint (External to Flutter Project)
// File: server.js or a dedicated API route

const express = require('express');
const admin = require('firebase-admin');
const Buffer = require('buffer').Buffer;
const schedule = require("node-schedule");

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
  const { walkId, senderId, recipientId, scheduledTimestampISO } = req.body;

  if (!walkId || !senderId || !recipientId || !scheduledTimestampISO) {
    return res.status(400).send({ error: "Missing required fields." });
  }

  const scheduledDate = new Date(scheduledTimestampISO);
  // Calculate timeout 5 minutes *after* scheduled start
  const timeoutDate = new Date(scheduledDate.getTime() + 5 * 60000); 
  const db = admin.firestore();

  // --- 1. Schedule the "Activation" Job ---
  // This job will run at the scheduledDate
  schedule.scheduleJob(scheduledDate, async () => {
    console.log(`[Scheduler] ACTIVATING walk: ${walkId}`);
    try {
      // Check if walk is still 'Accepted' (user might have cancelled)
      const walkRef = db.collection("accepted_walks").doc(walkId);
      const walkDoc = await walkRef.get();

      if (!walkDoc.exists || walkDoc.data().status !== "Accepted") {
        console.log(`[Scheduler] Walk ${walkId} is no longer 'Accepted'. Skipping activation.`);
        return;
      }

      const batch = db.batch();
      
      // Set activeWalkId for both users, triggering the app's UI change
      batch.update(db.collection("users").doc(senderId), { activeWalkId: walkId });
      batch.update(db.collection("users").doc(recipientId), { activeWalkId: walkId });
      
      // Mark that we've set the ID so we don't run this again
      batch.update(walkRef, { activeWalkIdSet: true });
      
      await batch.commit();
      
      // Send notifications to both users
      const notificationPayload = {
        notification: {
          title: "Walk Starting Soon!",
          body: "Your scheduled walk is starting now. Open the app to begin.",
        },
        data: { type: "walk_reminder", walkId: walkId }
      };
      
      // Get tokens and send (using your existing helpers)
      const senderToken = await getFCMToken(senderId);
      const recipientToken = await getFCMToken(recipientId);
      
      if (senderToken) await sendFCM(senderToken, notificationPayload);
      if (recipientToken) await sendFCM(recipientToken, notificationPayload);

    } catch (error) {
      console.error(`[Scheduler] Failed to activate walk ${walkId}:`, error);
    }
  });

  // --- 2. Schedule the "Timeout" Job ---
  // This job will run at the timeoutDate (5 mins after schedule)
  schedule.scheduleJob(timeoutDate, async () => {
    console.log(`[Scheduler] CHECKING TIMEOUT for walk: ${walkId}`);
    try {
      const walkRef = db.collection("accepted_walks").doc(walkId);
      const walkDoc = await walkRef.get();

      // If walk doesn't exist, or was started ('Started'), or completed/cancelled, do nothing.
      if (!walkDoc.exists || walkDoc.data().status !== "Accepted") {
        console.log(`[Scheduler] Walk ${walkId} already started or cancelled. No timeout needed.`);
        return;
      }
      
      // If we are here, the walk was missed.
      console.log(`[Scheduler] EXPIRING walk: ${walkId}`);
      const batch = db.batch();
      
      // Update status to Expired
      batch.update(walkRef, { status: "Expired" });
      batch.update(db.collection("requests").doc(walkId), { status: "Expired" });

      // CRITICAL: Delete activeWalkId from users to return their app to normal
      batch.update(db.collection("users").doc(senderId), {
        activeWalkId: admin.firestore.FieldValue.delete(),
      });
      batch.update(db.collection("users").doc(recipientId), {
        activeWalkId: admin.firestore.FieldValue.delete(),
      });
      
      await batch.commit();

    } catch (error) {
      console.error(`[Scheduler] Failed to expire walk ${walkId}:`, error);
    }
  });

  console.log(`[API] Walk ${walkId} scheduled for ${scheduledDate.toISOString()}`);
  res.status(200).send({ success: true, message: "Walk scheduled successfully." });
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
