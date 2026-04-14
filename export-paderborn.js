// export-paderborn.js
// Node-Port von suche_nur_helfenmitprofil.html
// Lädt Übersichtsseiten (inkl. Pagination), extrahiert Kurse, dedupliziert, filtert (Vergangenheit + "Kurs abgeschlossen")
// und schreibt paderborn.json.

import { JSDOM } from "jsdom";
import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

// =========================
// Konfiguration (aus der HTML übernommen)
// =========================
const ORIGIN = "https://www.helfenmitprofil.de";
const LIST_URL = ORIGIN + "/programm/kw/bereich/suche/suchesetzen/true/";

// Browser-CORS ist in Node egal, aber falls du über einen eigenen Fetch-Proxy gehen willst:
// (entspricht dem HTML-Mechanismus, nur hier optional als Prefix)
let USE_PROXY = false;
let PROXY_URL = ""; // z.B. "https://dein-proxy.example/?url="

// Sicherheitslimit für Pagination-BFS (HTML hat MAX_PAGES=50 in fetchAllListDocs)
let MAX_PAGES = 50;

// Request-Tuning
let REQUEST_TIMEOUT_MS = 30000;
let REQUEST_DELAY_MS = 250;

// Retry-Tuning (gegen sporadische Netzwerkfehler)
let RETRIES = 3;                 // Anzahl Versuche pro Request
let RETRY_BASE_DELAY_MS = 800;   // Start-Wartezeit (ms)
let RETRY_MAX_DELAY_MS = 8000;   // max. Backoff (ms)

// Output-Datei (HTML-Export nutzt "paderborn.json")
let OUT_FILE = "kurse-paderborn.json";

// =========================
// CLI-Optionen (optional)
// =========================
// Beispiele:
// node export-paderborn.js --out=kurse.json --delay=200 --timeout=45000 --maxPages=80
// node export-paderborn.js --useProxy=true --proxyUrl=https://proxy/?url=
for (const arg of process.argv.slice(2)) {
  const [k, v] = arg.split("=");
  if (k === "--out" && v) OUT_FILE = v;
  if (k === "--delay" && v) REQUEST_DELAY_MS = Number(v);
  if (k === "--timeout" && v) REQUEST_TIMEOUT_MS = Number(v);
  if (k === "--maxPages" && v) MAX_PAGES = Number(v);
  if (k === "--useProxy" && v) USE_PROXY = v === "true";
  if (k === "--proxyUrl" && v) PROXY_URL = v;
  if (k === "--retries" && v) RETRIES = Number(v);
  if (k === "--retryBase" && v) RETRY_BASE_DELAY_MS = Number(v);
  if (k === "--retryMax" && v) RETRY_MAX_DELAY_MS = Number(v);
}

const USER_AGENT =
  "Mozilla/5.0 (compatible; CaritasCrawler/1.0; +https://example.org)";

// =========================
// Utilities (Node-Varianten der HTML-Helfer)
// =========================
async function fetchWithTimeout(url, { timeout = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  const finalUrl = USE_PROXY && PROXY_URL ? PROXY_URL + encodeURIComponent(url) : url;

  try {
    const res = await fetch(finalUrl, {
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

function getErrorCode(err) {
  return err?.cause?.code || err?.code || "";
}

function isTransientNetworkError(err) {
  const code = getErrorCode(err);
  // Typische "wackelige" Netzwerkfehler, bei denen Retry sinnvoll ist
  return (
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    err?.name === "AbortError" ||
    /fetch failed/i.test(String(err?.message || ""))
  );
}

function computeBackoffMs(attempt) {
  // Exponentiell: base * 2^(attempt-1), begrenzt, plus kleines Jitter
  const exp = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)));
  const jitter = Math.floor(exp * (0.15 * Math.random())); // 0–15%
  return exp + jitter;
}

async function fetchWithRetry(url, opts = {}) {
  let lastErr;

  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`🔁 Retry ${attempt}/${RETRIES}: ${url}`);
      }
      return await fetchWithTimeout(url, opts);
    } catch (err) {
      lastErr = err;
      const code = getErrorCode(err);
      const transient = isTransientNetworkError(err);

      console.warn(`⚠️ Fetch-Fehler (attempt ${attempt}/${RETRIES}) code=${code} url=${url}`);
      if (!transient || attempt === RETRIES) break;

      const waitMs = computeBackoffMs(attempt);
      console.log(`⏳ Warte ${waitMs}ms vor erneutem Versuch…`);
      await sleep(waitMs);
    }
  }

  throw lastErr;
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

