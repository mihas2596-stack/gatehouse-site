// @vitest-environment node
// N30: the report-photos bucket must be created by a migration, not by
// hand in the Supabase dashboard. There is no smoke test in this repo
// (no "smoke" anywhere in src/api/scripts/tests), so the check lives
// here: the migration file must exist, create exactly this bucket,
// privately, and be a no-op when the bucket already exists.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "fs";
import { resolve } from "path";

const MIGRATION = "supabase/migrations/20261109_report_photos_bucket.sql";
const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");

describe("N30 report-photos bucket migration", () => {
  it("creates the private report-photos bucket, idempotently", () => {
    expect(existsSync(resolve(__dirname, "../..", MIGRATION))).toBe(true);
    const sql = read(MIGRATION);
    expect(sql).toMatch(/insert\s+into\s+storage\.buckets/i);
    expect(sql).toContain("'report-photos'");
    expect(sql).toMatch(/values\s*\(\s*'report-photos'\s*,\s*'report-photos'\s*,\s*false\s*\)/i);
    expect(sql).toMatch(/on\s+conflict\s*\(\s*id\s*\)\s*do\s+nothing/i);
  });

  it("is the only migration that creates the bucket", () => {
    const dir = resolve(__dirname, "../../supabase/migrations");
    const creators = readdirSync(dir).filter((f) => /storage\.buckets/i.test(read(`supabase/migrations/${f}`)));
    expect(creators).toEqual(["20261109_report_photos_bucket.sql"]);
  });
});
