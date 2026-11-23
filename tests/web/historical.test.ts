// react is a workspace dependency of @markethub/web, not the repo root.
import { readFileSync } from "node:fs";
import { createElement } from "../../apps/web/node_modules/react";
import { renderToStaticMarkup } from "../../apps/web/node_modules/react-dom/server";
import { afterEach, describe, expect, test } from "bun:test";
import {
  candleIntervalSchema,
  istCalendarParts, istDateString, istDayStartMs, istMonthStartMs, nextIstMonthStartMs,
  parseIstDateOnly, parseIstDateRange, retentionCleanupResultSchema, retentionSettingsSchema,
  retentionSettingsViewSchema, type HistoricalCandle, type HistoricalSyncConfig,
  type RetentionDataClass, type RetentionSettingsView
} from "../../packages/contracts/src/index";
import {
  deleteSyncConfig, fetchCachedCandles, fetchCoverage, fetchRetention, fetchSyncConfigs,
  HistoricalHttpError, runRetentionCleanup, saveRetention, saveSyncConfig
} from "../../apps/web/src/lib/historical";
import { draftFromView, parseRetentionDraft, retentionSaveDecision, type RetentionDraft } from "../../apps/web/src/lib/retention-form";
import { HistoricalPanel, historicalFocusToForm, RetentionFieldsView } from "../../apps/web/src/components/HistoricalPanel";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { status, body } = handler(String(input), init);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

describe("retention client with ACTIVITY", () => {
  test("cleanup result includes activitiesDeleted and settings preserve ACTIVITY", async () => {
    fakeFetch(() => ({ status: 200, body: { ran: true, reason: null, candlesDeleted: 1, snapshotsDeleted: 2, activitiesDeleted: 3 } }));
    const result = await runRetentionCleanup();
    expect(result.activitiesDeleted).toBe(3);

    fakeFetch(() => ({
      status: 200,
      body: { settings: { version: 1, classes: { CANDLE: { maxAgeDays: 5 }, SNAPSHOT: { maxAgeDays: 7 }, ACTIVITY: { maxAgeDays: 9 } } }, valid: true, error: null }
    }));
    const view = await fetchRetention();
    expect(view.settings?.classes.ACTIVITY?.maxAgeDays).toBe(9);
    expect(view.settings?.classes.CANDLE?.maxAgeDays).toBe(5);
    expect(view.settings?.classes.SNAPSHOT?.maxAgeDays).toBe(7);
  });
});

const candle: HistoricalCandle = {
  canonicalId: "A", interval: "1D", tsMs: 1700000000000, open: 10, high: 12, low: 9, close: 11,
  volume: 100, oi: null, provider: "UPSTOX",
  provenance: { source: "provider-feed", provider: "UPSTOX", receivedAt: "2026-01-01T00:00:00.000Z" },
  receivedAtMs: 1700000000000
};

const config: HistoricalSyncConfig = {
  id: "sync-1", canonicalId: "A", interval: "1D", enabled: true,
  dateRangeJson: null, scheduleJson: null, providerPolicyJson: null,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
};

const request = { canonicalId: "A", interval: "1D" as const, fromMs: 1, toMs: 2 };

