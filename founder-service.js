/* ══════════════════════════════════════════════════════════════
   KANADROP — FOUNDER SERVICE
   Gère l'inscription et la confirmation des Fondateurs Légendaires
   via Cloud Firestore (CDN, pas de npm)

   Structure Firestore :
   Collection : founders
   Document   : {emailHash}
   Champs :
     email        : string
     registeredAt : timestamp
     confirmed    : boolean
     confirmedAt  : timestamp | null
     token        : string (UUID pour le lien de confirmation)
     tokenExpiry  : timestamp (registeredAt + 24h)
     lastSentAt   : timestamp

   Collection : meta
   Document   : quota
   Champs :
     count : number  (fondateurs inscrits)
     max   : number  (250)
══════════════════════════════════════════════════════════════ */

import { initializeApp }
  from "https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js";
import { getFirestore, doc, getDoc, setDoc, updateDoc,
         onSnapshot, runTransaction, serverTimestamp,
         collection, query, where, getDocs }
  from "https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js";

/* ── Config Firebase ── */
const firebaseConfig = {
  apiKey:            "AIzaSyCnS30baBDKa1bmxqU9-IoigwiALdp16ds",
  authDomain:        "kanadrop-app.firebaseapp.com",
  projectId:         "kanadrop-app",
  storageBucket:     "kanadrop-app.firebasestorage.app",
  messagingSenderId: "484586523436",
  appId:             "1:484586523436:web:6e550138ae9f054524ba89",
  measurementId:     "G-NSQWNF5XZS"
};

const app = initializeApp(firebaseConfig);
const db  = getFirestore(app);

/* ══════════════════════════════════════════════════════════════
   UTILITAIRES
══════════════════════════════════════════════════════════════ */

function generateToken() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

async function hashEmail(email) {
  const normalized = email.toLowerCase().trim();
  const buf = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(normalized)
  );
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

export function isOnline() {
  return navigator.onLine;
}

/* ══════════════════════════════════════════════════════════════
   ENREGISTRER UN FONDATEUR
   Retourne { status, email? }
   status: 'sent' | 'already' | 'err-used' | 'err-quota'
           'err-network' | 'err-expired' | 'err-unknown'
══════════════════════════════════════════════════════════════ */
export async function registerFounder(email) {
  if (!isOnline()) return { status: 'err-network' };

  try {
    const emailHash  = await hashEmail(email);
    const founderRef = doc(db, 'founders', emailHash);
    const metaRef    = doc(db, 'meta', 'quota');
    const token      = generateToken();
    const expiry     = new Date(Date.now() + 24 * 60 * 60 * 1000);

    let resultStatus = 'sent';

    await runTransaction(db, async (tx) => {
      const founderSnap = await tx.get(founderRef);
      const metaSnap    = await tx.get(metaRef);

      /* Quota */
      const count = metaSnap.exists() ? metaSnap.data().count : 0;
      const max   = metaSnap.exists() ? metaSnap.data().max   : 250;
      if (count >= max) { resultStatus = 'err-quota'; return; }

      /* Email existant */
      if (founderSnap.exists()) {
        const data = founderSnap.data();
        if (data.confirmed) {
          resultStatus = 'already';
        } else {
          /* Renvoi d'un nouveau token */
          resultStatus = 'sent';
          tx.update(founderRef, { token, tokenExpiry: expiry, lastSentAt: serverTimestamp() });
        }
        return;
      }

      /* Nouvel inscrit */
      tx.set(founderRef, {
        email,
        registeredAt: serverTimestamp(),
        confirmed:    false,
        confirmedAt:  null,
        token,
        tokenExpiry:  expiry,
        lastSentAt:   serverTimestamp()
      });

      /* Compteur */
      if (metaSnap.exists()) {
        tx.update(metaRef, { count: count + 1 });
      } else {
        tx.set(metaRef, { count: 1, max: 250 });
      }
    });

    if (resultStatus === 'sent') {
      await sendConfirmationEmail(email, token);
    }

    return { status: resultStatus, email };

  } catch (err) {
    console.error('[FounderService] registerFounder:', err);
    if (!isOnline()) return { status: 'err-network' };
    return { status: 'err-unknown', error: err.message };
  }
}

