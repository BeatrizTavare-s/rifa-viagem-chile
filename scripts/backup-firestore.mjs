// Reads all documents from the "numeros" Firestore collection using a
// service account, then emails a JSON snapshot as an attachment.
// Nothing is written to disk/repo — the backup only ever lives in the
// recipient's inbox and in Firestore itself.

import { createSign } from "node:crypto";
import nodemailer from "nodemailer";

const saJson = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!saJson) {
  console.error("Missing FIREBASE_SERVICE_ACCOUNT env var.");
  process.exit(1);
}
const sa = JSON.parse(saJson);
const projectId = sa.project_id;

const gmailUser = process.env.GMAIL_USER;
const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;
const backupToEmail = process.env.BACKUP_TO_EMAIL || gmailUser;
if (!gmailUser || !gmailAppPassword) {
  console.error("Missing GMAIL_USER or GMAIL_APP_PASSWORD env var.");
  process.exit(1);
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function getAccessToken() {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/datastore.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(sa.private_key);
  const jwt = `${unsigned}.${signature.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.access_token;
}

function fromFirestoreValue(value) {
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.integerValue !== undefined) return Number(value.integerValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.booleanValue !== undefined) return value.booleanValue;
  if (value.timestampValue !== undefined) return value.timestampValue;
  if (value.nullValue !== undefined) return null;
  if (value.mapValue !== undefined) return fromFirestoreFields(value.mapValue.fields || {});
  if (value.arrayValue !== undefined) return (value.arrayValue.values || []).map(fromFirestoreValue);
  return null;
}

function fromFirestoreFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = fromFirestoreValue(value);
  }
  return out;
}

async function fetchAllNumeros(accessToken) {
  const results = {};
  let pageToken;
  do {
    const url = new URL(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/numeros`
    );
    url.searchParams.set("pageSize", "300");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Firestore list failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    for (const doc of data.documents || []) {
      const id = doc.name.split("/").pop();
      results[id] = fromFirestoreFields(doc.fields || {});
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return results;
}

const accessToken = await getAccessToken();
const numeros = await fetchAllNumeros(accessToken);

const today = new Date().toISOString().slice(0, 10);
const payload = JSON.stringify({ exportedAt: new Date().toISOString(), numeros }, null, 2);

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: gmailUser, pass: gmailAppPassword },
});

await transporter.sendMail({
  from: gmailUser,
  to: backupToEmail,
  subject: `Backup rifa Chile — ${today}`,
  text: `Backup automático da rifa em ${today}. ${Object.keys(numeros).length} números exportados. Veja o anexo.`,
  attachments: [
    {
      filename: `rifa-backup-${today}.json`,
      content: payload,
      contentType: "application/json",
    },
  ],
});

console.log(`Backup emailed to ${backupToEmail} (${Object.keys(numeros).length} numbers).`);
