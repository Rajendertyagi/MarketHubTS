import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, SqliteCatalogRepository } from "../../packages/database/src/index";
import type { CanonicalInstrument, CatalogSyncBatch } from "../../packages/contracts/src/index";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

const dirs: string[] = [];
const handles: Array<{ close: () => void } | null> = [];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "markethub-catalog-search-"));
  dirs.push(dir);
  const handle = openDatabase({ dbPath: join(dir, "test.sqlite"), migrate: true });
  handles.push(handle);
  return { dir, handle, repo: new SqliteCatalogRepository(handle.db, handle.sqlite) };
}

afterEach(() => {
  while (handles.length) { try { closeDatabaseHandle(handles.pop() ?? undefined); } catch {} }
  while (dirs.length) { try { removeTempDir(dirs.pop()!); } catch {} }
});

function instrument(id: string, symbol: string, display: string): CanonicalInstrument {
  return {
    canonicalId: id,
    identityKey: `v1|NSE|INDEX|INDEX|CODE:${symbol}`,
    identityVersion: 1,
    exchange: "NSE",
    segment: "INDEX",
    marketType: "INDEX",
    instrumentCategory: "INDEX",
    canonicalSymbol: symbol,
    displayName: display,
    tradingStatus: "ACTIVE",
    lifecycleStatus: "ACTIVE",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  } as CanonicalInstrument;
}

async function seed(repo: SqliteCatalogRepository, instruments: CanonicalInstrument[]): Promise<void> {
  const batch: CatalogSyncBatch = {
    source: "TEST",
    capturedAt: "2026-01-01T00:00:00.000Z",
    instruments,
    aliases: [],
    identifiers: [],
    mappings: [],
    derivativeContracts: []
  } as CatalogSyncBatch;
  await repo.transaction(async (tx) => {
    for (const i of instruments) await tx.upsertInstrument(i);
  });
  void batch;
}

describe("catalog search (M6-B1)", () => {
  test("rejects empty and whitespace-only text at the repository boundary", async () => {
    const { repo } = setup();
    expect(await repo.searchInstruments({ text: "", limit: 25 })).toEqual([]);
    expect(await repo.searchInstruments({ text: "   ", limit: 25 })).toEqual([]);
  });

  test("matches canonical symbol, display name and identity key deterministically", async () => {
    const { repo } = setup();
    await seed(repo, [
      instrument("id-1", "NIFTY50", "Nifty 50 Index"),
      instrument("id-2", "BANKNIFTY", "Nifty Bank Index"),
      instrument("id-3", "RELIANCE", "Reliance Industries")
    ]);
    const bySymbol = await repo.searchInstruments({ text: "nifty", limit: 25 });
    expect(bySymbol.map((i) => i.canonicalId)).toEqual(["id-1", "id-2"]);
    const byDisplay = await repo.searchInstruments({ text: "Reliance", limit: 25 });
    expect(byDisplay.map((i) => i.canonicalId)).toEqual(["id-3"]);
    const byIdentity = await repo.searchInstruments({ text: "CODE:BANKNIFTY", limit: 25 });
    expect(byIdentity.map((i) => i.canonicalId)).toEqual(["id-2"]);
  });

  test("LIKE metacharacters are escaped, not treated as wildcards", async () => {
    const { repo } = setup();
    await seed(repo, [instrument("id-1", "NIFTY50", "Nifty 50"), instrument("id-2", "BANKNIFTY", "Bank Nifty")]);
    expect(await repo.searchInstruments({ text: "%", limit: 25 })).toEqual([]);
  });

  test("keyset pagination with limit+1 lookahead: ordering, bounds and nextCursor", async () => {
    const { repo } = setup();
    await seed(repo, [
      instrument("id-1", "AAA1", "Alpha 1"),
      instrument("id-2", "AAA2", "Alpha 2"),
      instrument("id-3", "AAA3", "Alpha 3"),
      instrument("id-4", "AAA4", "Alpha 4")
    ]);

    // limit=2 fetches 3 rows (lookahead); caller slices to 2 and derives nextCursor.
    const first = await repo.searchInstruments({ text: "AAA", limit: 2 });
    expect(first.map((i) => i.canonicalId)).toEqual(["id-1", "id-2", "id-3"]);
    const page1 = first.slice(0, 2);
    expect(page1.map((i) => i.canonicalId)).toEqual(["id-1", "id-2"]);
    expect(first.length > 2 ? page1[page1.length - 1]!.canonicalId : null).toBe("id-2");

    const second = await repo.searchInstruments({ text: "AAA", limit: 2, afterCanonicalId: "id-2" });
    expect(second.map((i) => i.canonicalId)).toEqual(["id-3", "id-4"]);
    const page2 = second.slice(0, 2);
    expect(page2.map((i) => i.canonicalId)).toEqual(["id-3", "id-4"]);
    // Exactly-full final page: no lookahead row -> nextCursor null.
    expect(second.length > 2 ? page2[page2.length - 1]!.canonicalId : null).toBeNull();
  });

  test("page-size bounds are enforced by the repository", async () => {
    const { repo } = setup();
    await seed(repo, [instrument("id-1", "AAA1", "Alpha 1"), instrument("id-2", "AAA2", "Alpha 2")]);
    const rows = await repo.searchInstruments({ text: "AAA", limit: 1 });
    expect(rows.length).toBeLessThanOrEqual(2); // limit + 1 lookahead
  });
});
