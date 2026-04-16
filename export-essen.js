// exporter-essen.js
// Node-Port von suche_nur_essen.html: Übersichtsseite + Detailseiten scrapen und als JSON speichern.

import { JSDOM } from "jsdom";
import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

// ======= Konfiguration (aus der HTML übernommen) =======
const ORIGIN = "https://www.caritas-essen.de";
const LIST_URL = ORIGIN + "/berufe/fort-weiterbildungsboerse"; // Essen: eine Übersichtsseite

// Defaults (kannst du per CLI überschreiben)
let REQUEST_TIMEOUT_MS = 30000;
let REQUEST_DELAY_MS = 300;
let OUT_FILE = "kurse-essen.json";

// Filter-Logik wie in der HTML-UI
const ONLY_OPEN = true;
const EXCLUDE_AUSGEBUCHT = true;

const USER_AGENT =
  "Mozilla/5.0 (compatible; CaritasCrawler/1.0; +https://example.org)";

// ======= CLI-Optionen (optional) =======
// Beispiele:
// node exporter-essen.js --delay=200 --timeout=45000 --out=kurse.json
for (const arg of process.argv.slice(2)) {
  const [k, v] = arg.split("=");
  if (k === "--delay" && v) REQUEST_DELAY_MS = Number(v);
  if (k === "--timeout" && v) REQUEST_TIMEOUT_MS = Number(v);
  if (k === "--out" && v) OUT_FILE = v;
}

// ======= Hilfsfunktionen =======
async function fetchWithTimeout(url, { timeout = REQUEST_TIMEOUT_MS, retries = 2 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "de-DE,de;q=0.9,en;q=0.7"
        },
        signal: controller.signal,
        cache: "no-store",
        redirect: "follow"
      });

      if (!res.ok) {
        // z.B. 403/429/500
        throw new Error(`HTTP ${res.status} bei ${url} (final: ${res.url})`);
      }
      return await res.text();
    } catch (err) {
      const causeCode = err?.cause?.code;
      const name = err?.name || "Error";
      const msg = err?.message || String(err);

      console.warn(
        `⚠️ Fetch-Fehler (Attempt ${attempt + 1}/${retries + 1}) ${url}\n` +
        `   ${name}: ${msg}` +
        (causeCode ? `\n   cause.code: ${causeCode}` : "")
      );

      // Nicht retryen bei sehr klaren "dauerhaften" Fehlern:
      // (Optional) Wenn du willst, kann man hier bestimmte cause.codes ausschließen.
      if (attempt === retries) throw err;

      // kurzer Backoff
      await sleep(500 * (attempt + 1));
    } finally {
      clearTimeout(id);
    }
  }
}

function parseHTML(html) {
  const dom = new JSDOM(html);
  return dom.window.document;
}