describe("India-local date-only range", () => {
  test("date-only selection maps to inclusive IST boundaries", () => {
    const range = parseIstDateRange("2026-01-05", "2026-01-05");
    expect(range).not.toBeNull();
    // 2026-01-05 00:00 IST = 2026-01-04 18:30Z; end = 23:59:59.999 IST
    expect(range!.fromMs).toBe(Date.parse("2026-01-04T18:30:00.000Z"));
    expect(range!.toMs).toBe(Date.parse("2026-01-05T18:29:59.999Z"));
  });

  test("multi-day selection covers the full final date and rejects inverted ranges", () => {
    const range = parseIstDateRange("2026-01-05", "2026-01-06");
    expect(range!.toMs).toBe(Date.parse("2026-01-06T18:29:59.999Z"));
    expect(parseIstDateRange("2026-01-06", "2026-01-05")).toBeNull();
    expect(parseIstDateRange("not-a-date", "2026-01-05")).toBeNull();
  });

  test("valid ordinary dates and leap day are accepted", () => {
    expect(Number.isFinite(parseIstDateOnly("2026-01-05"))).toBe(true);
    expect(Number.isFinite(parseIstDateOnly("2024-02-29"))).toBe(true); // leap day
    expect(parseIstDateOnly("2024-02-29")).toBe(Date.parse("2024-02-28T18:30:00.000Z"));
    expect(Number.isFinite(parseIstDateOnly("2000-02-29"))).toBe(true); // century leap year
  });

  test("impossible calendar dates are rejected, not normalized", () => {
    for (const invalid of [
      "2025-02-29", // non-leap year
      "1900-02-29", // century non-leap year
      "2026-02-30", // February has at most 29 days
      "2026-04-31", // April has 30 days
      "2026-00-10", // month 00
      "2026-13-10", // month 13
      "2026-01-00", // day 00
      "2026-01-32"  // day 32
    ]) {
      expect(Number.isNaN(parseIstDateOnly(invalid))).toBe(true);
      expect(parseIstDateRange(invalid, "2026-01-05")).toBeNull();
      expect(parseIstDateRange("2026-01-05", invalid)).toBeNull();
    }
  });

  test("four-digit year boundaries are handled without Date.UTC 0-99 remapping", () => {
    // Date.UTC(5, ...) would mean 1905; the four-digit string "0005" must mean year 5.
    // Verify via IST calendar parts: 00:00 IST is the previous UTC day, so UTC
    // getters would report year 4 for "0005-01-01".
    const year5 = parseIstDateOnly("0005-01-01");
    expect(Number.isFinite(year5)).toBe(true);
    expect(istCalendarParts(year5)).toEqual({ year: 5, month: 0, day: 1, weekday: istCalendarParts(year5).weekday });

    const year99 = parseIstDateOnly("0099-12-31");
    expect(istCalendarParts(year99).year).toBe(99);
    expect(istCalendarParts(year99).month).toBe(11);
    expect(istCalendarParts(year99).day).toBe(31);

    expect(Number.isFinite(parseIstDateOnly("9999-12-31"))).toBe(true);
    expect(istCalendarParts(parseIstDateOnly("0000-01-01")).year).toBe(0); // year 0 is a valid four-digit year
  });

  test("all IST boundary helpers avoid Date.UTC 0-99 remapping", () => {
    // A timestamp whose IST calendar date is 0005-01-15.
    const ts = parseIstDateOnly("0005-01-15");
    expect(istCalendarParts(istDayStartMs(ts))).toMatchObject({ year: 5, month: 0, day: 15 });
    expect(istCalendarParts(istMonthStartMs(ts))).toMatchObject({ year: 5, month: 0, day: 1 });
    expect(istCalendarParts(nextIstMonthStartMs(ts))).toMatchObject({ year: 5, month: 1, day: 1 });

    // December of year 0099 rolls into year 0100 for the next-month helper.
    const dec = parseIstDateOnly("0099-12-10");
    expect(istCalendarParts(nextIstMonthStartMs(dec))).toMatchObject({ year: 100, month: 0, day: 1 });
  });

  test("istDateString zero-pads years below 1000", () => {
    expect(istDateString(parseIstDateOnly("0005-01-15"))).toBe("0005-01-15");
    expect(istDateString(parseIstDateOnly("0099-12-31"))).toBe("0099-12-31");
    expect(istDateString(parseIstDateOnly("2026-01-05"))).toBe("2026-01-05");
  });
});

