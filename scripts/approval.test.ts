import { expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { approvalPlan, renderApproval } from "./approval";
import { approvedJobs, digestPlan, type Plan } from "./media";

function example(): Plan {
  const sourceRoot = join(tmpdir(), "incoming"), destinationRoot = join(tmpdir(), "library");
  return {
    version: 2, jobs: 1, sourceRoot, destinationRoot, createdAt: "2026-11-08T00:00:00Z",
    catalog: { show: "Example", season: 1, reference: "https://example.org/episodes", seasonFolders: false, episodes: [{ episode: 1, title: "Pilot" }, { episode: 2, title: "Second" }] },
    items: [{
      source: join(sourceRoot, "Example.S01E01.mp4"), target: join(destinationRoot, "Example - S01E01 - Pilot.mp4"),
      title: "Example - S01E01 - Pilot", sha256: "a".repeat(64), selected: [0, 1],
      probe: { streams: [{ index: 0, codec_type: "video", codec_name: "h264" }, { index: 1, codec_type: "audio", codec_name: "aac", tags: { language: "eng" } }, { index: 2, codec_type: "audio", codec_name: "aac", tags: { language: "deu" } }], format: {} },
    }], missing: ["S01E02"], existing: [], ignored: [],
  };
}
const details = { planPath: join(tmpdir(), "plan.json"), jobs: 1, requiredFreeBytes: 1024 ** 3, availableFreeBytes: 2 * 1024 ** 3, generatedInMs: 1250 };

test("approval report is generated from typed execution data and warns about every gap", () => {
  const plan = example(), review = approvalPlan(plan, details), report = renderApproval(review);
  expect(review.planSha256).toBe(digestPlan(plan));
  expect(review.outputs[0].kept).toEqual(["#0 video h264", "#1 audio aac eng"]);
  expect(review.outputs[0].dropped).toEqual(["#2 audio aac deu"]);
  expect(report).toContain("WARNING: missing episodes S01E02");
  expect(report).toContain("Example - S01E01 - Pilot.mp4");
  expect(report).toContain("1.00 GiB required; 2.00 GiB available");
  expect(report).toContain("1.25 seconds");
  expect(report).toContain("Originals stay in place");
  expect(report).toContain("separate confirmation");
});

test("plan identity ignores JSON key order but detects changed instructions", () => {
  const plan = example();
  const reordered = Object.fromEntries(Object.entries(plan).reverse()) as Plan;
  expect(digestPlan(reordered)).toBe(digestPlan(plan));
  expect(digestPlan({ ...plan, missing: [] })).not.toBe(digestPlan(plan));
});

test("approved concurrency is bound to the plan and can only decrease", () => {
  const plan = example();
  expect(approvedJobs(plan)).toBe(1);
  expect(() => approvedJobs(plan, 2)).toThrow("approved concurrency");
  expect(digestPlan({ ...plan, jobs: 2 })).not.toBe(digestPlan(plan));
});

test("filenames cannot inject HTML or extra approval table rows", () => {
  const plan = example();
  plan.items[0].source = join(plan.sourceRoot, "<b>file|name\nnext.mp4");
  const report = renderApproval(approvalPlan(plan, details));
  expect(report).toContain("&lt;b&gt;file\\|name next.mp4");
  expect(report).not.toContain("<b>");
});
