// export-aachen.js
// Node-Port von suche_nur_aachen.html: Listen-Seiten + Detailseiten scrapen und als JSON speichern.

import { JSDOM } from "jsdom";
import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

// ======= Konfiguration (aus der HTML übernommen) =======
const ORIGIN = "https://www.caritas-ac.de";
const LIST_URL = ORIGIN + "/fort-und-weiterbildung/fortbildung/fortbildung-liste.aspx";
const MODULE_ID = "1540230";

// Defaults (kannst du per CLI überschreiben)
let MAX_PAGES = 20;
let REQUEST_TIMEOUT_MS = 30000;
let REQUEST_DELAY_MS = 300;
let OUT_FILE = "kurse-aachen.json";

// Filter-Logik wie in der HTML-UI
const ONLY_OPEN = true;
const EXCLUDE_AUSGEBUCHT = true;

const USER_AGENT =
  "Mozilla/5.0 (compatible; CaritasCrawler/1.0; +https://example.org)";

// ======= CLI-Optionen (optional) =======
// Beispiele:
// node export-aachen.js --maxPages=50 --delay=200 --timeout=45000 --out=kurse.json
for (const arg of process.argv.slice(2)) {
  const [k, v] = arg.split("=");
  if (k === "--maxPages" && v) MAX_PAGES = Number(v);
  if (k === "--delay" && v) REQUEST_DELAY_MS = Number(v);
  if (k === "--timeout" && v) REQUEST_TIMEOUT_MS = Number(v);
  if (k === "--out" && v) OUT_FILE = v;
}

// ======= Hilfsfunktionen =======
async function fetchWithTimeout(url, { timeout = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
      signal: controller.signal,
      cache: "no-store"
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} bei ${url}`);
    return await res.text();
  } finally {
    clearTimeout(id);
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

// ======= 1) Overview extrahieren (wie extractCoursesFromOverview in HTML) =======
function extractCoursesFromOverview(doc) {
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

async function fetchDocument(url) {
  const html = await fetchWithTimeout(url);
  return parseHTML(html);
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

  course.status = status;
  course.place = place;
  course.fee = fee;
  course.id = cid;
}

// ======= 3) Paginierung (wie fetchAllListDocs in HTML) =======
async function fetchAllCoursesFromLists() {
  const all = [];
  let page = 0;

  while (page < MAX_PAGES) {
    const url = `${LIST_URL}?Page=${page}&Module=${MODULE_ID}`;
    console.log(`📄 Liste [Page=${page}] lade: ${url}`);

    try {
      const doc = await fetchDocument(url);
      const courses = extractCoursesFromOverview(doc);

      console.log(`   → gefunden: ${courses.length}`);
      if (courses.length === 0) break;

      all.push(...courses);
    } catch (e) {
      console.warn(`⚠️  Fehler bei ${url}: ${e.message}`);
      break;
    }

    page++;
    await sleep(REQUEST_DELAY_MS);
  }

  return all;
}

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

// ======= Hauptablauf =======
async function main() {
  console.log("🔎 Start: Aachen Kurs-Scrape");
  console.log(`   ORIGIN: ${ORIGIN}`);
  console.log(`   LIST_URL: ${LIST_URL}`);
  console.log(`   MODULE_ID: ${MODULE_ID}`);
  console.log(`   MAX_PAGES: ${MAX_PAGES}, DELAY_MS: ${REQUEST_DELAY_MS}, TIMEOUT_MS: ${REQUEST_TIMEOUT_MS}`);
  console.log(`   OUT_FILE: ${OUT_FILE}`);

  const raw = await fetchAllCoursesFromLists();
  console.log(`📦 Insgesamt (roh): ${raw.length}`);

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
  console.log(`✅ Nach Filter: ${filtered.length}`);

  await writeFile(OUT_FILE, JSON.stringify(filtered, null, 2), "utf-8");
  console.log(`💾 Fertig. Gespeichert in: ${OUT_FILE}`);
}

main().catch((err) => {
  console.error("❌ Abbruch wegen Fehler:", err);
  process.exit(1);
});