/* ══════════════════════════════════════════════════════════════
   RENVOI D'EMAIL
══════════════════════════════════════════════════════════════ */
export async function resendConfirmationEmail(email) {
  if (!isOnline()) return { status: 'err-network' };

  try {
    const emailHash  = await hashEmail(email);
    const founderRef = doc(db, 'founders', emailHash);
    const token      = generateToken();
    const expiry     = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await updateDoc(founderRef, {
      token, tokenExpiry: expiry, lastSentAt: serverTimestamp()
    });

    await sendConfirmationEmail(email, token);
    return { status: 'sent', email };

  } catch (err) {
    console.error('[FounderService] resendConfirmationEmail:', err);
    return { status: 'err-unknown', error: err.message };
  }
}

/* ══════════════════════════════════════════════════════════════
   ÉCOUTE TEMPS RÉEL — détecte la confirmation
   Retourne une fonction unsubscribe()
══════════════════════════════════════════════════════════════ */
export async function listenForConfirmation(email, callback) {
  const emailHash  = await hashEmail(email);
  const founderRef = doc(db, 'founders', emailHash);

  const unsubscribe = onSnapshot(founderRef, (snap) => {
    if (!snap.exists()) return;
    const data = snap.data();
    if (data.confirmed === true) {
      callback({ status: 'confirmed', email, confirmedAt: data.confirmedAt });
    }
  }, (err) => {
    console.error('[FounderService] listenForConfirmation:', err);
  });

  return unsubscribe;
}

/* ══════════════════════════════════════════════════════════════
   VÉRIFIE LE STATUT AU DÉMARRAGE
   (si l'email est sauvé en localStorage)
══════════════════════════════════════════════════════════════ */
export async function checkFounderStatus(email) {
  if (!email)      return { status: 'none' };
  if (!isOnline()) return { status: 'err-network' };

  try {
    const emailHash  = await hashEmail(email);
    const founderRef = doc(db, 'founders', emailHash);
    const snap       = await getDoc(founderRef);

    if (!snap.exists()) return { status: 'none' };

    const data   = snap.data();
    if (data.confirmed) return { status: 'already', email };

    const expiry = data.tokenExpiry?.toDate?.() || new Date(0);
    if (expiry < new Date()) return { status: 'err-expired', email };

    return { status: 'sent', email };

  } catch (err) {
    console.error('[FounderService] checkFounderStatus:', err);
    return { status: 'err-unknown', error: err.message };
  }
}

/* ══════════════════════════════════════════════════════════════
   VALIDATION DU TOKEN
   Appelé depuis la page web de confirmation (lien email)
══════════════════════════════════════════════════════════════ */
export async function confirmFounderToken(token) {
  if (!token) return { status: 'err-unknown' };

  try {
    const q    = query(collection(db, 'founders'), where('token', '==', token));
    const snap = await getDocs(q);

    if (snap.empty) return { status: 'err-expired' };

    const founderDoc  = snap.docs[0];
    const data        = founderDoc.data();
    const tokenExpiry = data.tokenExpiry?.toDate?.() || new Date(0);

    if (tokenExpiry < new Date()) return { status: 'err-expired' };
    if (data.confirmed)           return { status: 'already', email: data.email };

    await updateDoc(founderDoc.ref, {
      confirmed:   true,
      confirmedAt: serverTimestamp(),
      token:       null
    });

    return { status: 'confirmed', email: data.email };

  } catch (err) {
    console.error('[FounderService] confirmFounderToken:', err);
    return { status: 'err-unknown', error: err.message };
  }
}

/* ══════════════════════════════════════════════════════════════
   ENVOI EMAIL via Cloud Function
   URL à remplacer après déploiement de la Cloud Function
══════════════════════════════════════════════════════════════ */
async function sendConfirmationEmail(email, token) {
  const CLOUD_FUNCTION_URL =
    'https://us-east1-kanadrop-app.cloudfunctions.net/sendFounderEmail';

  const confirmLink =
    `https://kanadrop-app.web.app/confirm?token=${token}`;

  try {
    const res = await fetch(CLOUD_FUNCTION_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, confirmLink, token })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log('[FounderService] Email envoyé à', email);

  } catch (err) {
    /* En dev : Cloud Function pas encore déployée — on log sans bloquer */
    console.warn('[FounderService] DEV MODE — lien de confirmation :', confirmLink);
    console.warn('[FounderService] Cloud Function non joignable (normal en dev):', err.message);
  }
}
