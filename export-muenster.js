// crawl-muenster.js
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
const REQUEST_TIMEOUT_MS = 30000;  // 30s Timeout pro Request
const REQUEST_DELAY_MS = 300;      // kleiner Delay zwischen Requests (Höflichkeit)
const USER_AGENT =
  "Mozilla/5.0 (compatible; CaritasCrawler/1.0; +https://example.org)";

// Falls Node < 18 genutzt wird, `node-fetch` einkommentieren:
// import fetch from "node-fetch";

// ======= Hilfsfunktionen =======

// Fetch mit Timeout + Kopfzeilen
async function fetchWithTimeout(url, { timeout = REQUEST_TIMEOUT_MS, binary = false } = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept": "*/*" },
    signal: controller.signal
  }).catch((err) => {
    clearTimeout(id);
    throw err;
  });
  clearTimeout(id);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} beim Laden von ${url}`);
  }
  if (binary) {
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  }
  return res.text();
}

// XML zu JS-Objekt
function parseXml(xmlString) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    trimValues: true
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

// Whitespace normalisieren (mehrfache Whitespaces -> 1 Leerzeichen, trimmen)
function normalize(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}


// Whitespace normalisieren, aber Zeilenumbrüche erhalten (für <br/> → \n)
function normalizeKeepNewlines(text) {
  return String(text ?? "")
    // mehrere Spaces/Tabs zu einem Space
    .replace(/[ \t]+/g, " ")
    // Zeilen mit reinem Space trimmen
    .split("\n").map(s => s.trim()).join("\n")
    .trim();
}

// Liest den sichtbaren Text eines Elements und wandelt <br> in \n um.
function textWithBreaks(el) {
  if (!el) return "";
  const clone = el.cloneNode(true);
  // <br> → \n
  clone.querySelectorAll("br").forEach(br => br.replaceWith("\n"));
  // Optional: wenn du lieber „ | “ statt \n willst:
  // clone.querySelectorAll("br").forEach(br => br.replaceWith(" | "));
  return normalizeKeepNewlines(clone.textContent || "");
}

// Prüft, ob ein p-Element „sinnvollen“ Inhalt hat.
// Hier reicht dir laut Anforderung: irgendein nicht-leerer Text.
function hasMeaningfulContent(pEl) {
  if (!pEl) return false;

  // Falls das P <br> enthält, ist textContent oft leer oder „“ mit viel Whitespace:
  // Wir nehmen innerHTML als Signal, ob etwas drin steht (auch nur <br> wäre dann "Inhalt?"),
  // daher schauen wir zusätzlich auf sichtbaren Text nach <br>-Konvertierung.
  const txt = textWithBreaks(pEl);
  return txt.length > 0;
}

// Nächstes Element-Geschwister, das ein <p> ist
function nextPSibling(el) {
  let n = el && el.nextElementSibling;
  while (n) {
    if (n.tagName && n.tagName.toLowerCase() === "p") return n;
    n = n.nextElementSibling;
  }
  return null;
}

function extractPrices(doc) {
  // 1) Primärziel: <p class="course-prices">
  const p = doc.querySelector("p.course-prices");

  // 2) Wenn vorhanden und „Inhalt“ hat → genau diesen übernehmen
  if (hasMeaningfulContent(p)) {
    return textWithBreaks(p);
  }

  // 3) Sonst: nächstes <p>-Geschwister nehmen (kompletter Inhalt)
  const nextP = nextPSibling(p);
  if (hasMeaningfulContent(nextP)) {
    return textWithBreaks(nextP);
  }

  // 4) Fallback (optional): Falls weder p.course-prices noch Folgep existiert/gefüllt ist,
  //    kannst du hier noch weitere Heuristiken ergänzen (z. B. JSON-LD, Span-Sibling-Scan etc.)
  return "";
}


// Text aus dem DOM holen (falls nicht vorhanden -> "")
function textOrEmpty(doc, selector) {
  const el = doc.querySelector(selector);
  return normalize(el?.textContent ?? "");
}

// GZ-XML laden, entpacken, zu String konvertieren
async function loadGzipXmlToString(url) {
  const gzBuf = await fetchWithTimeout(url, { binary: true });
  // gunzipSync ist hier ok, die Datei ist i.d.R. nicht riesig
  const xmlBuf = zlib.gunzipSync(gzBuf);
  return xmlBuf.toString("utf-8");
}

// Kursseite scrapen
async function scrapeCourse(url) {
  try {
    const html = await fetchWithTimeout(url);
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const title = textOrEmpty(doc, "h1.product-detail-name");
    const date = textOrEmpty(doc, "p.event-date-time-details");
    const place = textOrEmpty(doc, "p.event-location-name");
    //const prices = textOrEmpty(doc, "p.course-prices");        
    const fee = extractPrices(doc);
    const status = textOrEmpty(doc, "div.demand-status");
    const id = textOrEmpty(doc, "p.course-meeting-point"); // enthält id/nummer

    return {
      url,
      title,
      date,
      place,
      fee,
      status,
      id
    };
  } catch (err) {
    console.error(`Fehler beim Scrapen von ${url}: ${err.message}`);
    return {
      url,
      error: err.message
    };
  }
}

// ======= Hauptablauf =======
async function main() {
  console.log("Lade Haupt-Sitemap:", MAIN_SITEMAP);
  const mainXml = await fetchWithTimeout(MAIN_SITEMAP);
  const mainObj = parseXml(mainXml);

  const indexLocs = collectAllLocs(mainObj);
  if (indexLocs.length === 0) {
    throw new Error("In der Haupt-Sitemap wurden keine <loc>-Einträge gefunden.");
  }

  const fortbildungEntry = indexLocs.find((loc) =>
    loc.includes("sitemap-fortbildung") && loc.endsWith(".xml.gz")
  ) || indexLocs.find((loc) => loc.includes("sitemap-fortbildung"));

  if (!fortbildungEntry) {
    throw new Error(
      "Kein Eintrag mit 'sitemap-fortbildung' in der Haupt-Sitemap gefunden."
    );
  }

  console.log("Gefundene Fortbildungs-Sitemap:", fortbildungEntry);

  // .xml.gz laden und entpacken (falls die URL nicht auf .gz endet, normal laden)
  let fortbildungXml;
  if (fortbildungEntry.endsWith(".gz")) {
    console.log("Lade und entpacke .xml.gz …");
    fortbildungXml = await loadGzipXmlToString(fortbildungEntry);
  } else {
    console.log("Lade .xml …");
    fortbildungXml = await fetchWithTimeout(fortbildungEntry);
  }

  const fortbildungObj = parseXml(fortbildungXml);
  const allCourseLocs = collectAllLocs(fortbildungObj);

  if (allCourseLocs.length === 0) {
    throw new Error("In der Fortbildungs-Sitemap wurden keine Kurs-URLs gefunden.");
  }

  // Nur URLs mit "v00" behalten
  const targetUrls = allCourseLocs.filter((u) => u.includes("v00"));
  console.log(`Gefundene Kurs-URLs mit 'v00': ${targetUrls.length}`);

  const results = [];
  let processed = 0;
  for (const url of targetUrls) {
    processed++;
    console.log(`[${processed}/${targetUrls.length}] Lade: ${url}`);
    const data = await scrapeCourse(url);
    results.push(data);
    // kleiner Delay, um Server nicht zu stressen
    await sleep(REQUEST_DELAY_MS);
  }

  // JSON speichern
  await writeFile(OUT_FILE, JSON.stringify(results, null, 2), "utf-8");
  console.log(`Fertig. Gespeichert in: ${OUT_FILE}`);
}

// Skript starten
main().catch((err) => {
  console.error("Abbruch wegen Fehler:", err);
  process.exit(1);
});