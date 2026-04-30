import { randomBytes } from "crypto";
import { basename, extname } from "path";

export function generateRunId(specPath: string): string {
  const slug = basename(specPath, extname(specPath))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const ts = Date.now();
  const hex = randomBytes(2).toString("hex");
  return `${slug}-${ts}-${hex}`;
}
