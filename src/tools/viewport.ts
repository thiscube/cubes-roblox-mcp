import { type ToolEntry, dispatchTool } from "../registry.js";

/**
 * Viewport capture and spatial queries.
 *
 * One file per Category value — the registry's own taxonomy names the file,
 * so there is never a question of where a new tool goes (A6).
 */

export const VIEWPORT_TOOLS: ToolEntry[] = [
  dispatchTool(
    {
      name: "viewport_capture",
      category: "viewport",
      subcategories: ["vision", "scene"],
      keywords: ["viewport", "scene", "camera", "visible", "see", "look", "observe"],
      readOnly: true,
      description:
        "Structured scene grounding: camera CFrame + FOV + on-screen BaseParts with projected 2D bboxes and distances. Sorted closest-first. Works in edit and play modes.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max parts (default 20)." },
        },
      },
    },
    "viewport_capture",
  ),
  dispatchTool(
    {
      name: "raycast",
      category: "viewport",
      subcategories: ["vision", "probe", "physics"],
      keywords: ["raycast", "probe", "hit", "trace", "ray", "intersect", "what is there"],
      readOnly: true,
      description:
        "Cast a ray and return the first hit: instance, position, normal, material, distance. Use fromCamera=true to cast from the camera (forward direction if no direction given). length defaults to direction.Magnitude or 500.",
      inputSchema: {
        type: "object",
        properties: {
          origin: { type: "array", items: { type: "number" }, description: "World [x,y,z] start. Required unless fromCamera." },
          direction: { type: "array", items: { type: "number" }, description: "World [x,y,z] direction (will be normalized)." },
          length: { type: "number", description: "Max ray length (default direction's magnitude, or 500)." },
          fromCamera: { type: "boolean", description: "Start from camera; uses camera LookVector if direction omitted." },
          ignore: {
            type: "array",
            items: { type: "string" },
            description: "Refs/paths to exclude from the cast.",
          },
        },
      },
    },
    "raycast",
  ),
];
