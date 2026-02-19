import path from "node:path";

import type { RunId } from "../types/index.js";

function slugifySpecFileName(specPath: string): string {
  const fileName = path.basename(specPath, path.extname(specPath));
  const slug = fileName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return slug || "spec";
}

export function generateRunId(specPath: string): RunId {
  const slug = slugifySpecFileName(specPath);
  const timestamp = Date.now();
  const hex = Math.floor(Math.random() * 0xffff + 1)
    .toString(16)
    .padStart(4, "0");

  return `${slug}-${timestamp}-${hex}`;
}
