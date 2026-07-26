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
});

describe("rankCards", () => {
  it("ranks by impact weighted by confidence", () => {
    const ranked = rankCards(
      parseCards([
        card(1, 0.5, 1_000, 2), // 2 * 1000 * 0.5  = 1000
        card(2, 0.9, 1_000, 5), // 5 * 1000 * 0.9  = 4500
        card(3, 0.9, 100, 1), //   1 * 100  * 0.9  = 90
      ] as never)
    );
    expect(ranked.map((c) => c.id)).toEqual([2, 1, 3]);
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
