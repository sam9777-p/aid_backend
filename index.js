// Example Node.js Server Endpoint (External to Flutter Project)
// File: server.js or a dedicated API route

const express = require('express');
const admin = require('firebase-admin');
const Buffer = require('buffer').Buffer;

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


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});