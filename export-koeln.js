import fs from "fs";
//import fetch from "node-fetch";
import { JSDOM } from "jsdom";

const SITEMAP_URL = "https://www.caritas-campus.de/sitemap.xml";
const API_URL =
  "https://www.caritas-campus.de/apijson.php?act=leseVeranstaltungenDetail&nr=";
const DETAIL_URL = "https://www.caritas-campus.de/detail.php?nr=";

/* ---------------- Utils ---------------- */

function normalize(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v];
    })
  );

  return {
    throttleMs: args.throttle ? Number(args.throttle) : 300,
    debug: args.debug === "1" || args.debug === "true",
    dump: args.dump === "1" || args.dump === "true",
  };
}

function pickFirst(obj, paths) {
  for (const p of paths) {
    const v = p(obj);
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

/* ---------------- 1) Sitemap ---------------- */

async function fetchSitemapCourseNumbers() {
  const res = await fetch(SITEMAP_URL, {
    headers: { "User-Agent": "CaritasJSONExporter/1.0" },
  });
  if (!res.ok) throw new Error(`Sitemap HTTP ${res.status}`);

  const xml = await res.text();
  const dom = new JSDOM(xml, { contentType: "text/xml" });

  const numbers = Array.from(dom.window.document.querySelectorAll("loc"))
    .map((n) => n.textContent)
    .filter((u) => u.includes("detail.php?nr="))
    .map((u) => u.match(/nr=(\d+)/)?.[1])
    .filter(Boolean);

  return numbers;
}

/* ---------------- 2) Status-Mapping ---------------- */

function mapStatusStrict(code) {
  if (code === "A") return "Angebot buchbar";
  if (code === "W") return "Warteliste";
  return null;
}

/**
 * Robustere Statusermittlung:
 * - 1) data.ANMELDESTATUS.ANMELDE_STATUS
 * - 2) data.VERANSTALTUNGSTERMINE.*.ANMELDESTATUS.ANMELDE_STATUS
 * - Optional: Ableitung über freie Plätze (wenn Codes nicht A/W liefern)
 */
function extractStatusInfo(data) {
  const statusBlock1 = data?.ANMELDESTATUS;

  // Fallback: manche Kurse haben den Status nur unter VERANSTALTUNGSTERMINE
  let statusBlock2 = undefined;
  const vt = data?.VERANSTALTUNGSTERMINE;
  if (vt && typeof vt === "object") {
    for (const k of Object.keys(vt)) {
      const candidate = vt?.[k]?.ANMELDESTATUS;
      if (candidate && (candidate.ANMELDE_STATUS || candidate.FREIE_PLAETZE || candidate.WARTELISTE_PLAETZE)) {
        statusBlock2 = candidate;
        break;
      }
    }
  }

  const statusBlock = statusBlock1 ?? statusBlock2 ?? null;

  const code = statusBlock?.ANMELDE_STATUS ?? null;

  const frei = Number(statusBlock?.FREIE_PLAETZE ?? 0);
  const wl = Number(statusBlock?.WARTELISTE_PLAETZE ?? 0);

  // Strict mapping A/W
  const strict = mapStatusStrict(code);

  // Heuristik (nur als Fallback): falls Code nicht A/W ist, aber Plätze vorhanden
  let derived = null;
  if (!strict) {
    if (frei > 0) derived = "Angebot buchbar";
    else if (wl > 0) derived = "Warteliste";
  }

  return {
    code,
    frei,
    wl,
    strict,
    derived,
    statusBlockFrom: statusBlock1 ? "data.ANMELDESTATUS" : statusBlock2 ? "data.VERANSTALTUNGSTERMINE.*.ANMELDESTATUS" : "none",
  };
}

/* ---------------- 3) Kursdaten per JSON ---------------- */

function extractDataRoot(raw) {
  // Es gibt Varianten in der API-Antwort. Wir versuchen mehrere Pfade.
  const data = pickFirst(raw, [
    (o) => o?.evewa4rest?.leseVeranstaltungDetail?.data,
    (o) => o?.evewa4rest?.leseVeranstaltungenDetail?.data,
    (o) => o?.evewa4rest?.leseVeranstaltungDetails?.data,
    (o) => o?.leseVeranstaltungDetail?.data,
    (o) => o?.leseVeranstaltungenDetail?.data,
  ]);

  return data;
}

async function fetchCourseViaApi(nr, { debug, dump }, stats) {
  const apiUrl = API_URL + nr;

  let res;
  try {
    res = await fetch(apiUrl, {
      headers: {
        "User-Agent": "CaritasJSONExporter/1.0",
        Accept: "application/json",
      },
    });
  } catch (e) {
    console.warn(`❌ [${nr}] Fetch-Fehler:`, e?.message ?? e);
    stats.fetchErrors++;
    return null;
  }

  if (!res.ok) {
    console.warn(`⚠️ [${nr}] HTTP ${res.status} (${apiUrl})`);
    stats.httpNotOk++;
    return null;
  }

  let raw;
  try {
    raw = await res.json();
  } catch (e) {
    console.warn(`❌ [${nr}] JSON parse Fehler:`, e?.message ?? e);
    stats.jsonParseErrors++;
    return null;
  }

  stats.fetchedOk++;

  const data = extractDataRoot(raw);
  if (!data) {
    stats.noDataRoot++;
    if (debug) {
      const topKeys = Object.keys(raw ?? {});
      console.log(`🧩 [${nr}] Kein data-Root gefunden. TopKeys=`, topKeys);
      const eveKeys = Object.keys(raw?.evewa4rest ?? {});
      console.log(`🧩 [${nr}] evewa4rest Keys=`, eveKeys);
    }
    if (dump) {
      fs.writeFileSync(`dump-${nr}.json`, JSON.stringify(raw, null, 2), "utf-8");
      console.log(`📝 [${nr}] Dump geschrieben: dump-${nr}.json`);
    }
    return null;
  }

  stats.dataRootOk++;

  // Status robust bestimmen
  const statusInfo = extractStatusInfo(data);

  // Logging: Statusübersicht
  if (debug) {
    console.log(
      `ℹ️ [${nr}] StatusPfad=${statusInfo.statusBlockFrom} Code=${statusInfo.code} frei=${statusInfo.frei} wl=${statusInfo.wl} strict=${statusInfo.strict} derived=${statusInfo.derived}`
    );
  }

  // Diese Zeile steuert die Business-Logik:
  // - strictOnly = exakt A/W
  // - allowDerived = A/W oder über freie Plätze/Warteliste ableiten
  const strictOnly = false; // <- wenn du nur A/W willst: auf true setzen
  const status = strictOnly ? statusInfo.strict : (statusInfo.strict ?? statusInfo.derived);

  if (!status) {
    stats.filteredByStatus++;
    stats.statusCounts[statusInfo.code ?? "null/undef"] =
      (stats.statusCounts[statusInfo.code ?? "null/undef"] ?? 0) + 1;

    if (debug) {
      console.log(
        `⛔ [${nr}] Gefiltert (kein passender Status). ARTIKEL="${normalize(data.ARTIKEL)}" B_DAT="${normalize(data.B_DAT)}"`
      );
    }
    if (dump) {
      fs.writeFileSync(`dump-${nr}.json`, JSON.stringify(raw, null, 2), "utf-8");
      console.log(`📝 [${nr}] Dump geschrieben (gefiltert): dump-${nr}.json`);
    }
    return null;
  }

  // Feldzuordnung nach deinem Beispiel
  const out = {
    id: normalize(data.ARTIKEL_NR),
    title: normalize(data.ARTIKEL),
    date: normalize(data.B_DAT),
    place: normalize(data.VO_ADRESSE),
    fee: [
      data.GEB01 && `Intern: ${normalize(data.GEB01)}`,
      data.GEB02 && `Extern: ${normalize(data.GEB02)}`,
    ]
      .filter(Boolean)
      .join(" "),
    status,
    url: DETAIL_URL + nr,
  };

  // Minimale Plausibilitäts-Logs
  if (debug) {
    console.log(
      `✅ [${nr}] Export OK: id="${out.id}" title="${out.title}" date="${out.date}"`
    );
  }

  stats.exported++;
  return out;
}

/* ---------------- 4) Main ---------------- */

async function main() {
  const { throttleMs, debug, dump } = parseArgs();

  console.log("📄 Lade Sitemap …");
  const allNumbers = await fetchSitemapCourseNumbers();

  // 🔴 TEST: NUR 20 KURSE — später einfach diese Zeile löschen
  const numbers = allNumbers;

  console.log(`🔎 Testlauf mit ${numbers.length} Kursen (von ${allNumbers.length})`);
  if (debug) console.log(`🛠️ Debug aktiv. Dump=${dump ? "an" : "aus"}`);

  const stats = {
    fetchedOk: 0,
    fetchErrors: 0,
    httpNotOk: 0,
    jsonParseErrors: 0,
    dataRootOk: 0,
    noDataRoot: 0,
    filteredByStatus: 0,
    exported: 0,
    statusCounts: {},
  };

  const results = [];

  for (const nr of numbers) {
    console.log(`🔄 Kurs ${nr}`);
    const data = await fetchCourseViaApi(nr, { debug, dump }, stats);
    if (data) results.push(data);
    await sleep(throttleMs);
  }

  fs.writeFileSync("kurse-koeln.json", JSON.stringify(results, null, 2), "utf-8");

  console.log("—".repeat(60));
  console.log(`✅ Fertig: ${stats.exported} Kurse exportiert → kurse-koeln.json`);
  console.log(
    `📊 fetchedOk=${stats.fetchedOk}, dataRootOk=${stats.dataRootOk}, filteredByStatus=${stats.filteredByStatus}, noDataRoot=${stats.noDataRoot}, httpNotOk=${stats.httpNotOk}, fetchErrors=${stats.fetchErrors}, jsonParseErrors=${stats.jsonParseErrors}`
  );

  const statusKeys = Object.keys(stats.statusCounts);
  if (statusKeys.length) {
    console.log("📌 Status-Codes (gefiltert) Häufigkeit:");
    for (const k of statusKeys.sort()) {
      console.log(`   - ${k}: ${stats.statusCounts[k]}`);
    }
  } else {
    console.log("📌 Keine Status-Codes gezählt (entweder nichts gefiltert oder keine Daten).");
  }

  // Optional: Wenn 0 exportiert, Hinweis geben
  if (stats.exported === 0) {
    console.log("⚠️ Hinweis: 0 Exporte. Starte einmal mit: npm run scrape -- --debug=1 --dump=1");
    console.log("   Dann bekommst du für gefilterte Kurse dump-<nr>.json und wir sehen den echten JSON-Pfad.");
  }
}

main().catch((err) => {
  console.error("❌ Unerwarteter Fehler:", err);
  process.exit(1);
});