describe("M6-C Finding 3 — activity historical ref navigation uses IST dates", () => {
  test("focus conversion uses India-local calendar dates, not UTC slicing", () => {
    // 2026-01-05 00:00 IST = 2026-01-04T18:30:00.000Z. UTC slicing would
    // produce "2026-01-04"; istDateString must produce "2026-01-05".
    const fromMs = Date.parse("2026-01-04T18:30:00.000Z");
    const toMs = Date.parse("2026-01-05T18:29:59.999Z");
    const form = historicalFocusToForm({ canonicalId: "NIFTY", interval: "1D", fromMs, toMs });
    expect(form).not.toBeNull();
    expect(form!.from).toBe("2026-01-05");
    expect(form!.to).toBe("2026-01-05");
    expect(form!.canonicalId).toBe("NIFTY");
    expect(form!.interval).toBe("1D");
  });

  test("focus conversion validates the interval against the canonical contract", () => {
    const fromMs = Date.parse("2026-01-04T18:30:00.000Z");
    expect(historicalFocusToForm({ canonicalId: "NIFTY", interval: "BOGUS", fromMs, toMs: fromMs })).toBeNull();
    expect(historicalFocusToForm({ canonicalId: "NIFTY", interval: "60m", fromMs, toMs: fromMs })?.interval).toBe("60m");
  });

  test("panel renders the instrument picker, not a manual canonical-ID input", () => {
    const html = renderToStaticMarkup(createElement(HistoricalPanel, {}));
    expect(html).toContain("picker-value");
    expect(html).not.toContain('aria-label="Canonical instrument ID"');
  });

  test("interval selector renders every shared contract value including 30m", () => {
    // HistoricalPanel uses hooks, so render it rather than calling it directly.
    const html = renderToStaticMarkup(createElement(HistoricalPanel, {}));
    expect(candleIntervalSchema.options).toHaveLength(16);
    for (const interval of candleIntervalSchema.options) {
      expect(html).toContain(`value="${interval}"`);
    }
    expect(html).toContain('value="30m"');
    expect(html).toMatch(/<option value="1D" selected="">1D<\/option>/);
  });

  test("IST boundary near midnight maps to the correct local date", () => {
    // 23:30 IST on 2026-03-10 = 18:00Z on 2026-03-10; UTC slicing also gives
    // 03-10 here, but a late-evening UTC timestamp (e.g. 20:00Z) is already
    // 01:30 IST the next day and must roll forward.
    const lateMs = Date.parse("2026-03-10T20:00:00.000Z"); // 2026-03-11 01:30 IST
    const form = historicalFocusToForm({ canonicalId: "A", interval: "1D", fromMs: lateMs, toMs: lateMs });
    expect(form!.from).toBe("2026-03-11");
    expect(new Date(lateMs).toISOString().slice(0, 10)).toBe("2026-03-10"); // proves UTC slicing differs
  });
});

describe("historical web client", () => {
  test("cached candles are validated with the contracts schema", async () => {
    fakeFetch(() => ({ status: 200, body: { candles: [candle] } }));
    const result = await fetchCachedCandles(request);
    expect(result.candles.length).toBe(1);
    expect(result.candles[0]!.close).toBe(11);
  });

  test("invalid candle payload is rejected", async () => {
    fakeFetch(() => ({ status: 200, body: { candles: [{ close: "bad" }] } }));
    await expect(fetchCachedCandles(request)).rejects.toBeDefined();
  });

  test("coverage preserves unconfirmed gaps, basis and unavailable notes", async () => {
    fakeFetch(() => ({
      status: 200,
      body: {
        gaps: [{ canonicalId: "A", interval: "1D", fromMs: 1, toMs: 2, basis: "WEEKDAY_ONLY", confirmed: false, reason: "no candle stored" }],
        basis: "WEEKDAY_ONLY", confirmed: false,
        unavailableNotes: [{
          canonicalId: "A", interval: "1D", provider: "FYERS", rangeStartMs: 3, rangeEndMs: 4,
          kind: "UNAVAILABLE", reasonCode: "NO_DATA", reasonJson: "{}",
          requestedAtMs: 5, updatedAtMs: 5
        }]
      }
    }));
    const result = await fetchCoverage(request);
    expect(result.gaps[0]!.basis).toBe("WEEKDAY_ONLY");
    expect(result.gaps[0]!.confirmed).toBe(false);
    expect(result.confirmed).toBe(false);
    expect(result.unavailableNotes[0]!.reasonCode).toBe("NO_DATA");
    expect(result.unavailableNotes[0]!.provider).toBe("FYERS");
  });

  test("sync config CRUD round-trips and 403 is forbidden", async () => {
    fakeFetch(() => ({ status: 200, body: { configs: [config] } }));
    expect((await fetchSyncConfigs()).length).toBe(1);

    fakeFetch(() => ({ status: 200, body: { config } }));
    expect((await saveSyncConfig(config)).id).toBe("sync-1");

    fakeFetch(() => ({ status: 200, body: { ok: true } }));
    await expect(deleteSyncConfig("sync-1")).resolves.toBeUndefined();

    fakeFetch(() => ({ status: 403, body: { error: "forbidden", message: "local only" } }));
    try {
      await saveSyncConfig(config);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(HistoricalHttpError);
      expect((error as HistoricalHttpError).kind).toBe("forbidden");
    }
  });

  test("retention view, save and cleanup fail-safe are surfaced", async () => {
    fakeFetch(() => ({ status: 200, body: { settings: null, valid: false, error: "not configured" } }));
    const invalid = await fetchRetention();
    expect(invalid.valid).toBe(false);
    expect(invalid.settings).toBeNull();

    fakeFetch(() => ({ status: 200, body: { settings: { version: 1, classes: { CANDLE: { maxAgeDays: 30 } } }, valid: true, error: null } }));
    const saved = await saveRetention({ version: 1, classes: { CANDLE: { maxAgeDays: 30 } } });
    expect(saved.valid).toBe(true);
    expect(saved.settings?.classes.CANDLE?.maxAgeDays).toBe(30);

    fakeFetch(() => ({ status: 200, body: { ran: false, reason: "invalid", candlesDeleted: 0, snapshotsDeleted: 0, activitiesDeleted: 0 } }));
    const cleanup = await runRetentionCleanup();
    expect(cleanup.ran).toBe(false);
    expect(cleanup.candlesDeleted).toBe(0);
  });
});

