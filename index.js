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
async function sendFCM(recipientToken, payload) {
    try {
        const response = await admin.messaging().sendToDevice(recipientToken, payload);
        console.log('FCM Notification sent:', response);
        return response;
    } catch (error) {
        console.error('Error sending notification:', error);
        // Handle token invalidation if needed
        return null;
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

        // 2. Determine Notification Payload based on type
        let title = "aidKRIYA Update";
        let body = "A walk event occurred.";

        switch (type) {
            case 'new_request':
                title = `New Walk Request!`;
                body = `${data.senderName} is looking for a companion.`;
                break;
            case 'request_accepted':
                title = `Walk Confirmed!`;
                body = `${data.walkerName} accepted your request.`;
                break;
            case 'walk_started':
                title = `Walk is LIVE!`;
                body = `Your companion has started the timer.`;
                break;
            case 'new_message':
                title = `New Message from Companion`; 
                // In a real scenario, you'd fetch the sender's name from 'users' based on data.senderId
                body = data.message;
                break;
            case 'request_declined':
                title = `Request Declined`;
                body = `Your walk request was declined.`;
                break;
            case 'walk_ended':
                title = `Walk Ended`;
                body = `The walk has concluded.`;
                break;
            // ... handle other types
        }

        const payload = {
            notification: { title, body, sound: 'default' },
            data: { ...data, type: type } // Pass relevant data to the app
        };

        // 3. Send the notification
        await sendFCM(recipientToken, payload);

        return res.status(200).send({ success: true, message: 'Notification scheduled.' });

    } catch (error) {
        console.error('Error in /api/sendNotification:', error);
        return res.status(500).send({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});