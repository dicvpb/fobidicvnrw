// export-muenster.js
// Lädt die Fortbildungs-Sitemap, entpackt die .xml.gz, filtert v00-Links
// und scrapt die Kursseiten mit jsdom. Ergebnis: kurse-muenster.json

import { JSDOM } from "jsdom";
import { writeFile } from "node:fs/promises";
import zlib from "node:zlib";
import { setTimeout as sleep } from "node:timers/promises";
import { XMLParser } from "fast-xml-parser";

// ======= Konfiguration =======
const MAIN_SITEMAP = "https://fortbildung.caritas-muenster.de/sitemap.xml";
const OUT_FILE = "kurse-muenster.json";
const REQUEST_TIMEOUT_MS = 30000; // 30s Timeout pro Request
const REQUEST_DELAY_MS = 300; // kleiner Delay zwischen Requests (Höflichkeit)
const USER_AGENT =
  "Mozilla/5.0 (compatible; CaritasCrawler/1.0; +https://example.org)";

// Retry-Logik (nur für temporäre Fehler sinnvoll)
const RETRY_MAX = 2; // zusätzliche Versuche (insgesamt 1 + RETRY_MAX)
const RETRY_BASE_DELAY_MS = 800; // Basis-Backoff

// Falls Node < 18 genutzt wird, `node-fetch` einkommentieren:
// import fetch from "node-fetch";

// ======= Hilfsfunktionen =======

// Eigener Error-Typ, damit wir Statuscodes sauber unterscheiden können
class HttpError extends Error {
  constructor(status, url, statusText) {
    super(`HTTP ${status} beim Laden von ${url}${statusText ? ` (${statusText})` : ""}`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
  }
}

// Fetch mit Timeout + Kopfzeilen
async function fetchWithTimeout(url, { timeout = REQUEST_TIMEOUT_MS, binary = false } = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(id);
    throw err;
  } finally {
    clearTimeout(id);
  }

  if (!res.ok) {
    // WICHTIG: Statuscode im Error mitgeben (z. B. 404), damit wir später filtern können
    throw new HttpError(res.status, url, res.statusText);
  }

  if (binary) {
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  }
  return res.text();
}

// Optional: Retry-Wrapper nur für temporäre HTTP-Fehler (429/5xx) oder Netzfehler
async function fetchWithRetry(url, options = {}) {
  let attempt = 0;

  while (true) {
    try {
      return await fetchWithTimeout(url, options);
    } catch (err) {
      attempt++;

      // 404 & andere "harte" Fehler nicht retryen
      if (err instanceof HttpError) {
        const s = err.status;
        const isTemporary = s === 429 || (s >= 500 && s <= 599);
        if (!isTemporary) throw err;
      }

      // Abort/Timeout oder Netzfehler -> kann temporär sein
      const isLast = attempt > RETRY_MAX;
      if (isLast) throw err;

      const backoff = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.warn(
        `↩️ Retry ${attempt}/${RETRY_MAX} für ${url} (warte ${backoff}ms): ${err.message}`
      );
      await sleep(backoff);
    }
  }
}

// XML zu JS-Objekt
function parseXml(xmlString) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    trimValues: true,
  });
  return parser.parse(xmlString);
}

// Alle <loc>-Werte aus einem Sitemap-Objekt einsammeln (sitemapindex oder urlset)
function collectAllLocs(sitemapObj) {
  const locs = [];
  // Struktur: sitemapindex > sitemap[] > loc
  if (sitemapObj?.sitemapindex?.sitemap) {
    const entries = Array.isArray(sitemapObj.sitemapindex.sitemap)
      ? sitemapObj.sitemapindex.sitemap
      : [sitemapObj.sitemapindex.sitemap];
    for (const s of entries) {
      if (s?.loc) locs.push(String(s.loc));
    }
  }
  // Struktur: urlset > url[] > loc
  if (sitemapObj?.urlset?.url) {
    const entries = Array.isArray(sitemapObj.urlset.url)
      ? sitemapObj.urlset.url
      : [sitemapObj.urlset.url];
    for (const u of entries) {
      if (u?.loc) locs.push(String(u.loc));
    }
  }
  return locs;
}

