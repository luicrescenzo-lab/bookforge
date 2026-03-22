export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  // Rispondo subito a Lemon Squeezy per evitare timeout
  res.status(200).json({ ok: true });

  if (req.method !== "POST") return;

  try {
    // Leggi raw body
    const rawBody = await getRawBody(req);
    const payload = JSON.parse(rawBody.toString("utf8"));
    const eventName = payload?.meta?.event_name;
    const data = payload?.data;

    if (!eventName) return;

    console.log(`Webhook ricevuto: ${eventName}`);

    // Inizializza Firebase Admin in modo lazy
    const { initializeApp, cert, getApps } = await import("firebase-admin/app");
    const { getFirestore } = await import("firebase-admin/firestore");
    const { getAuth } = await import("firebase-admin/auth");

    if (!getApps().length) {
      initializeApp({
        credential: cert({
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
          projectId: process.env.FIREBASE_PROJECT_ID,
        }),
      });
    }

    const db = getFirestore();
    const auth = getAuth();

    // Mappa Variant ID → Piano
    const VARIANT_TO_PLAN = {
      "1427013": "BASE",
      "1427039": "PRO",
      "1427057": "BUSINESS",
      "1427050": "A_VITA",
    };

    async function updateUserPlan(email, planData) {
      try {
        const userRecord = await auth.getUserByEmail(email);
        const uid = userRecord.uid;
        console.log(`Utente trovato: ${email} → UID: ${uid}`);

        const userRef = db.collection("users").doc(uid);
        await userRef.set({ email }, { merge: true });

        const planRef = userRef.collection("settings").doc("plan");
        await planRef.set(planData, { merge: true });

        console.log(`Firestore aggiornato: users/${uid}/settings/plan`);
      } catch (err) {
        console.error(`Errore updateUserPlan per ${email}:`, err.message);
      }
    }

    switch (eventName) {
      case "order_created": {
        const email = data?.attributes?.user_email;
        const variantId = data?.attributes?.first_order_item?.variant_id?.toString();
        const plan = VARIANT_TO_PLAN[variantId];
        if (email && plan) {
          await updateUserPlan(email, { plan, status: "active", activatedAt: Date.now() });
        }
        break;
      }
      case "subscription_created": {
        const email = data?.attributes?.user_email;
        const variantId = data?.attributes?.variant_id?.toString();
        const plan = VARIANT_TO_PLAN[variantId];
        if (email && plan) {
          await updateUserPlan(email, {
            plan, status: "active",
            subscriptionId: data?.id,
            activatedAt: Date.now(),
            renewsAt: data?.attributes?.renews_at || null,
          });
        }
        break;
      }
      case "subscription_updated": {
        const email = data?.attributes?.user_email;
        const variantId = data?.attributes?.variant_id?.toString();
        const plan = VARIANT_TO_PLAN[variantId];
        if (email) {
          const updateData = {
            status: data?.attributes?.status || "active",
            updatedAt: Date.now(),
            renewsAt: data?.attributes?.renews_at || null,
          };
          if (plan) updateData.plan = plan;
          await updateUserPlan(email, updateData);
        }
        break;
      }
      case "subscription_cancelled": {
        const email = data?.attributes?.user_email;
        if (email) {
          await updateUserPlan(email, {
            status: "cancelled",
            cancelledAt: Date.now(),
            expiresAt: data?.attributes?.ends_at || null,
          });
        }
        break;
      }
      case "subscription_expired": {
        const email = data?.attributes?.user_email;
        if (email) {
          await updateUserPlan(email, {
            plan: "free", status: "expired",
            expiredAt: Date.now(),
          });
        }
        break;
      }
      case "subscription_payment_success": {
        const email = data?.attributes?.user_email;
        if (email) {
          await updateUserPlan(email, {
            status: "active",
            lastPaymentAt: Date.now(),
            renewsAt: data?.attributes?.renews_at || null,
          });
        }
        break;
      }
    }
  } catch (err) {
    console.error("Webhook errore generale:", err.message);
  }
}

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
