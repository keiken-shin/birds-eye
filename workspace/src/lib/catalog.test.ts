import { describe, expect, it } from "vitest";
import { destinationFor, parseCards, rankCards, sourceLabel } from "./catalog";

const card = (id: number, confidence: number, bytes: number, count: number) => ({
  id,
  kind: "relocation",
  status: "pending",
  confidence,
  potential_bytes_unlocked: bytes,
  created_at: 0,
  resolved_at: null,
  payload: JSON.stringify({
    fingerprint: `fp${id}`,
    member_hash: `mh${id}`,
    destination: "D:\\Docs",
    destination_exists: true,
    source: "learned",
    reason: "because",
    zone: "C:\\Inbox",
    kind: "document",
    member_count: count,
    total_bytes: bytes,
    members: [],
  }),
});

describe("parseCards", () => {
  it("parses the payload of each row", () => {
    const parsed = parseCards([card(1, 0.9, 100, 2)] as never);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].payload.destination).toBe("D:\\Docs");
    expect(parsed[0].payload.member_count).toBe(2);
  });

  it("drops a row whose payload is not valid JSON rather than throwing", () => {
    const broken = { ...card(1, 0.9, 100, 2), payload: "{not json" };
    expect(parseCards([broken] as never)).toEqual([]);
  });

  it("drops a row whose payload parses to null, a number, or an array", () => {
    const base = card(1, 0.9, 100, 2);
    const asNull = { ...base, payload: "null" };
    const asNumber = { ...base, payload: "42" };
    const asArray = { ...base, payload: "[]" };
    expect(parseCards([asNull, asNumber, asArray] as never)).toEqual([]);
  });

  it("still returns the good cards when a null-payload row rides along", () => {
    const good1 = card(1, 0.5, 1_000, 2);
    const good2 = card(2, 0.9, 1_000, 5);
    const badNull = { ...card(3, 0.9, 100, 1), payload: "null" };
    const parsed = parseCards([good1, badNull, good2] as never);
    expect(parsed.map((c) => c.id)).toEqual([1, 2]);
    // and ranking the survivors must not throw (this is what a `null` payload
    // used to crash: score() reading `.member_count` off of `null`).
    expect(() => rankCards(parsed)).not.toThrow();
    expect(rankCards(parsed).map((c) => c.id)).toEqual([2, 1]);
  });
});

describe("rankCards", () => {
  it("ranks by impact weighted by confidence", () => {
    // score = member_count * total_bytes * confidence
    // card 1: 1 * 10 * 0.5 =  5
    // card 2: 2 * 20 * 0.7 = 28
    // card 3: 3 * 30 * 0.1 =  9
    // correct order (highest score first): 2, 3, 1
    //
    // Card 3 has the highest count but the lowest confidence, so any formula
    // that drops one factor disagrees with the correct order:
    //   count only:         3:3   > 2:2   > 1:1   -> [3, 2, 1]
    //   count * bytes:      3:90  > 2:40  > 1:10  -> [3, 2, 1]
    //   count * confidence: 2:1.4 > 1:0.5 > 3:0.3 -> [2, 1, 3]
    //   bytes * confidence: 2:14  > 1:5   > 3:3   -> [2, 1, 3]
    const ranked = rankCards(
      parseCards([
        card(1, 0.5, 10, 1),
        card(2, 0.7, 20, 2),
        card(3, 0.1, 30, 3),
      ] as never)
    );
    expect(ranked.map((c) => c.id)).toEqual([2, 3, 1]);
  });

  it("does not mutate its input", () => {
    const cards = parseCards([card(1, 0.5, 10, 1), card(2, 0.9, 100, 9)] as never);
    const order = cards.map((c) => c.id);
    rankCards(cards);
    expect(cards.map((c) => c.id)).toEqual(order);
  });
});

describe("sourceLabel", () => {
  it("names each destination source", () => {
    expect(sourceLabel("rule")).toBe("Your rule");
    expect(sourceLabel("learned")).toBe("Learned");
    expect(sourceLabel("template")).toBe("Convention");
    expect(sourceLabel("weird")).toBe("Suggested");
  });
});

describe("destinationFor", () => {
  it("joins with the separator the destination already uses", () => {
    expect(destinationFor("D:\\Docs", "a.pdf")).toBe("D:\\Docs\\a.pdf");
    expect(destinationFor("/home/a/docs", "a.pdf")).toBe("/home/a/docs/a.pdf");
  });

  it("does not double a trailing separator", () => {
    expect(destinationFor("D:\\Docs\\", "a.pdf")).toBe("D:\\Docs\\a.pdf");
  });
});