describe("WP6A — retention client validates complete envelopes", () => {
  test("fetchRetention rejects malformed full response envelopes", async () => {
    const malformed: unknown[] = [
      { settings: { version: 1, classes: {} }, valid: true, error: "unexpected error" },
      { settings: null, valid: false, error: "" },
      { settings: null, valid: true, error: null },
      { settings: { version: 1, classes: {} }, valid: "yes", error: null },
      { settings: { version: 99, classes: {} }, valid: true, error: null },
      { valid: false, error: "missing settings" },
      null
    ];
    for (const body of malformed) {
      fakeFetch(() => ({ status: 200, body }));
      await expect(fetchRetention()).rejects.toBeDefined();
    }
  });

  test("runRetentionCleanup rejects malformed or incomplete payloads instead of zero-defaulting", async () => {
    const ok = { ran: true, reason: null, candlesDeleted: 1, snapshotsDeleted: 2, activitiesDeleted: 3 };
    const malformed: unknown[] = [
      { ...ok, activitiesDeleted: undefined },
      { ran: true, reason: null, candlesDeleted: 1, snapshotsDeleted: 2 },
      { ...ok, candlesDeleted: 1.5 },
      { ...ok, candlesDeleted: -1 },
      { ...ok, candlesDeleted: "1" },
      { ...ok, reason: 5 },
      { ...ok, ran: "true" },
      null
    ];
    for (const body of malformed) {
      fakeFetch(() => ({ status: 200, body }));
      await expect(runRetentionCleanup()).rejects.toBeDefined();
    }
  });

  test("all three classes round-trip through the client and shared schemas", async () => {
    const settings = {
      version: 1 as const,
      classes: { CANDLE: { maxAgeDays: 5 }, SNAPSHOT: { maxAgeDays: 7 }, ACTIVITY: { maxAgeDays: 9 } }
    };
    fakeFetch(() => ({ status: 200, body: { settings, valid: true, error: null } }));
    const fetched = await fetchRetention();
    expect(retentionSettingsViewSchema.safeParse(fetched).success).toBe(true);
    expect(fetched.settings?.classes.CANDLE?.maxAgeDays).toBe(5);
    expect(fetched.settings?.classes.SNAPSHOT?.maxAgeDays).toBe(7);
    expect(fetched.settings?.classes.ACTIVITY?.maxAgeDays).toBe(9);

    fakeFetch(() => ({ status: 200, body: { settings, valid: true, error: null } }));
    const saved = await saveRetention(settings);
    expect(saved.valid).toBe(true);
    expect(saved.settings?.classes.ACTIVITY?.maxAgeDays).toBe(9);

    const cleanup = { ran: true, reason: null, candlesDeleted: 1, snapshotsDeleted: 2, activitiesDeleted: 3 };
    fakeFetch(() => ({ status: 200, body: cleanup }));
    const result = await runRetentionCleanup();
    expect(retentionCleanupResultSchema.safeParse(result).success).toBe(true);
    expect(result).toEqual(cleanup);
  });
});

