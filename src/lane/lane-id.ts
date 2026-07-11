/**
 * Lane id validation (orca/v1, pinned decision 8).
 *
 * Every verb that takes a lane id must validate it against LANE_ID_PATTERN
 * BEFORE any filesystem path is constructed from it; a failure is a usage
 * error (exit 2). This kills path traversal via crafted ids. The LaneStore
 * additionally refuses invalid ids defensively in its own path construction.
 */
export const LANE_ID_PATTERN = /^lane_[0-9a-f]{8}$/;

export function isValidLaneId(laneId: string): boolean {
  return LANE_ID_PATTERN.test(laneId);
}

/** Thrown when a lane id does not match LANE_ID_PATTERN. Maps to usage_error. */
export class InvalidLaneIdError extends Error {
  readonly code = "usage_error";
  readonly laneId: string;

  constructor(laneId: string) {
    super(`Invalid lane id: ${JSON.stringify(laneId)} (expected ${LANE_ID_PATTERN.source})`);
    this.name = "InvalidLaneIdError";
    this.laneId = laneId;
  }
}

/** Asserts the id matches LANE_ID_PATTERN, throwing InvalidLaneIdError otherwise. */
export function assertValidLaneId(laneId: string): void {
  if (!isValidLaneId(laneId)) {
    throw new InvalidLaneIdError(laneId);
  }
}