// Whitespace normalisieren
function normalize(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

// Whitespace normalisieren, aber Zeilenumbrüche erhalten (für <br/> → \n)
function normalizeKeepNewlines(text) {
  return String(text ?? "")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((s) => s.trim())
    .join("\n")
    .trim();
}

// Liest den sichtbaren Text eines Elements und wandelt <br> in \n um.
function textWithBreaks(el) {
  if (!el) return "";
  const clone = el.cloneNode(true);
  clone.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  return normalizeKeepNewlines(clone.textContent ?? "");
}

function hasMeaningfulContent(pEl) {
  if (!pEl) return false;
  const txt = textWithBreaks(pEl);
  return txt.length > 0;
}

function nextPSibling(el) {
  let n = el && el.nextElementSibling;
  while (n) {
    if (n.tagName && n.tagName.toLowerCase() === "p") return n;
    n = n.nextElementSibling;
  }
  return null;
}

function extractPrices(doc) {
  const p = doc.querySelector("p.course-prices");
  if (hasMeaningfulContent(p)) return textWithBreaks(p);

  const nextP = nextPSibling(p);
  if (hasMeaningfulContent(nextP)) return textWithBreaks(nextP);

  return "";
}

function textOrEmpty(doc, selector) {
  const el = doc.querySelector(selector);
  return normalize(el?.textContent ?? "");
}

// GZ-XML laden, entpacken, zu String konvertieren
async function loadGzipXmlToString(url) {
  const gzBuf = await fetchWithRetry(url, { binary: true });
  const xmlBuf = zlib.gunzipSync(gzBuf);
  return xmlBuf.toString("utf-8");
}

// Kursseite scrapen
async function scrapeCourse(url) {
  try {
    // Wenn du KEIN Retry willst, nimm fetchWithTimeout statt fetchWithRetry
    const html = await fetchWithRetry(url);
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const title = textOrEmpty(doc, "h1.product-detail-name");
    const date = textOrEmpty(doc, "p.event-date-time-details");
    const place = textOrEmpty(doc, "p.event-location-name");
    const fee = extractPrices(doc);
    const status = textOrEmpty(doc, "div.demand-status");
    const id = textOrEmpty(doc, "p.course-meeting-point");

    // Optional: Falls die Seite zwar 200 liefert, aber leer / falsches Template ist,
    // kannst du hier entscheiden, ob du sie trotzdem exportierst:
    if (!title && !date && !id) {
      // "Soft-Fail": Seite sieht nicht wie ein Kurs aus -> nicht exportieren
      console.warn(`⚠️ Unplausibler Inhalt (kein title/date/id) → übersprungen: ${url}`);
      return { ok: false, reason: "unplausible_content" };
    }

    return {
      ok: true,
      data: { url, title, date, place, fee, status, id },
    };
  } catch (err) {
    if (err instanceof HttpError) {
      // 404/410 etc. sauber unterscheiden
      return { ok: false, reason: `http_${err.status}`, error: err.message };
    }
    return { ok: false, reason: "network_or_timeout", error: err.message };
  }
}

// ======= Hauptablauf =======
async function main() {
  console.log("Lade Haupt-Sitemap:", MAIN_SITEMAP);
  const mainXml = await fetchWithRetry(MAIN_SITEMAP);
  const mainObj = parseXml(mainXml);

  const indexLocs = collectAllLocs(mainObj);
  if (indexLocs.length === 0) {
    throw new Error("In der Haupt-Sitemap wurden keine <loc>-Einträge gefunden.");
  }

  const fortbildungEntry =
    indexLocs.find((loc) => loc.includes("sitemap-fortbildung") && loc.endsWith(".xml.gz")) ??
    indexLocs.find((loc) => loc.includes("sitemap-fortbildung"));

  if (!fortbildungEntry) {
    throw new Error("Kein Eintrag mit 'sitemap-fortbildung' in der Haupt-Sitemap gefunden.");
  }

  console.log("Gefundene Fortbildungs-Sitemap:", fortbildungEntry);

  let fortbildungXml;
  if (fortbildungEntry.endsWith(".gz")) {
    console.log("Lade und entpacke .xml.gz …");
    fortbildungXml = await loadGzipXmlToString(fortbildungEntry);
  } else {
    console.log("Lade .xml …");
    fortbildungXml = await fetchWithRetry(fortbildungEntry);
  }

  const fortbildungObj = parseXml(fortbildungXml);
  const allCourseLocs = collectAllLocs(fortbildungObj);

  if (allCourseLocs.length === 0) {
    throw new Error("In der Fortbildungs-Sitemap wurden keine Kurs-URLs gefunden.");
  }

  const targetUrls = allCourseLocs.filter((u) => u.includes("v00"));
  console.log(`Gefundene Kurs-URLs mit 'v00': ${targetUrls.length}`);

  const results = [];
  const stats = {
    total: targetUrls.length,
    exported: 0,
    skipped: 0,
    http_404: 0,
    http_other: 0,
    unplausible_content: 0,
    network_or_timeout: 0,
  };

  let processed = 0;

  for (const url of targetUrls) {
    processed++;
    console.log(`[${processed}/${targetUrls.length}] Lade: ${url}`);

    const res = await scrapeCourse(url);

    if (res.ok) {
      results.push(res.data);
      stats.exported++;
    } else {
      stats.skipped++;

      if (res.reason === "unplausible_content") stats.unplausible_content++;
      else if (res.reason === "network_or_timeout") stats.network_or_timeout++;
      else if (res.reason?.startsWith("http_")) {
        if (res.reason === "http_404") stats.http_404++;
        else stats.http_other++;
      }

      // Optional: hier kannst du die Fehler zusätzlich in eine eigene Datei loggen
      console.warn(`⏭️ Übersprungen (${res.reason}): ${url}${res.error ? ` → ${res.error}` : ""}`);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  await writeFile(OUT_FILE, JSON.stringify(results, null, 2), "utf-8");

  console.log(`Fertig. Gespeichert in: ${OUT_FILE}`);
  console.log("Statistik:", stats);
}

// Skript starten
main().catch((err) => {
  console.error("Abbruch wegen Fehler:", err);
  process.exit(1);
});