describe("WP6A — retention form helpers", () => {
  const classes: RetentionDataClass[] = ["CANDLE", "SNAPSHOT", "ACTIVITY"];
  const cases: Array<{ raw: string; ok: boolean; value?: number }> = [
    { raw: "", ok: true },
    { raw: "   ", ok: true },
    { raw: "30", ok: true, value: 30 },
    { raw: "01", ok: true, value: 1 },
    { raw: "0", ok: false },
    { raw: "-1", ok: false },
    { raw: "1.5", ok: false },
    { raw: "1e2", ok: false },
    { raw: "1.0", ok: false },
    { raw: "1,000", ok: false },
    { raw: "+1", ok: false },
    { raw: "abc", ok: false },
    { raw: "9007199254740992", ok: false }
  ];

  test("parseRetentionDraft table-driven cases for every class", () => {
    for (const dataClass of classes) {
      for (const c of cases) {
        const draft: RetentionDraft = { CANDLE: "", SNAPSHOT: "", ACTIVITY: "", [dataClass]: c.raw };
        const { settings, errors } = parseRetentionDraft(draft);
        if (c.ok) {
          expect(settings).not.toBeNull();
          expect(Object.keys(errors)).toHaveLength(0);
          expect(settings!.classes[dataClass]?.maxAgeDays).toBe(c.value);
        } else {
          expect(settings).toBeNull();
          expect(typeof errors[dataClass]).toBe("string");
          expect(errors[dataClass]!.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test("parseRetentionDraft does not mutate the supplied draft", () => {
    const draft: RetentionDraft = { CANDLE: " 30 ", SNAPSHOT: "abc", ACTIVITY: "" };
    const before = JSON.stringify(draft);
    parseRetentionDraft(draft);
    expect(JSON.stringify(draft)).toBe(before);
  });

  test("parseRetentionDraft returns field-specific errors for multiple invalid fields", () => {
    const { settings, errors } = parseRetentionDraft({ CANDLE: "-1", SNAPSHOT: "1.5", ACTIVITY: "30" });
    expect(settings).toBeNull();
    expect(typeof errors.CANDLE).toBe("string");
    expect(typeof errors.SNAPSHOT).toBe("string");
    expect(errors.ACTIVITY).toBeUndefined();
  });

  test("parseRetentionDraft returns a schema-valid settings object when all fields are valid", () => {
    const { settings, errors } = parseRetentionDraft({ CANDLE: "30", SNAPSHOT: "01", ACTIVITY: "9" });
    expect(errors).toEqual({});
    expect(settings).toEqual({
      version: 1,
      classes: { CANDLE: { maxAgeDays: 30 }, SNAPSHOT: { maxAgeDays: 1 }, ACTIVITY: { maxAgeDays: 9 } }
    });
    expect(retentionSettingsSchema.safeParse(settings).success).toBe(true);
  });

  test("draftFromView maps valid views to digit strings and invalid/missing views to blanks", () => {
    const validView: RetentionSettingsView = {
      settings: { version: 1, classes: { CANDLE: { maxAgeDays: 30 }, ACTIVITY: { maxAgeDays: 9 } } },
      valid: true,
      error: null
    };
    expect(draftFromView(validView)).toEqual({ CANDLE: "30", SNAPSHOT: "", ACTIVITY: "9" });

    const emptyView: RetentionSettingsView = { settings: { version: 1, classes: {} }, valid: true, error: null };
    expect(draftFromView(emptyView)).toEqual({ CANDLE: "", SNAPSHOT: "", ACTIVITY: "" });

    const invalidView: RetentionSettingsView = { settings: null, valid: false, error: "not configured" };
    expect(draftFromView(invalidView)).toEqual({ CANDLE: "", SNAPSHOT: "", ACTIVITY: "" });
  });
});

describe("WP6A — retention panel static rendering", () => {
  test("renders three text/numeric inputs, no number inputs, and honest status copy", () => {
    const html = renderToStaticMarkup(createElement(HistoricalPanel, {}));
    const labels = ["Candle max age days", "Snapshot max age days", "Activity max age days"];
    for (const label of labels) {
      expect(html).toContain(`aria-label="${label}"`);
      expect(html).toMatch(new RegExp(`aria-label="${label}"[^>]*value=""`));
    }
    expect(html.match(/type="text"/g)?.length).toBe(3);
    expect(html.toLowerCase().match(/inputmode="numeric"/g)?.length).toBe(3);
    expect(html).not.toContain('type="number"');
    expect(html).toContain("No valid saved retention settings. Cleanup is disabled and deletes nothing.");
    expect(html).toContain("Edits are not saved until you select Save retention.");
    expect(html).toContain("Run cleanup uses the saved settings, not this unsaved draft.");
    expect(html).toContain("Valid settings with no limits delete nothing.");
  });

  test("component source pins all three distinct persisted-state messages", () => {
    const source = readFileSync(new URL("../../apps/web/src/components/HistoricalPanel.tsx", import.meta.url), "utf8");
    expect(source).toContain("No valid saved retention settings. Cleanup is disabled and deletes nothing.");
    expect(source).toContain("Saved settings are valid, but no retention limits are configured. Cleanup will delete nothing.");
    expect(source).toContain("Saved retention limits apply only to the configured data classes.");
  });
});

describe("WP6A — retention save decision (component wiring seam)", () => {
  test("invalid draft blocks save with field-specific errors and no settings", () => {
    const decision = retentionSaveDecision({ CANDLE: "", SNAPSHOT: "", ACTIVITY: "1.5" });
    expect(decision.kind).toBe("block");
    if (decision.kind === "block") {
      expect(decision.errors.ACTIVITY).toBeDefined();
      expect(decision.errors.CANDLE).toBeUndefined();
      expect(decision.errors.SNAPSHOT).toBeUndefined();
      expect("settings" in decision).toBe(false);
    }
  });

  test("valid draft returns a schema-valid settings object for save", () => {
    const decision = retentionSaveDecision({ CANDLE: "30", SNAPSHOT: "01", ACTIVITY: "9" });
    expect(decision.kind).toBe("save");
    if (decision.kind === "save") {
      expect(retentionSettingsSchema.safeParse(decision.settings).success).toBe(true);
      expect(decision.settings).toEqual({
        version: 1,
        classes: { CANDLE: { maxAgeDays: 30 }, SNAPSHOT: { maxAgeDays: 1 }, ACTIVITY: { maxAgeDays: 9 } }
      });
    }
  });

  test("blank draft saves a valid empty settings object", () => {
    const decision = retentionSaveDecision({ CANDLE: "", SNAPSHOT: "", ACTIVITY: "" });
    expect(decision.kind).toBe("save");
    if (decision.kind === "save") {
      expect(decision.settings).toEqual({ version: 1, classes: {} });
      expect(retentionSettingsSchema.safeParse(decision.settings).success).toBe(true);
    }
  });

  test("component routes save through the decision seam with a single save call", () => {
    const source = readFileSync(new URL("../../apps/web/src/components/HistoricalPanel.tsx", import.meta.url), "utf8");
    expect(source).toContain("retentionSaveDecision(retentionDraft)");
    expect(source).toContain("saveRetention(decision.settings)");
    expect(source.match(/saveRetention\(/g)?.length).toBe(1);
  });
});

describe("WP6A — retention fields view static rendering", () => {
  test("retains invalid raw text, shows field error and aria-invalid without a DOM", () => {
    const status = "No valid saved retention settings. Cleanup is disabled and deletes nothing.";
    const html = renderToStaticMarkup(createElement(RetentionFieldsView, {
      draft: { CANDLE: "", SNAPSHOT: "", ACTIVITY: "1.5" },
      errors: { ACTIVITY: "Enter a positive whole number of days." },
      status,
      onChange: () => {},
      onSave: () => {},
      onCleanup: () => {}
    }));

    // Raw invalid text is retained verbatim in the controlled input.
    expect(html).toContain('aria-label="Activity max age days"');
    expect(html).toMatch(/aria-label="Activity max age days"[^>]*value="1\.5"/);
    expect(html.match(/aria-invalid="true"/g)?.length).toBe(1);
    expect(html.match(/aria-invalid="false"/g)?.length).toBe(2);
    expect(html).toContain("Enter a positive whole number of days.");
    expect(html).toContain('role="alert"');

    // Three text/numeric inputs, no number input.
    expect(html.match(/type="text"/g)?.length).toBe(3);
    expect(html.toLowerCase().match(/inputmode="numeric"/g)?.length).toBe(3);
    expect(html).not.toContain('type="number"');

    // Status, saved-vs-unsaved copy and both actions.
    expect(html).toContain(status);
    expect(html).toContain("Edits are not saved until you select Save retention.");
    expect(html).toContain("Run cleanup uses the saved settings, not this unsaved draft.");
    expect(html).toContain("Save retention");
    expect(html).toContain("Run cleanup");
  });
});