function normalizeWhitespace(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function toAbsoluteUrl(href) {
  try {
    return new URL(href, ORIGIN).toString();
  } catch {
    return href;
  }
}

async function fetchDocument(url) {
  const html = await fetchWithTimeout(url);
  return parseHTML(html);
}

// ======= 1) Overview extrahieren (wie extractCoursesFromOverview in HTML) =======
function extractCoursesFromOverview(doc) {
  // Selektor 1:1 aus der HTML
  const items = Array.from(
    doc.querySelectorAll('div[id*="DynamicBordered"] div.info-list-item__content')
  );

  const out = [];
  for (const node of items) {
    const a = node.querySelector("h3 a");
    if (!a) continue;

    const title = normalizeWhitespace(a.textContent);
    const url = toAbsoluteUrl(a.getAttribute("href"));
    const date = normalizeWhitespace(node.querySelector("span.heading")?.textContent ?? "");

    out.push({ id: null, title, url, date, place: "", fee: "", status: "" });
  }
  return out;
}

// ======= 2) Detailseite laden & Felder extrahieren (wie fetchCourseDetails in HTML) =======
async function fetchCourseDetails(course) {
  const doc = await fetchDocument(course.url);

  // Status: default "geschlossen", "offen" wenn Link "Zur Anmeldung" in right-col existiert
  let status = "geschlossen";
  const rightCol = doc.querySelector("div.eventbox__right-col");
  if (rightCol) {
    const regBtn = Array.from(rightCol.querySelectorAll("a")).find((a) =>
      (a.textContent ?? "").includes("Zur Anmeldung")
    );
    if (regBtn) status = "offen";
  }

  // Ort (mit Fallback)
  let place = "";
  const aside = doc.querySelector("aside:not([aria-label])");
  if (aside) {
    let node = aside.querySelector(".contact__person-info-wrapper--nopadding");
    if (!node) node = aside.querySelector(".contact__person-info-wrapper");
    if (node) place = normalizeWhitespace(node.textContent);
  }

  // Gebühren: EXAKT "Kosten" suchen, dann rechte Spalte daneben nehmen
  let fee = "";
  const feeLabel = Array.from(doc.querySelectorAll("p,strong,span")).find(
    (el) => (el.textContent ?? "").trim() === "Kosten"
  );
  if (feeLabel) {
    const column = feeLabel.closest("div");
    const sibling = column?.nextElementSibling;
    const valP = sibling?.querySelector("p");
    if (valP) fee = normalizeWhitespace(valP.textContent);
  }

  // Kurs-ID: "Veranstaltungsnummer" suchen, dann rechte Spalte daneben nehmen
  let cid = "";
  const idLabel = Array.from(doc.querySelectorAll("p,strong,span")).find((el) =>
    (el.textContent ?? "").includes("Veranstaltungsnummer")
  );
  if (idLabel) {
    const column = idLabel.closest("div");
    const sibling = column?.nextElementSibling;
    const valP = sibling?.querySelector("p");
    if (valP) cid = normalizeWhitespace(valP.textContent);
  }
  if (!cid) cid = "Siehe Kursdetails";

  // In deiner HTML steht hier durch Zeilenumbruch ein kaputtes "cid \ course.url" –
  // im Node-Skript setzen wir korrekt nur cid.
  course.status = status;
  course.place = place;
  course.fee = fee;
  course.id = cid;
}

// ======= 3) Dedupe + Filter =======
function dedupeByUrl(courses) {
  const seen = new Set();
  const out = [];
  for (const c of courses) {
    if (!c.url || seen.has(c.url)) continue;
    seen.add(c.url);
    out.push(c);
  }
  return out;
}

function applyFilters(courses) {
  return courses.filter((c) => {
    if (ONLY_OPEN && c.status !== "offen") return false;
    if (EXCLUDE_AUSGEBUCHT && (c.title ?? "").toUpperCase().includes("AUSGEBUCHT")) return false;
    return true;
  });
}

// ======= Hauptablauf (Essen: nur eine Übersichtsseite) =======
async function main() {
  console.log("🔎 Start: Essen Kurs-Scrape");
  console.log(`   ORIGIN: ${ORIGIN}`);
  console.log(`   LIST_URL: ${LIST_URL}`);
  console.log(`   DELAY_MS: ${REQUEST_DELAY_MS}, TIMEOUT_MS: ${REQUEST_TIMEOUT_MS}`);
  console.log(`   OUT_FILE: ${OUT_FILE}`);

  console.log("📄 Übersichtsseite lade…");
  const listDoc = await fetchDocument(LIST_URL);

  const raw = extractCoursesFromOverview(listDoc);
  console.log(`📦 Gefunden (roh): ${raw.length}`);

  const courses = dedupeByUrl(raw);
  console.log(`🧹 Dedupe: ${courses.length}`);

  let i = 0;
  for (const c of courses) {
    i++;
    console.log(`🧾 Detail [${i}/${courses.length}] ${c.url}`);
    try {
      await fetchCourseDetails(c);
    } catch (e) {
      console.warn(`⚠️  Detail-Fehler: ${c.url}: ${e.message}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  const filtered = applyFilters(courses);
  console.log(`✅ Nach Filter (offen + nicht AUSGEBUCHT): ${filtered.length}`);

  await writeFile(OUT_FILE, JSON.stringify(filtered, null, 2), "utf-8");
  console.log(`💾 Fertig. Gespeichert in: ${OUT_FILE}`);
}

main().catch((err) => {
  console.error("❌ Abbruch wegen Fehler:", err);
  process.exit(1);
});
``