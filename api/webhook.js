const crypto = require("crypto");
const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

// ─── Firebase Admin init (singleton) ─────────────────────────────────────────
if (!getApps().length) {
  initializeApp({
    credential: cert({
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      projectId: process.env.FIREBASE_PROJECT_ID, // aggiungi questa variabile su Vercel
    }),
  });
}
const db = getFirestore();

// ─── Mappa Variant ID → Piano ─────────────────────────────────────────────────
const VARIANT_TO_PLAN = {
  "862ab501-264d-4e3f-a4a7-8372dfb8a6ce": "BASE",
  "976a0f6c-7207-4ab8-a3ec-0d3b1bb40719": "PRO",
  "bc3a7bb3-db1b-4f60-872e-a778294a3111": "BUSINESS",
  "2db4ab8d-2ff6-411f-9ef1-96bd5beb8459": "A_VITA",
};

// ─── Verifica firma Lemon Squeezy ─────────────────────────────────────────────
function verifySignature(rawBody, signature) {
  const secret = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET || "bookforge_webhook_secret_2026";
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(rawBody);
  const digest = hmac.digest("hex");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

// ─── Handler principale ───────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Leggi raw body per verifica firma
  const rawBody = await getRawBody(req);
  const signature = req.headers["x-signature"];

  if (!signature) {
    console.error("Webhook: firma mancante");
    return res.status(400).json({ error: "Missing signature" });
  }

  try {
    if (!verifySignature(rawBody, signature)) {
      console.error("Webhook: firma non valida");
      return res.status(401).json({ error: "Invalid signature" });
    }
  } catch (err) {
    console.error("Webhook: errore verifica firma", err);
    return res.status(401).json({ error: "Signature verification failed" });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const eventName = payload?.meta?.event_name;
  const data = payload?.data;

  console.log(`Webhook ricevuto: ${eventName}`);

  try {
    switch (eventName) {
      case "order_created":
        await handleOrderCreated(data);
        break;
      case "subscription_created":
        await handleSubscriptionCreated(data);
        break;
      case "subscription_updated":
        await handleSubscriptionUpdated(data);
        break;
      case "subscription_cancelled":
        await handleSubscriptionCancelled(data);
        break;
      case "subscription_expired":
        await handleSubscriptionExpired(data);
        break;
      case "subscription_payment_success":
        await handleSubscriptionPaymentSuccess(data);
        break;
      default:
        console.log(`Evento non gestito: ${eventName}`);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(`Errore gestione evento ${eventName}:`, err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// ─── Gestori eventi ───────────────────────────────────────────────────────────

// Acquisto una tantum (es. piano A VITA)
async function handleOrderCreated(data) {
  const email = data?.attributes?.user_email;
  const variantId = data?.attributes?.first_order_item?.variant_id?.toString();
  const plan = VARIANT_TO_PLAN[variantId];

  if (!email || !plan) {
    console.warn("order_created: email o piano mancante", { email, variantId });
    return;
  }

  await updateUserPlan(email, {
    plan,
    status: "active",
    orderId: data?.id,
    activatedAt: new Date().toISOString(),
    expiresAt: plan === "A_VITA" ? null : null,
  });

  console.log(`Piano ${plan} attivato per ${email}`);
}

// Nuova sottoscrizione
async function handleSubscriptionCreated(data) {
  const email = data?.attributes?.user_email;
  const variantId = data?.attributes?.variant_id?.toString();
  const plan = VARIANT_TO_PLAN[variantId];
  const subscriptionId = data?.id;
  const renewsAt = data?.attributes?.renews_at;

  if (!email || !plan) {
    console.warn("subscription_created: email o piano mancante", { email, variantId });
    return;
  }

  await updateUserPlan(email, {
    plan,
    status: "active",
    subscriptionId,
    activatedAt: new Date().toISOString(),
    renewsAt: renewsAt || null,
  });

  console.log(`Subscription ${plan} creata per ${email}`);
}

// Aggiornamento sottoscrizione (es. upgrade/downgrade)
async function handleSubscriptionUpdated(data) {
  const email = data?.attributes?.user_email;
  const variantId = data?.attributes?.variant_id?.toString();
  const plan = VARIANT_TO_PLAN[variantId];
  const status = data?.attributes?.status;
  const renewsAt = data?.attributes?.renews_at;

  if (!email) return;

  const updateData = {
    status: status === "active" ? "active" : status,
    updatedAt: new Date().toISOString(),
    renewsAt: renewsAt || null,
  };
  if (plan) updateData.plan = plan;

  await updateUserPlan(email, updateData);
  console.log(`Subscription aggiornata per ${email}: ${plan || "piano invariato"} — ${status}`);
}

// Cancellazione (il piano rimane attivo fino a fine periodo)
async function handleSubscriptionCancelled(data) {
  const email = data?.attributes?.user_email;
  const endsAt = data?.attributes?.ends_at;

  if (!email) return;

  await updateUserPlan(email, {
    status: "cancelled",
    cancelledAt: new Date().toISOString(),
    expiresAt: endsAt || null,
  });

  console.log(`Subscription cancellata per ${email}, scade: ${endsAt}`);
}

// Scadenza abbonamento
async function handleSubscriptionExpired(data) {
  const email = data?.attributes?.user_email;

  if (!email) return;

  await updateUserPlan(email, {
    plan: "FREE",
    status: "expired",
    expiredAt: new Date().toISOString(),
    renewsAt: null,
    expiresAt: null,
  });

  console.log(`Subscription scaduta per ${email} — downgrade a FREE`);
}

// Pagamento periodico riuscito
async function handleSubscriptionPaymentSuccess(data) {
  const email = data?.attributes?.user_email;
  const renewsAt = data?.attributes?.renews_at;

  if (!email) return;

  await updateUserPlan(email, {
    status: "active",
    lastPaymentAt: new Date().toISOString(),
    renewsAt: renewsAt || null,
  });

  console.log(`Pagamento riuscito per ${email}`);
}

// ─── Helper Firestore ─────────────────────────────────────────────────────────

async function updateUserPlan(email, data) {
  // Cerca utente per email nella collection "users"
  const usersRef = db.collection("users");
  const snapshot = await usersRef.where("email", "==", email).limit(1).get();

  if (snapshot.empty) {
    // Utente non trovato — crea documento con email come chiave
    console.warn(`Utente non trovato per email ${email}, creo documento`);
    await usersRef.doc(email).set(
      {
        email,
        ...data,
        createdByWebhook: true,
      },
      { merge: true }
    );
    return;
  }

  // Aggiorna documento esistente
  const userDoc = snapshot.docs[0];
  await userDoc.ref.update(data);
}

// ─── Helper: leggi raw body ───────────────────────────────────────────────────

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
