import { describe, expect, it } from "vitest";
import {
  computeBookmarksScore,
  parseBookmarksWidget,
} from "./bookmarks";

function widgetHtml(body: string) {
  return `<html><body>${body}</body></html>`;
}

describe("computeBookmarksScore", () => {
  it("weights rave/positive/mixed/pan as 100/80/60/30", () => {
    const score = computeBookmarksScore({
      rave: 20,
      positive: 7,
      mixed: 1,
      pan: 0,
    });
    expect(score).toBe(93.57);
  });
});

describe("parseBookmarksWidget", () => {
  it("parses grade, counts, and weighted score from review blocks", () => {
    const html = widgetHtml(`
      <div class="rating-summary">What The Reviewers Say Rave Based on 3 reviews</div>
      <div class="review">
        <div class="review-meta"><span class="stat_total rave">Rave</span></div>
      </div>
      <div class="review">
        <div class="review-meta"><span class="stat_total positive">Positive</span></div>
      </div>
      <div class="review">
        <div class="review-meta"><span class="stat_total mixed">Mixed</span></div>
      </div>
    `);

    expect(parseBookmarksWidget(html)).toEqual({
      grade: "Rave",
      reviewCount: 3,
      counts: { rave: 1, positive: 1, mixed: 1, pan: 0 },
      bookmarksScore: 80,
    });
  });

  it("returns empty counts when there are no reviews", () => {
    const html = widgetHtml(`<div class="rating-summary">No reviews yet</div>`);
    expect(parseBookmarksWidget(html)).toEqual({
      grade: null,
      reviewCount: null,
      counts: { rave: 0, positive: 0, mixed: 0, pan: 0 },
      bookmarksScore: null,
    });
  });
});
