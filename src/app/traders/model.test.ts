import { describe, expect, it } from "vitest";
import type { FeedEvent } from "@/services/personas/types";
import { baselineY, colorVarFor, filterFeed, sparklinePoints, weightsText } from "./model";

describe("traders model", () => {
  it("keeps a persona's color by roster position, not by rank", () => {
    const ids = ["trend", "sniper", "coin"];
    expect(colorVarFor(ids, "coin")).toBe("--p-3");
    expect(colorVarFor(["coin", ...ids.slice(0, 2)], "trend")).toBe("--p-2");
  });

  it("describes portfolio weights including the cash share", () => {
    expect(weightsText({ "SOL/USDT": 0.5, "BNB/USDT": 0.5 })).toBe("SOL 50%, BNB 50%");
    expect(weightsText({ "SOL/USDT": 0.5 })).toBe("SOL 50%, $ 50%");
    expect(weightsText({})).toBe("всё в долларах");
  });

  it("scales the sparkline into the box and places the start level", () => {
    const curve: [number, number][] = [[0, 100], [1, 110], [2, 90]];
    expect(sparklinePoints(curve, 100, 20, 0)).toBe("0.0,10.0 50.0,0.0 100.0,20.0");
    expect(baselineY(curve, 100, 20, 0)).toBe(10);
    expect(baselineY(curve, 200, 20, 0)).toBeNull();
  });

  it("filters the feed by persona", () => {
    const feed: FeedEvent[] = [
      { t: 2, personaId: "a", kind: "rebalance", weights: {}, note: "", mode: "live" },
      { t: 1, personaId: "b", kind: "rebalance", weights: {}, note: "", mode: "live" },
    ];
    expect(filterFeed(feed, "all")).toHaveLength(2);
    expect(filterFeed(feed, "b").map((e) => e.t)).toEqual([1]);
  });
});