// Datum: dd.mm.yyyy (auch Bereiche wie "12.09.2025 – 13.09.2025")
function parseGermanDates(text) {
  if (!text) return [];
  const re = /(\d{1,2})\.(\d{1,2})\.(\d{4})/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, d, mo, y] = m;
    // Datum in lokaler Zeitzone, Ende des Tages (wie HTML)
    const dt = new Date(Number(y), Number(mo) - 1, Number(d), 23, 59, 59, 999);
    out.push(dt);
  }
  return out;
}

// "Vergangen" = wenn letztes Datum (Ende) < heute 00:00
function isPast(text) {
  const dates = parseGermanDates(text);
  if (dates.length === 0) return false;
  const end = dates[dates.length - 1];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return end < today;
}

// Kurs-ID: bevorzugt Segment nach "/kurs/" (wie HTML), sonst Fallbacks
function deriveCourseId(url) {
  try {
    const u = new URL(url, ORIGIN);

    // ID aus /kurs/{ID}/...
    const m = u.pathname.match(/\/kurs\/([^\/?#]+)/i);
    if (m && m[1]) return decodeURIComponent(m[1]);

    // Fallback: Query-Parameter
    for (const key of ["id", "kursid", "kid", "vid", "nr"]) {
      const v = u.searchParams.get(key);
      if (v) return String(v);
    }

    // Fallback: größte Nummernsequenz im Pfad
    const nums = u.pathname.match(/(\d{4,})/g);
    if (nums && nums.length) return nums.sort((a, b) => b.length - a.length)[0];

    // Fallback: letztes Segment
    const segs = u.pathname.split("/").filter(Boolean);
    if (segs.length) return segs[segs.length - 1];

    return "unbekannt";
  } catch {
    return String(url ?? "unbekannt");
  }
}

// =========================
// Extraktion aus Übersichtsseite (wie HTML extractCoursesFromOverview)
// =========================
function extractCoursesFromOverview(doc) {
  const items = Array.from(doc.querySelectorAll("div.kw-ue.col-sm-6"));
  const out = [];

  for (const node of items) {
    const a = node.querySelector("h4 a");
    if (!a) continue;

    const title = normalizeWhitespace(a.textContent);
    const url = toAbsoluteUrl(a.getAttribute("href"));

    const cols = node.querySelectorAll("div.col-xs-9");
    const date = normalizeWhitespace(cols?.[0]?.textContent ?? "");
    const place = normalizeWhitespace(cols?.[1]?.textContent ?? "");
    const fee = normalizeWhitespace(cols?.[2]?.textContent ?? "");
    const stat = normalizeWhitespace(cols?.[3]?.textContent ?? "");

    const id = deriveCourseId(url);

    out.push({ id, title, url, date, place, fee, status: stat });
  }

  return out;
}

// =========================
// Pagination (wie HTML collectPaginationUrls + fetchAllListDocs, BFS bis MAX_PAGES)
// =========================
function collectPaginationUrls(doc, baseUrl) {
  const urls = new Set();

  const scopes = doc.querySelectorAll(
    "nav.pagination, ul.pagination, .pagination, nav[aria-label*='Seite'], nav[aria-label*='Pagination']"
  );

  const inScopes = scopes.length
    ? Array.from(scopes).flatMap((s) => Array.from(s.querySelectorAll("a[href]")))
    : Array.from(doc.querySelectorAll("a[href]"));

  for (const a of inScopes) {
    const href = a.getAttribute("href") ?? "";
    const text = (a.textContent ?? "").trim();

    // Heuristik wie HTML:
    const looksLikeList = /bereich\/suche|suchesetzen|seite|page|start/i.test(href);
    const isPagerText = /^\d+$/.test(text) || /weiter|next|vor|zur|zurück|prev/i.test(text);
    if (!looksLikeList && !isPagerText) continue;

    const abs = toAbsoluteUrl(href);
    try {
      const u = new URL(abs);
      if (u.origin !== ORIGIN) continue;
      urls.add(u.toString());
    } catch {
      /* ignore */
    }
  }

  if (baseUrl) urls.delete(baseUrl);
  return Array.from(urls);
}

async function fetchDocument(url) {
  const html = await fetchWithRetry(url);
  return parseHTML(html);
}

async function fetchAllListDocs() {
  const docs = [];
  const seen = new Set();

  console.log(`📄 Lade Startseite: ${LIST_URL}`);
  const firstDoc = await fetchDocument(LIST_URL);
  docs.push({ url: LIST_URL, doc: firstDoc });
  seen.add(LIST_URL);

  const queue = collectPaginationUrls(firstDoc, LIST_URL).filter((u) => !seen.has(u));
  for (const u of queue) seen.add(u);

  console.log(`🔗 Pagination-Links initial: ${queue.length}`);

  while (queue.length && docs.length < MAX_PAGES) {
    const u = queue.shift();
    console.log(`📄 Lade Folgeseite [${docs.length + 1}/${MAX_PAGES}]: ${u}`);

    try {
      const d = await fetchDocument(u);
      docs.push({ url: u, doc: d });

      // Weitere Pagination-Links einsammeln
      const more = collectPaginationUrls(d, u).filter((x) => !seen.has(x));
      for (const x of more) {
        seen.add(x);
        queue.push(x);
      }

      console.log(`   → weitere Links gefunden: +${more.length} (Queue jetzt: ${queue.length})`);
      await sleep(REQUEST_DELAY_MS);
    } catch (err) {
      console.warn(`⚠️  Seite konnte nicht geladen werden: ${u} (${err.message})`);
    }
  }

  console.log(`📚 Geladene Listenseiten gesamt: ${docs.length}`);
  return docs.map((x) => x.doc);
}

// =========================
// Dedupe & Filter (wie HTML)
// =========================
function dedupeByIdOrUrl(courses) {
  const seen = new Set();
  const out = [];
  for (const c of courses) {
    const key = String(c.id || c.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function applyFilters(courses) {
  return courses.filter((c) => {
    const closed = String(c.status ?? "").toLowerCase().includes("kurs abgeschlossen");
    const past = isPast(c.date);
    return !closed && !past;
  });
}

// =========================
// Main
// =========================
async function main() {
  console.log("🔎 Start: export-paderborn (helfenmitprofil.de)");
  console.log(`   ORIGIN: ${ORIGIN}`);
  console.log(`   LIST_URL: ${LIST_URL}`);
  console.log(`   USE_PROXY: ${USE_PROXY} ${USE_PROXY ? `(${PROXY_URL})` : ""}`);
  console.log(`   MAX_PAGES: ${MAX_PAGES}, DELAY_MS: ${REQUEST_DELAY_MS}, TIMEOUT_MS: ${REQUEST_TIMEOUT_MS}`);
  console.log(`   OUT_FILE: ${OUT_FILE}`);

  const listDocs = await fetchAllListDocs();

  // 1) Roh-Extraktion über ALLE Seiten
  const raw = [];
  for (const doc of listDocs) {
    raw.push(...extractCoursesFromOverview(doc));
  }
  console.log(`📦 Roh extrahiert: ${raw.length}`);

  // 2) Dedupe (Kurs-ID, Fallback URL)
  const deduped = dedupeByIdOrUrl(raw);
  console.log(`🧹 Nach Dedupe: ${deduped.length}`);

  // 3) Filter: Vergangenheit oder "Kurs abgeschlossen"
  const filtered = applyFilters(deduped);
  console.log(`✅ Nach Filter (nicht vergangen, nicht abgeschlossen): ${filtered.length}`);

  // 4) JSON schreiben
  await writeFile(OUT_FILE, JSON.stringify(filtered, null, 2), "utf-8");
  console.log(`💾 Fertig. Gespeichert in: ${OUT_FILE}`);
}

main().catch((err) => {
  console.error("❌ Abbruch wegen Fehler:", err);
  process.exit(1);
});